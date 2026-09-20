import { promises as fs } from 'node:fs'
import path from 'node:path'

import { createServerFn } from '@tanstack/react-start'

import {
  type InstallAuth,
  type InstalledSidecar,
  type InstalledSource,
  installNodeDeps,
  type ResolvedAuth,
  readSidecar,
  resolveAuth,
  writeSidecar,
} from '@/app/_authed/(extension-editor)/_actions/extension-checkout'
import { MANIFEST_FILE, rewriteManifestId } from '@/app/_authed/(extension-editor)/_actions/manifest-file'
import { buildExtension } from '@/app/_authed/(extension-runtime)/_server/compiler'
import { runGit, withGitAuth } from '@/app/_authed/(extension-runtime)/_server/git-exec'
import { flushCache } from '@/app/_authed/(extension-runtime)/_server/loader'
import { extDir, installedExtRoot, localExtRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'
import { toastStore } from '@/lib/toast-store'

const GIT_BUFFER = 64 * 1024 * 1024

// The checkout's own vocabulary — where an extension came from, and how to
// reach that remote — lives in extension-checkout.ts, so the local extensions
// can use it too. Re-exported here because this is where every caller already
// imports it from.
export type { InstallAuth, InstalledSidecar, InstalledSource }

export interface InstalledExtensionRecord {
  id: string
  slug: string
  manifest: ExtensionManifest
  sidecar: InstalledSidecar
  files: Record<string, string>
  updatedAt: number
}

/** An installed extension without its files — what a list of them draws. The
 *  files are read when one is opened. */
export type InstalledExtensionSummary = Omit<InstalledExtensionRecord, 'files'>

/** See readSourceFile below: the size past which a file is not source. */
const MAX_SOURCE_FILE_BYTES = 512 * 1024

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
    const content = await readSourceFile(full)
    if (content !== null) {
      out[rel] = content
    }
  }
  return out
}

/** See MAX_SOURCE_FILE_BYTES and readSourceFile in local-extensions-actions-impl:
 *  same rule, same reason — a record is read to be edited, and a compiled asset
 *  is neither text nor something anyone edits here. */
async function readSourceFile(file: string): Promise<string | null> {
  let size: number
  try {
    size = (await fs.stat(file)).size
  } catch {
    return null
  }
  if (size > MAX_SOURCE_FILE_BYTES) {
    return null
  }
  let buffer: Buffer
  try {
    buffer = await fs.readFile(file)
  } catch {
    return null
  }
  return buffer.includes(0) ? null : buffer.toString('utf-8')
}

async function readSummary(slug: string, root: string, idPrefix: string): Promise<InstalledExtensionSummary | null> {
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
  return {
    id: `${idPrefix}/${slug}`,
    slug,
    manifest: JSON.parse(manifestRaw) as ExtensionManifest,
    sidecar,
    updatedAt: await dirMtime(dir),
  }
}

async function readRecord(slug: string, root: string, idPrefix: string): Promise<InstalledExtensionRecord | null> {
  const summary = await readSummary(slug, root, idPrefix)
  if (!summary) {
    return null
  }
  return { ...summary, files: await listFilesRecursive(path.join(root, slug)) }
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

// What the extensions list loads — the records without their files.
export const listInstalledExtensionSummaries = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<InstalledExtensionSummary[]> => {
    let entries: string[]
    try {
      entries = await fs.readdir(installedExtRoot())
    } catch {
      return []
    }
    const summaries: InstalledExtensionSummary[] = []
    for (const slug of entries) {
      const summary = await readSummary(slug, installedExtRoot(), 'installed')
      if (summary) {
        summaries.push(summary)
      }
    }
    return summaries
  },
)

// One installed extension with its files, for the page that opens it.
export const getInstalledExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((extensionId: string) => extensionId)
  .handler(
    async ({ data: extensionId }): Promise<InstalledExtensionRecord | null> =>
      readRecord(slugFromInstalledId(extensionId), installedExtRoot(), 'installed'),
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
