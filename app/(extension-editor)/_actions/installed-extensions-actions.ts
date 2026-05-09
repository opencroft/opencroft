'use server';

import { execFile as execFileCb } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildExtension } from '@/app/(extension-runtime)/_server/compiler';
import { flushCache } from '@/app/(extension-runtime)/_server/loader';
import { extDir, installedExtRoot } from '@/app/(extension-runtime)/_server/paths';
import { type ExtensionManifest } from '@/app/(extension-runtime)/_types';
import { getSecretValue } from '@/app/(secrets-store)/secrets-store/actions';

const execFile = promisify(execFileCb);

const MANIFEST_FILE = 'extension.json';
const SIDECAR_FILE = 'installed.json';
const GIT_BUFFER = 64 * 1024 * 1024;

export interface InstalledSource {
  type: 'git';
  url: string;
  name: string;
}

export interface InstallAuth {
  type: 'secret';
  storeId: string;
  usernameKey?: string;
  tokenKey?: string;
}

interface ResolvedAuth {
  username: string;
  token: string;
}

export interface InstalledSidecar {
  source: InstalledSource;
  auth?: InstallAuth;
  ref: string;
  installedAt: number;
}

export interface InstalledExtensionRecord {
  id: string;
  slug: string;
  manifest: ExtensionManifest;
  sidecar: InstalledSidecar;
  files: Record<string, string>;
  updatedAt: number;
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  hasUpdate: boolean;
  availableTags: string[];
}

interface ParsedRepo {
  url: string;
  owner: string;
  repo: string;
}

interface ResolvedRef {
  ref: string;
  kind: 'tag' | 'head';
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'extension';
}

