import { promises as fs } from 'node:fs'
import path from 'node:path'

import { dirMtime, listSourceFiles } from '@/app/_authed/(extension-editor)/_actions/extension-files'
import { isLocalFolder } from '@/app/_authed/(extension-runtime)/_extension-id'
import { type CheckoutState, readCheckoutState } from '@/app/_authed/(extension-runtime)/_server/checkout-state'
import { buildExtensionAt } from '@/app/_authed/(extension-runtime)/_server/compiler'
import {
  extensionIdOf,
  MANIFEST_FILE,
  scanExtensionFolders,
} from '@/app/_authed/(extension-runtime)/_server/extension-folders'
import { writeExtensionRow } from '@/app/_authed/(extension-runtime)/_server/extension-rows'
import { runGit } from '@/app/_authed/(extension-runtime)/_server/git-exec'
import { uninstallExtension } from '@/app/_authed/(extension-runtime)/_server/install'
import { flushCache } from '@/app/_authed/(extension-runtime)/_server/loader'
import { manifestForDisplay } from '@/app/_authed/(extension-runtime)/_server/manifest'
import { BUILD_PROVENANCE_FILE, folderDir, folderDistDir } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { BuildResult, ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

// The checkout state is spread in rather than restated: the durable half of
// "is this instance running that change?" is what the directory itself says,
// and a manifest version is hand-maintained while a directory mtime (see
// dirMtime below) moves on anything that touches an entry in it, not
// specifically on a deploy.
export interface LocalExtensionRecord extends CheckoutState {
  /**
   * The extension id the folder runs under: its manifest's id, which for a
   * development copy of another extension is that extension's, or the folder
   * name when the manifest declares none.
   */
  id: string
  /** The `local.<name>` folder under `extensions/`. */
  folder: string
  manifest: ExtensionManifest
  files: Record<string, string>
  updatedAt: number
  /**
   * The commit the CURRENTLY BUILT bundle was produced from — what the instance
   * is actually running. It lags `sourceCommit` (the checkout's own HEAD) until
   * the next build, and a build that failed keeps the previous bundle running.
   * Null when nothing has been built yet, or the build predates this being
   * recorded.
   */
  builtCommit: string | null
  /**
   * Whether the bundle was built from a tree carrying uncommitted work, where
   * `builtCommit` names a commit whose tree is NOT what was built. Without
   * this, that commit reads as an exact identity it does not have. Null when no
   * build has recorded provenance.
   */
  builtDirty: boolean | null
  /** The uncommitted paths that were on top of `builtCommit` at build time. */
  builtDirtyPaths: string[]
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
async function readBuiltProvenance(distDir: string): Promise<BuiltProvenance> {
  try {
    const raw = await fs.readFile(path.join(distDir, BUILD_PROVENANCE_FILE), 'utf-8')
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

/** A local extension folder's directory; refuses any other folder, since only local ones are editable. */
export function localFolderDir(folder: string): string {
  if (!isLocalFolder(folder)) {
    throw new Error(`Expected a local extension folder (local.<name>), got "${folder}"`)
  }
  return folderDir(folder)
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

/**
 * One local extension, whole: its manifest, its files, and the state of the
 * checkout they live in.
 *
 * Read for the extension somebody opens, never for a list of them — the files
 * are the expensive half by two orders of magnitude and the git calls are the
 * slow half, and a list draws names. What a list needs is
 * `listExtensionsIndex`.
 */
async function loadExtension(folder: string): Promise<LocalExtensionRecord | null> {
  const dir = localFolderDir(folder)
  let manifestRaw: string
  try {
    manifestRaw = await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf-8')
  } catch {
    return null
  }
  const declared = JSON.parse(manifestRaw) as ExtensionManifest
  // A manifest claiming an id it may not keeps the folder listed under its own
  // name, so it can still be opened and fixed.
  const claim = extensionIdOf(folder, declared.id)
  const id = 'error' in claim ? folder : claim.extensionId
  const manifest = manifestForDisplay(declared, id)
  const files = await listSourceFiles(dir)
  const checkout = await readCheckoutState(dir)
  const commitDate = await readCommitDate(dir)
  const built = await readBuiltProvenance(folderDistDir(folder))
  return {
    id,
    folder,
    manifest,
    files,
    updatedAt: await dirMtime(dir),
    ...checkout,
    builtCommit: built.commit,
    builtDirty: built.dirty,
    builtDirtyPaths: built.dirtyPaths,
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
  const records: LocalExtensionRecord[] = []
  for (const entry of await scanExtensionFolders()) {
    if (!isLocalFolder(entry.folder)) {
      continue
    }
    const record = await loadExtension(entry.folder)
    if (record) {
      records.push(record)
    }
  }
  return records
}

export async function getLocalExtensionImpl(folder: string): Promise<LocalExtensionRecord | null> {
  return loadExtension(folder)
}

/**
 * Which of `folders` are local extensions whose own checkout carries
 * uncommitted changes. Other folders are skipped unread, and a folder git can
 * say nothing about is not dirty.
 */
export async function readDirtyLocalFolders(folders: string[]): Promise<Set<string>> {
  const local = folders.filter(isLocalFolder)
  const states = await Promise.all(local.map((folder) => readCheckoutState(localFolderDir(folder))))
  return new Set(local.filter((_, index) => states[index].sourceDirty === true))
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath)
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, content, 'utf-8')
  }
}

/** Rescan after a folder's files changed, since its manifest may now claim another id, and flush what it served. */
async function afterChange(folder: string, previousId: string | null): Promise<LocalExtensionRecord> {
  if (previousId) {
    flushCache(previousId)
  }
  await scanExtensionFolders()
  const record = await loadExtension(folder)
  if (!record) {
    throw new Error(`Failed to read extension ${folder}`)
  }
  flushCache(record.id)
  return record
}

export async function updateLocalExtensionImpl(data: {
  folder: string
  files: Record<string, string>
}): Promise<LocalExtensionRecord> {
  const before = await loadExtension(data.folder)
  if (!before) {
    throw new Error(`Extension ${data.folder} does not exist`)
  }
  await writeFiles(localFolderDir(data.folder), data.files)
  return afterChange(data.folder, before.id)
}

/**
 * Create a local extension in `folder` (`local.<name>`) from `files`, and record
 * it in the extension table — with no source, since it came from nowhere but
 * this instance.
 */
export async function createLocalExtensionImpl(
  folder: string,
  files: Record<string, string>,
): Promise<LocalExtensionRecord> {
  const dir = localFolderDir(folder)
  if (!files[MANIFEST_FILE]) {
    throw new Error(`files must include ${MANIFEST_FILE}`)
  }
  try {
    await fs.access(dir)
    throw new Error(`Extension ${folder} already exists`)
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      throw err
    }
  }
  await fs.mkdir(dir, { recursive: true })
  await writeFiles(dir, files)
  await writeExtensionRow(folder, null)
  return afterChange(folder, null)
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
  folder: string
  path: string
}): Promise<LocalExtensionRecord> {
  const { folder } = data
  const dir = localFolderDir(folder)
  const target = path.resolve(dir, data.path)
  const relative = path.relative(dir, target)
  // A path that climbs out of the extension's own directory is refused rather
  // than normalised: there is no reading of "../../etc" this should serve.
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to delete a path outside ${folder}: ${data.path}`)
  }
  if (relative === MANIFEST_FILE) {
    throw new Error(`Refusing to delete ${MANIFEST_FILE} — it is what makes ${folder} an extension`)
  }
  const before = await loadExtension(folder)
  await fs.rm(target, { recursive: true, force: true })
  return afterChange(folder, before?.id ?? null)
}

/** Remove a local extension: its folder, then its row. See uninstallExtension. */
export async function deleteLocalExtensionImpl(folder: string): Promise<void> {
  localFolderDir(folder)
  await uninstallExtension(folder)
}

/**
 * Build a local extension's folder as it stands, uncommitted changes and
 * branch included: a local extension is edited in place on this instance, so
 * its working tree IS the version meant to run. What was built is recorded
 * beside the bundle (see buildExtensionAt), which is how a reader tells a
 * build of uncommitted work from a build of a commit.
 */
export async function compileLocalExtensionImpl(folder: string): Promise<BuildResult> {
  const record = await loadExtension(folder)
  if (!record) {
    throw new Error(`Extension ${folder} does not exist`)
  }
  flushCache(record.id)
  // Built for the id the folder runs under, into its own dist — also when
  // another folder currently serves that id, so switching over later needs no
  // rebuild.
  return buildExtensionAt(
    { extensionId: record.id, sourceDir: localFolderDir(folder), distDir: folderDistDir(folder) },
    record.manifest,
  )
}
