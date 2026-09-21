import { promises as fs } from 'node:fs'
import path from 'node:path'

import {
  type CheckoutState,
  readCheckoutState,
  refuseCompile,
} from '@/app/_authed/(extension-runtime)/_server/checkout-state'
import { buildExtension } from '@/app/_authed/(extension-runtime)/_server/compiler'
import { runGit } from '@/app/_authed/(extension-runtime)/_server/git-exec'
import { flushCache } from '@/app/_authed/(extension-runtime)/_server/loader'
import { BUILD_PROVENANCE_FILE, localExtRoot } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { BuildResult, CompileRefusal, ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

const MANIFEST_FILE = 'extension.json'

// The checkout state is spread in rather than restated: the durable half of
// "is this instance running that change?" is what the directory itself says,
// and a manifest version is hand-maintained while a directory mtime (see
// dirMtime below) moves on anything that touches an entry in it, not
// specifically on a deploy.
export interface LocalExtensionRecord extends CheckoutState {
  id: string
  slug: string
  manifest: ExtensionManifest
  files: Record<string, string>
  updatedAt: number
  /**
   * The commit the CURRENTLY BUILT bundle was produced from — what the instance
   * is actually running. It can lag `sourceCommit` (the checkout's own HEAD)
   * now that the auto-rebuild refuses a dirty or off-branch checkout instead of
   * republishing it. Null when nothing has been built yet, or the build predates
   * this being recorded.
   */
  builtCommit: string | null
  /**
   * Whether the bundle was built from a tree carrying uncommitted work — true
   * for a `compile_extension(allowUnclean)`, where `builtCommit` names a commit
   * whose tree is NOT what was built. Without this, that commit reads as an
   * exact identity it does not have. Null when no build has recorded provenance.
   */
  builtDirty: boolean | null
  /** The uncommitted paths that were on top of `builtCommit` at build time. */
  builtDirtyPaths: string[]
  /**
   * Why the running bundle may lag the checkout: the refusal the automatic
   * rebuild would raise for the checkout as it stands (dirty, or off its default
   * branch), or null when a rebuild would proceed. Reading `builtCommit` against
   * `sourceCommit` says the two differ; this says why they are being kept apart.
   */
  refusal: CompileRefusal | null
  /**
   * When `sourceCommit` was committed, ISO 8601, or null when there is no
   * checkout to ask.
   *
   * Read for ONE extension rather than for a list — it is a fourth git call
   * per directory and nothing in a list shows it. It exists because the page
   * used to report the extension directory's mtime as "Updated", which is not
   * when the extension last changed: a directory's mtime moves when an entry
   * in it is added or removed and stays put while a file three levels down is
   * rewritten. The commit date is the question that was being asked.
   */
  sourceCommitDate: string | null
}

interface BuiltProvenance {
  commit: string | null
  dirty: boolean | null
  dirtyPaths: string[]
}

// What a built bundle recorded about the tree it came from, or empty when no
// build has recorded any. Kept inside `dist/`, which extension repos ignore, so
// reading it never reflects on whether the checkout is clean.
async function readBuiltProvenance(dir: string): Promise<BuiltProvenance> {
  try {
    const raw = await fs.readFile(path.join(dir, 'dist', BUILD_PROVENANCE_FILE), 'utf-8')
    const parsed = JSON.parse(raw) as { commit?: unknown; dirty?: unknown; dirtyPaths?: unknown }
    return {
      commit: typeof parsed.commit === 'string' ? parsed.commit : null,
      dirty: typeof parsed.dirty === 'boolean' ? parsed.dirty : null,
      dirtyPaths: Array.isArray(parsed.dirtyPaths)
        ? parsed.dirtyPaths.filter((p): p is string => typeof p === 'string')
        : [],
    }
  } catch {
    return { commit: null, dirty: null, dirtyPaths: [] }
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

/**
 * The size past which a file in an extension is not treated as source.
 *
 * Every path here ends up in a record that is serialized to a browser, and
 * the only thing that reads one is an editor. Half a megabyte is far above
 * any file a person edits and far below the assets that made this expensive:
 * one extension ships a 27 MB WebAssembly build, and reading it as UTF-8
 * turned it into 137 MB of replacement characters in the response.
 */
const MAX_SOURCE_FILE_BYTES = 512 * 1024

/**
 * A file's text, or null when it is not text.
 *
 * Size is checked before the read, so a large binary is never loaded at all,
 * and a NUL byte decides the rest: it cannot occur in a UTF-8 text file and
 * occurs almost immediately in anything compiled. Skipped files are simply
 * absent from the record — no caller writes back what it did not read, since
 * updating an extension writes the files it is handed and deletes nothing.
 */
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

/** When HEAD was committed, ISO 8601, or null when this is not a checkout. */
async function readCommitDate(dir: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(['-C', dir, 'log', '-1', '--format=%cI'])
    return stdout.trim() || null
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
      const content = await readSourceFile(fullPath)
      if (content !== null) {
        files[rel] = content
      }
    }
  }
  return files
}

/**
 * One local extension, whole: its manifest, its files, and the state of the
 * checkout they live in.
 *
 * Read for the extension somebody opens, never for a list of them — the files
 * are the expensive half by two orders of magnitude and the git calls are the
 * slow half, and a list draws names. What a list needs is
 * `listExtensionsIndex`.
 */
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
  const checkout = await readCheckoutState(dir)
  const commitDate = await readCommitDate(dir)
  const built = await readBuiltProvenance(dir)
  return {
    id: `local/${slug}`,
    slug,
    manifest,
    files,
    updatedAt: await dirMtime(dir),
    ...checkout,
    builtCommit: built.commit,
    builtDirty: built.dirty,
    builtDirtyPaths: built.dirtyPaths,
    // The refusal the automatic rebuild would raise for this checkout as it
    // stands — the reason the running bundle is held apart from the checkout.
    // No override here: the record reports what the automatic path would do, and
    // that path has no override.
    refusal: refuseCompile(checkout, false),
    sourceCommitDate: commitDate,
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

/**
 * Remove ONE file from a local extension.
 *
 * Its own operation rather than a consequence of `updateLocalExtensionImpl`,
 * which writes the files it is handed and touches nothing else: a caller that
 * sends a subset — an MCP tool writing a single file — must not have the rest
 * of the extension deleted out from under it. So an omission never deletes,
 * and deleting is asked for by name.
 */
export async function deleteLocalExtensionFileImpl(data: {
  extensionId: string
  path: string
}): Promise<LocalExtensionRecord> {
  const { extensionId } = data
  const slug = slugFromId(extensionId)
  const dir = extDirPath(slug)
  const target = path.resolve(dir, data.path)
  const relative = path.relative(dir, target)
  // A path that climbs out of the extension's own directory is refused rather
  // than normalised: there is no reading of "../../etc" this should serve.
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to delete a path outside ${extensionId}: ${data.path}`)
  }
  if (relative === MANIFEST_FILE) {
    throw new Error(`Refusing to delete ${MANIFEST_FILE} — it is what makes ${extensionId} an extension`)
  }
  await fs.rm(target, { recursive: true, force: true })
  flushCache(extensionId)
  const record = await loadExtension(slug)
  if (!record) {
    throw new Error(`Failed to read extension ${extensionId} after deleting ${data.path}`)
  }
  return record
}

export async function deleteLocalExtensionImpl(extensionId: string): Promise<void> {
  const slug = slugFromId(extensionId)
  const dir = extDirPath(slug)
  await fs.rm(dir, { recursive: true, force: true })
  flushCache(extensionId)
}

export interface CompileOptions {
  /**
   * Build the checkout as it stands, whatever state it is in. Deliberately
   * available with no conditions: building a branch on a throwaway instance is
   * legitimate, and a guard nobody can get past is a guard people route around.
   */
  allowUnclean?: boolean
}

export async function compileLocalExtensionImpl(
  extensionId: string,
  options: CompileOptions = {},
): Promise<BuildResult> {
  const slug = slugFromId(extensionId)
  const record = await loadExtension(slug)
  if (!record) {
    throw new Error(`Extension ${extensionId} does not exist`)
  }
  // Checked before anything is flushed or built: a compile replaces what this
  // instance is running, so the state of the directory has to be acceptable
  // BEFORE the running bundle is disturbed, not after the build reports on it.
  const refusal = refuseCompile(record, options.allowUnclean === true)
  if (refusal) {
    return {
      success: false,
      // Repeated as an error so a caller that only renders errors still shows
      // the reason, instead of an empty failure it cannot explain.
      errors: [{ file: extensionId, message: refusal.message }],
      warnings: [],
      clientHash: '',
      serverHash: '',
      refusal,
    }
  }
  flushCache(extensionId)
  return buildExtension(extensionId, record.manifest)
}
