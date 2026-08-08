import { execFile as execFileCb } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import { createServerFn } from '@tanstack/react-start'

import { MANIFEST_FILE, rewriteManifestId } from '@/app/_authed/(extension-editor)/_actions/manifest-file'
import { buildExtension } from '@/app/_authed/(extension-runtime)/_server/compiler'
import { runGit, withGitAuth } from '@/app/_authed/(extension-runtime)/_server/git-exec'
import { flushCache } from '@/app/_authed/(extension-runtime)/_server/loader'
// SIDECAR_FILE is named alongside the other generated files, so the check that
// discounts them from "someone is working here" cannot drift from the code that
// writes them.
import { extDir, installedExtRoot, localExtRoot, SIDECAR_FILE } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'
import { getSecretValue } from '@/app/_authed/(secrets-store)/_server/actions'
import { toastStore } from '@/lib/toast-store'

const execFile = promisify(execFileCb)

const GIT_BUFFER = 64 * 1024 * 1024

export interface InstalledSource {
  type: 'git'
  url: string
  name: string
}

export interface InstallAuth {
  type: 'secret'
  storeId: string
  usernameKey?: string
  tokenKey?: string
}

interface ResolvedAuth {
  username: string
  token: string
}

export interface InstalledSidecar {
  source: InstalledSource
  auth?: InstallAuth
  ref: string
  installedAt: number
}

export interface InstalledExtensionRecord {
  id: string
  slug: string
  manifest: ExtensionManifest
  sidecar: InstalledSidecar
  files: Record<string, string>
  updatedAt: number
}

export interface UpdateCheck {
  current: string
  latest: string | null
  hasUpdate: boolean
  availableTags: string[]
}

interface ParsedRepo {
  url: string
  owner: string
  repo: string
}

interface ResolvedRef {
  ref: string
  kind: 'tag' | 'head'
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'extension'
}

function parseRepoUrl(input: string): ParsedRepo {
  const trimmed = input.trim().replace(/\.git\/?$/, '')
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) {
    const [owner, repo] = trimmed.split('/')
    return { url: `https://github.com/${owner}/${repo}.git`, owner, repo }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error(`Invalid repository URL: ${input}`)
  }
  const segs = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (segs.length < 2) {
    throw new Error(`Cannot extract owner and repo from URL: ${input}`)
  }
  const owner = segs[0]
  const repo = segs[segs.length - 1]
  const cleaned = parsed.pathname.replace(/\/+$/, '')
  return {
    url: `${parsed.origin}${cleaned}.git`,
    owner,
    repo,
  }
}

function semverCmp(a: string, b: string): number {
  const norm = (s: string) =>
    s
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((p) => Number.parseInt(p, 10) || 0)
  const ax = norm(a)
  const bx = norm(b)
  const max = Math.max(ax.length, bx.length)
  for (let i = 0; i < max; i += 1) {
    const av = ax[i] ?? 0
    const bv = bx[i] ?? 0
    if (av !== bv) {
      return av - bv
    }
  }
  return 0
}

async function resolveAuth(auth?: InstallAuth): Promise<ResolvedAuth | null> {
  if (!auth) {
    return null
  }
  const tokenKey = auth.tokenKey ?? 'token'
  const usernameKey = auth.usernameKey ?? 'username'
  const [token, username] = await Promise.all([
    getSecretValue({ data: { storeId: auth.storeId, key: tokenKey } }),
    getSecretValue({ data: { storeId: auth.storeId, key: usernameKey } }),
  ])
  if (!token) {
    throw new Error(`Secret ${auth.storeId}/${tokenKey} not found or empty`)
  }
  return { username: username ?? 'x-access-token', token }
}

async function listRemoteTags(url: string, creds: ResolvedAuth | null): Promise<string[]> {
  const { url: authedUrl, env, cleanup } = await withGitAuth(url, creds)
  let stdout: string
  try {
    ;({ stdout } = await runGit(['ls-remote', '--tags', '--refs', authedUrl], { maxBuffer: 4 * 1024 * 1024, env }))
  } finally {
    await cleanup()
  }
  const tags: string[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      continue
    }
    const ref = trimmed.split('\t')[1]
    if (!ref) {
      continue
    }
    const tag = ref.replace(/^refs\/tags\//, '')
    if (tag) {
      tags.push(tag)
    }
  }
  return tags
}

