import { execFile as execFileCb } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { getSecretValue } from '@/app/(secrets-store)/secrets-store/actions';

const execFile = promisify(execFileCb);

// ── Types ──────────────────────────────────────────────────────────

export interface RegistryExtension {
  id: string;
  name: string;
  description?: string;
  repository: string;
  author?: string;
  homepage?: string;
  tags?: string[];
}

export interface RegistryManifest {
  extensions: RegistryExtension[];
}

export interface RegistrySource {
  /** Display name for the registry */
  name: string;
  /** Git URL or owner/repo shorthand */
  url: string;
  /** Secret store ID for auth credentials */
  authStoreId?: string;
  /** Inline username from env (e.g. user:token@owner/repo) */
  username?: string;
  /** Inline token from env */
  token?: string;
  /** Optional ref (branch/tag), defaults to HEAD/main */
  ref?: string;
}

export interface ResolvedRegistry {
  source: RegistrySource;
  manifest: RegistryManifest;
  fetchedAt: number;
}

// ── Config ──────────────────────────────────────────────────────────

const DEFAULT_REGISTRY = 'opencroft/registry';

interface ParsedRegistryEntry {
  name: string;
  url: string;
  username?: string;
  token?: string;
  authStoreId?: string;
}

/**
 * Parse a single EXTENSION_REGISTRIES entry.
 * Supports inline credentials:
 *   token@owner/repo
 *   user:token@owner/repo
 *   https://user:token@domain.com/org/repo
 *   store:nodeId@owner/repo
 */
function parseRegistryEntry(entry: string): ParsedRegistryEntry {
  // Check for secret store ref: store:nodeId@owner/repo
  const storeMatch = entry.match(/^store:([\w-]+)@(.+)$/);
  if (storeMatch) {
    const [, storeId, repo] = storeMatch;
    return { name: repo, url: repo, authStoreId: storeId };
  }

  // Check for shorthand with credentials: [user:]token@owner/repo
  const shorthandMatch = entry.match(/^(?:(\w[\w.-]*)?:)?(\S+?)@([\w.-]+\/[\w.-]+)$/);
  if (shorthandMatch) {
    const [, user, token, repo] = shorthandMatch;
    return {
      name: repo,
      url: repo,
      username: user || 'x-access-token',
      token,
    };
  }

  // Check for full URL with credentials
  try {
    const parsed = new URL(entry);
    if (parsed.username || parsed.password) {
      // Detect store:nodeId pattern embedded in URL: https://store:nodeId@host/...
      if (parsed.username === 'store') {
        return {
          name: parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, ''),
          url: `${parsed.protocol}//${parsed.host}${parsed.pathname}`,
          authStoreId: decodeURIComponent(parsed.password),
        };
      }
      // Regular inline credentials
      const url = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      return {
        name: parsed.pathname.replace(/^\/+/, '').replace(/\.git$/, '').replace(/\/+$/, ''),
        url,
        username: decodeURIComponent(parsed.username) || undefined,
        token: decodeURIComponent(parsed.password) || undefined,
      };
    }
  } catch {
    // Not a valid URL, treat as shorthand without auth
  }

  return { name: entry, url: entry };
}

function parseRegistriesEnv(): RegistrySource[] {
  const raw = process.env.EXTENSION_REGISTRIES?.trim();
  if (!raw) {
    return [{ name: 'OpenCroft', url: DEFAULT_REGISTRY }];
  }

  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  // Always include the default registry first
  const sources: RegistrySource[] = [{ name: 'OpenCroft', url: DEFAULT_REGISTRY }];

  for (const entry of entries) {
    const parsed = parseRegistryEntry(entry);
    // Skip if it's the default
    if (parsed.url === DEFAULT_REGISTRY || parsed.url === `https://github.com/${DEFAULT_REGISTRY}.git`) {
      continue;
    }
    sources.push({
      name: parsed.name,
      url: parsed.url,
      username: parsed.username,
      token: parsed.token,
      authStoreId: parsed.authStoreId,
    });
  }

  return sources;
}

// ── Auth ────────────────────────────────────────────────────────────