function parseRepoUrl(input: string): ParsedRepo {
  const trimmed = input.trim().replace(/\.git\/?$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    const [owner, repo] = trimmed.split('/');
    return { url: `https://github.com/${owner}/${repo}.git`, owner, repo };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Invalid repository URL: ${input}`);
  }
  const segs = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
  if (segs.length < 2) {
    throw new Error(`Cannot extract owner and repo from URL: ${input}`);
  }
  const owner = segs[0];
  const repo = segs[segs.length - 1];
  const cleaned = parsed.pathname.replace(/\/+$/, '');
  return {
    url: `${parsed.origin}${cleaned}.git`,
    owner,
    repo,
  };
}

function semverCmp(a: string, b: string): number {
  const norm = (s: string) => s.replace(/^v/i, '').split(/[.+-]/).map((p) => Number.parseInt(p, 10) || 0);
  const ax = norm(a);
  const bx = norm(b);
  const max = Math.max(ax.length, bx.length);
  for (let i = 0; i < max; i += 1) {
    const av = ax[i] ?? 0;
    const bv = bx[i] ?? 0;
    if (av !== bv) {
      return av - bv;
    }
  }
  return 0;
}

async function resolveAuth(auth?: InstallAuth): Promise<ResolvedAuth | null> {
  if (!auth) {
    return null;
  }
  const tokenKey = auth.tokenKey ?? 'token';
  const usernameKey = auth.usernameKey ?? 'username';
  const [token, username] = await Promise.all([
    getSecretValue(auth.storeId, tokenKey),
    getSecretValue(auth.storeId, usernameKey),
  ]);
  if (!token) {
    throw new Error(`Secret ${auth.storeId}/${tokenKey} not found or empty`);
  }
  return { username: username ?? 'x-access-token', token };
}

function applyAuthToUrl(url: string, creds: ResolvedAuth | null): string {
  if (!creds) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.username = encodeURIComponent(creds.username);
    parsed.password = encodeURIComponent(creds.token);
    return parsed.toString();
  } catch {
    return url;
  }
}

async function listRemoteTags(url: string, creds: ResolvedAuth | null): Promise<string[]> {
  const authedUrl = applyAuthToUrl(url, creds);
  const { stdout } = await execFile('git', ['ls-remote', '--tags', '--refs', authedUrl], { maxBuffer: 4 * 1024 * 1024 });
  const tags: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const ref = trimmed.split('\t')[1];
    if (!ref) {
      continue;
    }
    const tag = ref.replace(/^refs\/tags\//, '');
    if (tag) {
      tags.push(tag);
    }
  }
  return tags;
}

async function resolveInstallRef(url: string, creds: ResolvedAuth | null, requested?: string): Promise<ResolvedRef> {
  if (requested) {
    return { ref: requested, kind: 'tag' };
  }
  const tags = await listRemoteTags(url, creds);
  if (tags.length === 0) {
    return { ref: 'HEAD', kind: 'head' };
  }
  tags.sort(semverCmp);
  return { ref: tags[tags.length - 1], kind: 'tag' };
}

async function installNodeDeps(dir: string): Promise<void> {
  try {
    await fs.access(path.join(dir, 'package.json'));
  } catch {
    return;
  }
  try {
    await execFile('npm', ['install', '--no-audit', '--no-fund', '--no-progress'], {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
      shell: true,
    });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const text = e.stderr || e.stdout || e.message || String(err);
    const tail = text.split('\n').slice(-15).join('\n');
    throw new Error(`npm install failed in ${dir}:\n${tail}`);
  }
}

async function gitClone(
  url: string,
  refKind: 'tag' | 'head',
  ref: string,
  dest: string,
  creds: ResolvedAuth | null,
): Promise<string> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  const authedUrl = applyAuthToUrl(url, creds);
  const args = refKind === 'tag'
    ? ['clone', '--depth', '1', '--branch', ref, '--single-branch', authedUrl, dest]
    : ['clone', '--depth', '1', authedUrl, dest];
  await execFile('git', args, { maxBuffer: GIT_BUFFER });
  const { stdout } = await execFile('git', ['-C', dest, 'rev-parse', 'HEAD'], {});
  const sha = stdout.trim().slice(0, 7);
  await fs.rm(path.join(dest, '.git'), { recursive: true, force: true });
  return sha;
}

async function rewriteManifestId(dir: string, scopedId: string): Promise<ExtensionManifest> {
  const file = path.join(dir, MANIFEST_FILE);
  const raw = await fs.readFile(file, 'utf-8');
  const manifest = JSON.parse(raw) as ExtensionManifest;
  manifest.id = scopedId;
  if (!manifest.version) {
    manifest.version = '0.0.0';
  }
  await fs.writeFile(file, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}

async function writeSidecar(dir: string, sidecar: InstalledSidecar): Promise<void> {
  await fs.writeFile(path.join(dir, SIDECAR_FILE), JSON.stringify(sidecar, null, 2) + '\n', 'utf-8');
}

async function readSidecar(dir: string): Promise<InstalledSidecar | null> {
  try {
    const raw = await fs.readFile(path.join(dir, SIDECAR_FILE), 'utf-8');
    return JSON.parse(raw) as InstalledSidecar;
  } catch {
    return null;
  }
}

async function dirMtime(dir: string): Promise<number> {
  try {
    const stat = await fs.stat(dir);
    return stat.mtimeMs;
  } catch {
    return 0;
  }
}

async function listFilesRecursive(dir: string, base: string = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of sorted) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['dist', 'node_modules', '.git'].includes(entry.name)) {
        continue;
      }
      Object.assign(out, await listFilesRecursive(full, rel));
      continue;
    }
    try {
      out[rel] = await fs.readFile(full, 'utf-8');
    } catch {
      out[rel] = '';
    }
  }
  return out;
}

async function readRecord(slug: string): Promise<InstalledExtensionRecord | null> {
  const dir = path.join(installedExtRoot(), slug);
  const sidecar = await readSidecar(dir);
  if (!sidecar) {
    return null;
  }
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf-8');
  } catch {
    return null;
  }
  const manifest = JSON.parse(manifestRaw) as ExtensionManifest;
  return {
    id: `installed/${slug}`,
    slug,
    manifest,
    sidecar,
    files: await listFilesRecursive(dir),
    updatedAt: await dirMtime(dir),
  };
}

async function pickFreshSlug(owner: string, repo: string): Promise<string> {
  const root = installedExtRoot();
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch {
    entries = [];
  }
  const taken = new Set(entries);
  const base = slugify(`${owner}-${repo}`);
  if (!taken.has(base)) {
    return base;
  }
  let i = 2;
  while (taken.has(`${base}-${i}`)) {
    i += 1;
  }
  return `${base}-${i}`;
}

async function performInstall(
  slug: string,
  parsed: ParsedRepo,
  auth: InstallAuth | undefined,
  refSpec?: string,
): Promise<InstalledExtensionRecord> {
  const id = `installed/${slug}`;
  const dir = path.join(installedExtRoot(), slug);
  const creds = await resolveAuth(auth);

  const resolved = refSpec
    ? { ref: refSpec, kind: 'tag' as const }
    : await resolveInstallRef(parsed.url, creds);

  const sha = await gitClone(parsed.url, resolved.kind, resolved.ref, dir, creds);
  const finalRef = resolved.kind === 'tag' ? resolved.ref : `HEAD@${sha}`;

  const manifest = await rewriteManifestId(dir, id);
  await writeSidecar(dir, {
    source: { type: 'git', url: parsed.url, name: `${parsed.owner}/${parsed.repo}` },
    auth,
    ref: finalRef,
    installedAt: Date.now(),
  });

  await installNodeDeps(dir);

  flushCache(id);
  const result = await buildExtension(id, manifest);
  if (!result.success) {
    const summary = result.errors.map((e) => `${e.file}:${e.line ?? '?'}  ${e.message}`).join('\n');
    throw new Error(`Extension built with errors:\n${summary}`);
  }

  const record = await readRecord(slug);
  if (!record) {
    throw new Error(`Failed to read installed extension after install: ${id}`);
  }
  return record;
}

export async function installExtensionFromUrl(input: {
  url: string;
  ref?: string;
  auth?: InstallAuth;
}): Promise<InstalledExtensionRecord> {
  const parsed = parseRepoUrl(input.url);
  const slug = await pickFreshSlug(parsed.owner, parsed.repo);
  return performInstall(slug, parsed, input.auth, input.ref);
}

export async function listInstalledExtensions(): Promise<InstalledExtensionRecord[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(installedExtRoot());
  } catch {
    return [];
  }
  const records: InstalledExtensionRecord[] = [];
  for (const slug of entries) {
    const record = await readRecord(slug);
    if (record) {
      records.push(record);
    }
  }
  return records;
}

function slugFromInstalledId(extensionId: string): string {
  const [scope, slug] = extensionId.split('/');
  if (scope !== 'installed' || !slug) {
    throw new Error(`Expected installed/<slug>, got "${extensionId}"`);
  }
  return slug;
}

export async function updateInstalledExtension(extensionId: string, ref?: string): Promise<InstalledExtensionRecord> {
  const slug = slugFromInstalledId(extensionId);
  const sidecar = await readSidecar(extDir(extensionId));
  if (!sidecar) {
    throw new Error(`Not an installed extension: ${extensionId}`);
  }
  const parsed = parseRepoUrl(sidecar.source.url);
  return performInstall(slug, parsed, sidecar.auth, ref);
}

export async function uninstallExtension(extensionId: string): Promise<void> {
  const slug = slugFromInstalledId(extensionId);
  const dir = path.join(installedExtRoot(), slug);
  await fs.rm(dir, { recursive: true, force: true });
  flushCache(extensionId);
}

export async function checkInstalledForUpdates(extensionId: string): Promise<UpdateCheck> {
  const sidecar = await readSidecar(extDir(extensionId));
  if (!sidecar) {
    throw new Error(`Not an installed extension: ${extensionId}`);
  }
  const creds = await resolveAuth(sidecar.auth);
  const tags = await listRemoteTags(sidecar.source.url, creds);
  if (tags.length === 0) {
    return { current: sidecar.ref, latest: null, hasUpdate: false, availableTags: [] };
  }
  tags.sort(semverCmp);
  const sortedDesc = [...tags].reverse();
  const latest = sortedDesc[0];
  return {
    current: sidecar.ref,
    latest,
    hasUpdate: sidecar.ref !== latest,
    availableTags: sortedDesc,
  };
}