async function resolveInstallRef(url: string, creds: ResolvedAuth | null, requested?: string): Promise<ResolvedRef> {
  if (requested) {
    return { ref: requested, kind: 'tag' }
  }
  const tags = await listRemoteTags(url, creds)
  if (tags.length === 0) {
    return { ref: 'HEAD', kind: 'head' }
  }
  tags.sort(semverCmp)
  return { ref: tags[tags.length - 1], kind: 'tag' }
}

async function installNodeDeps(dir: string): Promise<void> {
  try {
    await fs.access(path.join(dir, 'package.json'))
  } catch {
    return
  }
  try {
    await execFile('npm', ['install', '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--no-progress'], {
      cwd: dir,
      maxBuffer: 32 * 1024 * 1024,
      shell: true,
    })
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const text = e.stderr || e.stdout || e.message || String(err)
    const tail = text.split('\n').slice(-15).join('\n')
    throw new Error(`npm install failed in ${dir}:\n${tail}`)
  }
}

async function gitClone(
  url: string,
  refKind: 'tag' | 'head',
  ref: string,
  dest: string,
  creds: ResolvedAuth | null,
  keepGit: boolean,
): Promise<string> {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  await fs.rm(dest, { recursive: true, force: true })
  const { url: authedUrl, env, cleanup } = await withGitAuth(url, creds)
  const args =
    refKind === 'tag'
      ? ['clone', '--depth', '1', '--branch', ref, '--single-branch', authedUrl, dest]
      : ['clone', '--depth', '1', authedUrl, dest]
  try {
    await runGit(args, { maxBuffer: GIT_BUFFER, env })
  } finally {
    await cleanup()
  }
  const { stdout } = await runGit(['-C', dest, 'rev-parse', 'HEAD'])
  const sha = stdout.trim().slice(0, 7)
  if (!keepGit) {
    await fs.rm(path.join(dest, '.git'), { recursive: true, force: true })
  }
  return sha
}

// Re-serialising with a fixed style would rewrite every byte of a file we only
// meant to patch two fields of, leaving every installed extension's manifest
// permanently "dirty" against its source repo for no semantic reason. Matching
// the source file's own indent and trailing-newline convention keeps the diff
// to exactly the fields that actually changed.

async function writeSidecar(dir: string, sidecar: InstalledSidecar): Promise<void> {
  await fs.writeFile(path.join(dir, SIDECAR_FILE), JSON.stringify(sidecar, null, 2) + '\n', 'utf-8')
}

async function readSidecar(dir: string): Promise<InstalledSidecar | null> {
  try {
    const raw = await fs.readFile(path.join(dir, SIDECAR_FILE), 'utf-8')
    return JSON.parse(raw) as InstalledSidecar
  } catch {
    return null
  }
}

async function dirMtime(dir: string): Promise<number> {
  try {
    const stat = await fs.stat(dir)
    return stat.mtimeMs
  } catch {
    return 0
  }
}

async function listFilesRecursive(dir: string, base: string = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of sorted) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (['dist', 'node_modules', '.git'].includes(entry.name)) {
        continue
      }
      Object.assign(out, await listFilesRecursive(full, rel))
      continue
    }
    try {
      out[rel] = await fs.readFile(full, 'utf-8')
    } catch {
      out[rel] = ''
    }
  }
  return out
}

async function readRecord(slug: string, root: string, idPrefix: string): Promise<InstalledExtensionRecord | null> {
  const dir = path.join(root, slug)
  const sidecar = await readSidecar(dir)
  if (!sidecar) {
    return null
  }
  let manifestRaw: string
  try {
    manifestRaw = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf-8')
  } catch {
    return null
  }
  const manifest = JSON.parse(manifestRaw) as ExtensionManifest
  return {
    id: `${idPrefix}/${slug}`,
    slug,
    manifest,
    sidecar,
    files: await listFilesRecursive(dir),
    updatedAt: await dirMtime(dir),
  }
}

// A `local/<slug>` extension should end up with the same id regardless of how it got installed —
// a repo cloned directly by hand (the main instance's registered live checkouts, e.g. "docker",
// "git") uses just the repo name, so an asLocal install needs to match that instead of the
// owner-prefixed slug used for "installed/<slug>" registry installs (where collisions across
// unrelated repos sharing a repo name are the actual concern this prefixing guards against).
async function pickFreshSlug(owner: string, repo: string, root: string, asLocal?: boolean): Promise<string> {
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    entries = []
  }
  const taken = new Set(entries)
  const base = slugify(asLocal ? repo : `${owner}-${repo}`)
  if (!taken.has(base)) {
    return base
  }
  let i = 2
  while (taken.has(`${base}-${i}`)) {
    i += 1
  }
  return `${base}-${i}`
}