async function resolveAuth(source: RegistrySource): Promise<{ username: string; token: string } | null> {
  // Inline credentials from env take priority
  if (source.token) {
    return { username: source.username ?? 'x-access-token', token: source.token };
  }
  // Fallback to Secrets Store
  if (!source.authStoreId) {
    return null;
  }
  const [token, username] = await Promise.all([
    getSecretValue(source.authStoreId, 'token'),
    getSecretValue(source.authStoreId, 'username'),
  ]);
  if (!token) {
    return null;
  }
  return { username: username ?? 'x-access-token', token };
}

function applyAuthToUrl(url: string, creds: { username: string; token: string } | null): string {
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

// ── URL Resolution ──────────────────────────────────────────────────

function resolveGitUrl(input: string): string {
  const trimmed = input.trim().replace(/\.git\/?$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  if (!trimmed.endsWith('.git')) {
    return `${trimmed}.git`;
  }
  return trimmed;
}

function rawFileUrl(gitUrl: string, filePath: string, ref?: string): string {
  const clean = gitUrl.replace(/\.git$/, '');
  const refBranch = ref ?? 'main';

  if (clean.includes('github.com')) {
    const parts = clean.replace('https://github.com/', '');
    return `https://raw.githubusercontent.com/${parts}/${refBranch}/${filePath}`;
  }

  // Generic Forgejo/Gitea
  return `${clean}/raw/branch/${refBranch}/${filePath}`;
}

// ── Registry Cache ──────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CachedRegistry {
  registry: ResolvedRegistry;
  expiresAt: number;
}

declare global {

  var __REGISTRY_CACHE__: Map<string, CachedRegistry> | undefined;
}

function registryCache(): Map<string, CachedRegistry> {
  if (!globalThis.__REGISTRY_CACHE__) {
    globalThis.__REGISTRY_CACHE__ = new Map();
  }
  return globalThis.__REGISTRY_CACHE__;
}

// ── Fetching ────────────────────────────────────────────────────────

async function fetchRegistryManifest(source: RegistrySource): Promise<ResolvedRegistry> {
  const gitUrl = resolveGitUrl(source.url);
  const creds = await resolveAuth(source);

  // Try raw file fetch first (faster, no clone needed)
  const rawUrl = rawFileUrl(gitUrl, 'registry.json', source.ref);

  let manifestJson: string;
  try {
    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };
    if (creds) {
      const basic = Buffer.from(`${creds.username}:${creds.token}`).toString('base64');
      headers['Authorization'] = `Basic ${basic}`;
    }

    const response = await fetch(rawUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    manifestJson = await response.text();
  } catch {
    // Fallback: git clone
    const authedUrl = applyAuthToUrl(gitUrl, creds);
    const tmpDir = path.join(process.cwd(), '.cache', 'registry-tmp', `reg-${Date.now()}`);
    try {
      await fs.mkdir(tmpDir, { recursive: true });
      const cloneArgs = source.ref
        ? ['clone', '--depth', '1', '--branch', source.ref, '--single-branch', authedUrl, tmpDir]
        : ['clone', '--depth', '1', authedUrl, tmpDir];
      await execFile('git', cloneArgs, { maxBuffer: 4 * 1024 * 1024 });
      manifestJson = await fs.readFile(path.join(tmpDir, 'registry.json'), 'utf-8');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const parsed = JSON.parse(manifestJson) as RegistryManifest;
  if (!Array.isArray(parsed.extensions)) {
    throw new Error(`Invalid registry.json: missing "extensions" array`);
  }

  return {
    source,
    manifest: parsed,
    fetchedAt: Date.now(),
  };
}

// ── Public API ──────────────────────────────────────────────────────

export async function getRegistrySources(): Promise<RegistrySource[]> {
  return parseRegistriesEnv();
}

export async function fetchAllRegistries(forceRefresh = false): Promise<ResolvedRegistry[]> {
  const sources = parseRegistriesEnv();
  const cache = registryCache();
  const results: ResolvedRegistry[] = [];

  for (const source of sources) {
    const cacheKey = source.url;
    const cached = cache.get(cacheKey);

    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      results.push(cached.registry);
      continue;
    }

    try {
      const registry = await fetchRegistryManifest(source);
      cache.set(cacheKey, { registry, expiresAt: Date.now() + CACHE_TTL_MS });
      results.push(registry);
    } catch (err) {
      console.error(`[registry] Failed to fetch ${source.url}:`, err);
      // Return stale cache if available
      if (cached) {
        results.push(cached.registry);
      }
    }
  }

  return results;
}

export async function searchRegistries(query?: string): Promise<(RegistryExtension & { registryName: string })[]> {
  const registries = await fetchAllRegistries();
  const all: (RegistryExtension & { registryName: string })[] = [];

  const q = query?.toLowerCase()?.trim();

  for (const reg of registries) {
    for (const ext of reg.manifest.extensions) {
      if (!q) {
        all.push({ ...ext, registryName: reg.source.name });
        continue;
      }
      const searchable = [ext.name, ext.description ?? '', ext.author ?? '', ...(ext.tags ?? [])]
        .join(' ')
        .toLowerCase();
      if (searchable.includes(q)) {
        all.push({ ...ext, registryName: reg.source.name });
      }
    }
  }

  return all;
}

export function clearRegistryCache(): void {
  registryCache().clear();
}

// ── Auto-install (EXTENSIONS env) ───────────────────────────────────

export interface ExtensionSpec {
  /** Full extension identifier, e.g. "opencroft/my-extension" */
  id: string;
  /** Optional version/ref to pin */
  version?: string;
}

/**
 * Parse EXTENSIONS env: "opencroft/extension-a:1.0.0,author/extension-b"
 */
export function parseExtensionsEnv(): ExtensionSpec[] {
  const raw = process.env.EXTENSIONS?.trim();
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, version] = entry.split(':');
      return { id: id.trim(), version: version?.trim() || undefined };
    });
}

