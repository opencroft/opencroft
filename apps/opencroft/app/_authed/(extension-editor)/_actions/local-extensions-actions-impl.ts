import { promises as fs } from 'node:fs'
import path from 'node:path'

import { buildExtension } from '@/app/_authed/(extension-runtime)/_server/compiler'
import { runGit } from '@/app/_authed/(extension-runtime)/_server/git-exec'
import { flushCache } from '@/app/_authed/(extension-runtime)/_server/loader'
import { localExtRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { BuildResult, ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

const MANIFEST_FILE = 'extension.json'

export interface LocalExtensionRecord {
  id: string
  slug: string
  manifest: ExtensionManifest
  files: Record<string, string>
  updatedAt: number
  // What commit this checkout is actually on, read directly
  // from the checkout rather than tracked by the app -- so it stays true
  // through anything that changes the directory's HEAD (a plain `git
  // checkout`, not just this app's own install/update actions), which is
  // exactly how a local extension's source normally gets updated. `null`
  // when the directory isn't a git checkout at all (or `git` fails) --
  // degrades to "unknown", not a build error, since a local extension has
  // never been required to be one.
  sourceCommit: string | null
  // True when the checkout has uncommitted changes -- a commit hash alone
  // reads as authoritative even when the tree has drifted from it, and that
  // is precisely the state a dev/test compile leaves a checkout in.
  sourceDirty: boolean | null
}

// The durable half of "is this instance running that
// change?" -- a manifest version is hand-maintained and a directory mtime
// (see dirMtime below) moves on anything that touches an entry in it, not
// specifically on a deploy. A commit read straight from the checkout is
// neither: it is exactly what the repository would call this code.
export async function readGitState(dir: string): Promise<{ sourceCommit: string | null; sourceDirty: boolean | null }> {
  try {
    const { stdout: head } = await runGit(['-C', dir, 'rev-parse', 'HEAD'])
    const { stdout: status } = await runGit(['-C', dir, 'status', '--porcelain'])
    return { sourceCommit: head.trim(), sourceDirty: status.trim().length > 0 }
  } catch {
    return { sourceCommit: null, sourceDirty: null }
  }
}

function slugFromId(extensionId: string): string {
  const [scope, slug] = extensionId.split('/')
  if (scope !== 'local' || !slug) {
    throw new Error(`Expected local/<slug>, got "${extensionId}"`)
  }
  return slug
}

function extDirPath(slug: string): string {
  return path.join(localExtRoot(), slug)
}

async function readFileOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf-8')
  } catch {
    return ''
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
  const files: Record<string, string> = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let entries: any[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return files
  }
  const sorted = entries.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  for (const entry of sorted) {
    const name = String(entry.name)
    const rel = base ? `${base}/${name}` : name
    const fullPath = path.join(dir, name)
    if (entry.isDirectory()) {
      // Skip dist, node_modules, .git
      if (['dist', 'node_modules', '.git'].includes(name)) {
        continue
      }
      const sub = await listFilesRecursive(fullPath, rel)
      Object.assign(files, sub)
    } else {
      files[rel] = await readFileOrEmpty(fullPath)
    }
  }
  return files
}

async function loadExtension(slug: string): Promise<LocalExtensionRecord | null> {
  const dir = extDirPath(slug)
  let manifestRaw: string
  try {
    manifestRaw = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf-8')
  } catch {
    return null
  }
  const manifest = JSON.parse(manifestRaw) as ExtensionManifest
  const files = await listFilesRecursive(dir)
  const gitState = await readGitState(dir)
  return {
    id: `local/${slug}`,
    slug,
    manifest,
    files,
    updatedAt: await dirMtime(dir),
    ...gitState,
  }
}

// Plain (non-server-fn) implementations — see extension-action-impl.ts's
// invokeExtensionActionImpl for why these exist alongside the createServerFn-wrapped
// versions in local-extensions-actions.ts: a caller with no Start request context
// (an MCP call, the scheduler) gets nothing back from a server-fn wrapper — the
// handler runs but its return value is dropped — while these plain functions
// return it normally.

export async function listLocalExtensionsImpl(): Promise<LocalExtensionRecord[]> {
  const root = localExtRoot()
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return []
  }
  const records: LocalExtensionRecord[] = []
  for (const slug of entries) {
    const record = await loadExtension(slug)
    if (record) {
      records.push(record)
    }
  }
  return records
}

export async function getLocalExtensionImpl(extensionId: string): Promise<LocalExtensionRecord | null> {
  return loadExtension(slugFromId(extensionId))
}

export async function updateLocalExtensionImpl(data: {
  extensionId: string
  files: Record<string, string>
}): Promise<LocalExtensionRecord> {
  const { extensionId, files } = data
  const slug = slugFromId(extensionId)
  const dir = extDirPath(slug)
  try {
    await fs.access(dir)
  } catch {
    throw new Error(`Extension ${extensionId} does not exist`)
  }

  // Write all files
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content, 'utf-8')
  }

  flushCache(extensionId)
  const record = await loadExtension(slug)
  if (!record) {
    throw new Error(`Failed to read extension ${extensionId} after update`)
  }
  return record
}

export async function createLocalExtensionImpl(files: Record<string, string>): Promise<LocalExtensionRecord> {
  const manifest = JSON.parse(files[MANIFEST_FILE]) as ExtensionManifest
  const slug = slugFromId(manifest.id)
  const dir = extDirPath(slug)
  try {
    await fs.access(dir)
    throw new Error(`Extension ${manifest.id} already exists`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err
    }
  }

  await fs.mkdir(dir, { recursive: true })
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content, 'utf-8')
  }

  flushCache(manifest.id)
  const record = await loadExtension(slug)
  if (!record) {
    throw new Error(`Failed to create extension ${manifest.id}`)
  }
  return record
}

export async function deleteLocalExtensionImpl(extensionId: string): Promise<void> {
  const slug = slugFromId(extensionId)
  const dir = extDirPath(slug)
  await fs.rm(dir, { recursive: true, force: true })
  flushCache(extensionId)
}

export async function compileLocalExtensionImpl(extensionId: string): Promise<BuildResult> {
  const slug = slugFromId(extensionId)
  const record = await loadExtension(slug)
  if (!record) {
    throw new Error(`Extension ${extensionId} does not exist`)
  }
  flushCache(extensionId)
  return buildExtension(extensionId, record.manifest)
}