async function performInstall(
  slug: string,
  parsed: ParsedRepo,
  auth: InstallAuth | undefined,
  refSpec?: string,
  asLocal?: boolean,
): Promise<InstalledExtensionRecord> {
  const root = asLocal ? localExtRoot() : installedExtRoot()
  const idPrefix = asLocal ? 'local' : 'installed'
  const id = `${idPrefix}/${slug}`
  const dir = path.join(root, slug)
  const creds = await resolveAuth(auth)

  const resolved = refSpec ? { ref: refSpec, kind: 'tag' as const } : await resolveInstallRef(parsed.url, creds)

  const sha = await gitClone(parsed.url, resolved.kind, resolved.ref, dir, creds, Boolean(asLocal))
  const finalRef = resolved.kind === 'tag' ? resolved.ref : `HEAD@${sha}`

  const manifest = await rewriteManifestId(dir, id)
  await writeSidecar(dir, {
    source: { type: 'git', url: parsed.url, name: `${parsed.owner}/${parsed.repo}` },
    auth,
    ref: finalRef,
    installedAt: Date.now(),
  })

  await installNodeDeps(dir)

  flushCache(id)
  const result = await buildExtension(id, manifest)
  if (!result.success) {
    const summary = result.errors.map((e) => `${e.file}:${e.line ?? '?'}  ${e.message}`).join('\n')
    throw new Error(`Extension built with errors:\n${summary}`)
  }

  const record = await readRecord(slug, root, idPrefix)
  if (!record) {
    throw new Error(`Failed to read installed extension after install: ${id}`)
  }
  return record
}

export const installExtensionFromUrl = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((input: { url: string; ref?: string; auth?: InstallAuth; asLocal?: boolean }) => input)
  .handler(async ({ data: input }): Promise<InstalledExtensionRecord> => {
    const parsed = parseRepoUrl(input.url)
    const root = input.asLocal ? localExtRoot() : installedExtRoot()
    const slug = await pickFreshSlug(parsed.owner, parsed.repo, root, input.asLocal)
    return performInstall(slug, parsed, input.auth, input.ref, input.asLocal)
  })

export const listInstalledExtensions = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<InstalledExtensionRecord[]> => {
    let entries: string[]
    try {
      entries = await fs.readdir(installedExtRoot())
    } catch {
      return []
    }
    const records: InstalledExtensionRecord[] = []
    for (const slug of entries) {
      const record = await readRecord(slug, installedExtRoot(), 'installed')
      if (record) {
        records.push(record)
      }
    }
    return records
  },
)

function slugFromInstalledId(extensionId: string): string {
  const [scope, slug] = extensionId.split('/')
  if (scope !== 'installed' || !slug) {
    throw new Error(`Expected installed/<slug>, got "${extensionId}"`)
  }
  return slug
}

export const updateInstalledExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; ref?: string }) => data)
  .handler(async ({ data }): Promise<InstalledExtensionRecord> => {
    const { extensionId, ref } = data
    const slug = slugFromInstalledId(extensionId)
    const sidecar = await readSidecar(extDir(extensionId))
    if (!sidecar) {
      throw new Error(`Not an installed extension: ${extensionId}`)
    }
    const parsed = parseRepoUrl(sidecar.source.url)
    return performInstall(slug, parsed, sidecar.auth, ref)
  })

export const uninstallExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<void> => {
    const slug = slugFromInstalledId(extensionId)
    const dir = path.join(installedExtRoot(), slug)
    await fs.rm(dir, { recursive: true, force: true })
    flushCache(extensionId)
    toastStore.broadcast({ type: 'extensions_updated' })
  })

export const checkInstalledForUpdates = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<UpdateCheck> => {
    const sidecar = await readSidecar(extDir(extensionId))
    if (!sidecar) {
      throw new Error(`Not an installed extension: ${extensionId}`)
    }
    const creds = await resolveAuth(sidecar.auth)
    const tags = await listRemoteTags(sidecar.source.url, creds)
    if (tags.length === 0) {
      return { current: sidecar.ref, latest: null, hasUpdate: false, availableTags: [] }
    }
    tags.sort(semverCmp)
    const sortedDesc = [...tags].reverse()
    const latest = sortedDesc[0]
    return {
      current: sidecar.ref,
      latest,
      hasUpdate: sidecar.ref !== latest,
      availableTags: sortedDesc,
    }
  })