/**
 * Resolve extension spec to repository URL using registries.
 * Returns the repository URL if found, or null.
 */
export async function resolveExtensionRepo(
  spec: ExtensionSpec,
): Promise<{ repository: string } | null> {
  const registries = await fetchAllRegistries();
  for (const reg of registries) {
    for (const ext of reg.manifest.extensions) {
      if (ext.id === spec.id) {
        return { repository: ext.repository };
      }
    }
  }
  return null;
}

/**
 * Auto-install extensions listed in EXTENSIONS env at boot.
 * Logs progress and errors, does not throw.
 */
export async function autoInstallExtensions(): Promise<void> {
  const specs = parseExtensionsEnv();
  if (specs.length === 0) {
    return;
  }

  console.log(`[extensions] auto-install: ${specs.length} extension(s) to check`);

  const { listInstalledExtensions } = await import(
    '@/app/(extension-editor)/_actions/installed-extensions-actions'
  );
  const { installExtensionFromUrl } = await import(
    '@/app/(extension-editor)/_actions/installed-extensions-actions'
  );
  const { updateInstalledExtension } = await import(
    '@/app/(extension-editor)/_actions/installed-extensions-actions'
  );

  const installed = await listInstalledExtensions();
  const installedMap = new Map(installed.map((r) => [r.id, r]));

  for (const spec of specs) {
    try {
      // Resolve repo URL from registries
      const resolved = await resolveExtensionRepo(spec);
      if (!resolved) {
        console.error(`[extensions] auto-install: "${spec.id}" not found in any registry`);
        continue;
      }

      const existing = installedMap.get(spec.id);
      if (existing) {
        // Already installed — optionally update
        if (spec.version) {
          console.log(`[extensions] auto-install: updating ${spec.id} to ${spec.version}`);
          await updateInstalledExtension(spec.id, spec.version);
        } else {
          console.log(`[extensions] auto-install: ${spec.id} already installed`);
        }
        continue;
      }

      // Install fresh
      console.log(`[extensions] auto-install: installing ${spec.id}${spec.version ? `@${spec.version}` : ''}`);
      await installExtensionFromUrl({
        url: resolved.repository,
        ref: spec.version,
      });
      console.log(`[extensions] auto-install: ${spec.id} installed successfully`);
    } catch (err) {
      console.error(`[extensions] auto-install: failed to install ${spec.id}:`, err);
    }
  }
}
