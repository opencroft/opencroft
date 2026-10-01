import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * How a root's contents are enumerated.
 *
 * `all` takes everything. `git-aware` treats each immediate child as a
 * checkout and takes what a fresh clone would NOT bring back: tracked files,
 * untracked-but-not-ignored files, and `.git` itself. A child with no `.git`
 * is a snapshot of some source and is taken without its rebuildable
 * directories (see `NON_CHECKOUT_EXCLUDES`). A child whose name starts with a
 * dot is transient and is skipped.
 */
export type RootPolicy = 'all' | 'git-aware'

export interface FileRoot {
  /** Path under the data directory, and the path inside the archive under `files/`. */
  name: string
  policy: RootPolicy
}

/**
 * The on-disk state a backup carries, and how each part is walked.
 *
 * `app-data` is the private data directory of every App instance — the
 * design-kit's components, docs and registry, the documentation app's pages.
 * Nothing else holds a copy. `extension-data` is what `host.dataDir()` hands
 * an extension. `agent-workspace` is where agent sessions work, and is taken
 * whole and unfiltered by design: anything can be in there.
 *
 * `extensions` is one root with one folder per extension, and `git-aware`
 * fits both kinds of folder in it:
 *   - a `local.*` folder is a git checkout, 370 MB of which 2 MB is authored.
 *     The rest is `node_modules`, `dist`, and vendored binaries the checkouts
 *     gitignore — measured 2026-09-22: 43 MB of onnxruntime wasm under
 *     `audio-pipelines/assets/vad`. Its unpushed commits and local branches
 *     exist only in `.git`, so that is taken as well.
 *   - any other folder is a snapshot of one commit of its source, with no
 *     `.git`. Its source, ref and commit are a row of the `Extension` table,
 *     which the database backup carries, so it can be fetched again; it is
 *     taken as it stands, without the directories below, as a fallback that
 *     works offline or when the source is gone.
 * Dropping the ignored files and directories loses nothing, because the host
 * rebuilds them: `ensureDependencies` in the extension compiler runs
 * `npm ci`/`npm install` for a folder whose node_modules does not match its
 * manifest, that install runs each extension's `postinstall` (which is what
 * copies the wasm out of node_modules), and `ensureBuilt` in the loader treats
 * a missing bundle as stale and compiles it.
 */
export const BACKUP_FILE_ROOTS: readonly FileRoot[] = [
  { name: 'app-data', policy: 'all' },
  { name: 'extension-data', policy: 'all' },
  { name: 'extensions', policy: 'git-aware' },
  { name: 'agent-workspace', policy: 'all' },
]

/**
 * Directories a `git-aware` root skips in a child that is NOT a git checkout.
 *
 * The form of every extension that is not a `local.*` checkout: a registry
 * install has no `.git` by design. Both are rebuilt on demand, exactly as in a
 * checkout.
 */
const NON_CHECKOUT_EXCLUDES: ReadonlySet<string> = new Set(['node_modules', 'dist'])

export interface WalkedEntry {
  /** Path relative to the root, '/'-separated. A trailing '/' marks a directory. */
  relativePath: string
  absolutePath: string
  isDirectory: boolean
  mtime: Date
  /** Unix mode bits, carried so an executable file restores as one. */
  mode: number
}

export interface SkippedEntry {
  /** Path relative to the root. */
  path: string
  reason: string
}

async function statMaybe(absolutePath: string): Promise<{ mtime: Date; mode: number } | null> {
  try {
    const stat = await fs.stat(absolutePath)
    return { mtime: stat.mtime, mode: stat.mode & 0o7777 }
  } catch {
    return null
  }
}

async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    return (await fs.stat(absolutePath)).isDirectory()
  } catch {
    return false
  }
}

/**
 * The two entry shapes, in one place each.
 *
 * `readdir` says what an entry IS, but carries neither the mtime the archive
 * records nor the mode an executable is restored from, so both forms need the
 * stat — and both had the same `stat?.x ?? default` fallback written out at
 * three call sites apiece.
 */
async function directoryEntry(absolutePath: string, relativePath: string): Promise<WalkedEntry> {
  const stat = await statMaybe(absolutePath)
  return {
    relativePath: `${relativePath}/`,
    absolutePath,
    isDirectory: true,
    mtime: stat?.mtime ?? new Date(),
    mode: stat?.mode ?? 0o755,
  }
}

/** Null when the path is gone — a staged delete, or a file that vanished mid-walk. */
async function fileEntry(absolutePath: string, relativePath: string): Promise<WalkedEntry | null> {
  const stat = await statMaybe(absolutePath)
  return stat && { relativePath, absolutePath, isDirectory: false, mtime: stat.mtime, mode: stat.mode }
}

/** Readdir in a fixed order, so two runs over an unchanged tree produce the same archive. */
async function readSorted(absoluteDir: string, relativePrefix: string, skipped: SkippedEntry[]): Promise<Dirent[]> {
  try {
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true })
    return entries.sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    skipped.push({ path: relativePrefix || '.', reason: `unreadable: ${(err as Error).message}` })
    return []
  }
}

/**
 * Walk a directory, yielding directories before their contents.
 *
 * Entries are sorted, so two runs over an unchanged tree produce the same
 * archive. Symlinks are recorded as skipped rather than followed: following
 * one can leave the root entirely, and storing one would need the archive to
 * carry link targets that may not exist where it is restored.
 */
async function* walkAll(
  absoluteDir: string,
  relativePrefix: string,
  skipped: SkippedEntry[],
  excludeNames: ReadonlySet<string> = new Set(),
): AsyncGenerator<WalkedEntry> {
  for (const entry of await readSorted(absoluteDir, relativePrefix, skipped)) {
    const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name
    const absolutePath = path.join(absoluteDir, entry.name)
    if (excludeNames.has(entry.name)) {
      continue
    }
    if (entry.isSymbolicLink()) {
      skipped.push({ path: relativePath, reason: 'symlink' })
      continue
    }
    if (entry.isDirectory()) {
      yield await directoryEntry(absolutePath, relativePath)
      yield* walkAll(absolutePath, relativePath, skipped, excludeNames)
      continue
    }
    if (!entry.isFile()) {
      // Sockets, fifos, devices. `data/pglite.lock` is one of these; nothing
      // in these roots is, but a backup must not stall reading one if it ever is.
      skipped.push({ path: relativePath, reason: 'not a regular file' })
      continue
    }
    const file = await fileEntry(absolutePath, relativePath)
    if (!file) {
      skipped.push({ path: relativePath, reason: 'vanished while reading' })
      continue
    }
    yield file
  }
}

/**
 * Ask git which of a checkout's files a clone would not bring back.
 *
 * Returns null when the directory is not a checkout, or git is unavailable or
 * refuses — the caller then falls back to walking it with a static exclude
 * list, so a broken checkout costs archive size rather than data.
 */
async function gitListedFiles(checkoutDir: string): Promise<string[] | null> {
  if (!(await isDirectory(path.join(checkoutDir, '.git')))) {
    return null
  }
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '-c', '-o', '--exclude-standard', '-z'], {
      cwd: checkoutDir,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout.split('\0').filter((name) => name.length > 0)
  } catch {
    return null
  }
}

async function* walkCheckout(
  checkoutDir: string,
  relativePrefix: string,
  listed: string[],
  skipped: SkippedEntry[],
): AsyncGenerator<WalkedEntry> {
  for (const name of [...new Set(listed)].sort()) {
    // Null means the index lists it but the worktree does not — a staged
    // delete, with nothing to store.
    const file = await fileEntry(path.join(checkoutDir, name), `${relativePrefix}/${name}`)
    if (file) {
      yield file
    }
  }
  // The history itself, so an unpushed commit or a local branch survives.
  const gitDir = path.join(checkoutDir, '.git')
  yield await directoryEntry(gitDir, `${relativePrefix}/.git`)
  yield* walkAll(gitDir, `${relativePrefix}/.git`, skipped)
}

async function* walkGitAware(absoluteRoot: string, skipped: SkippedEntry[]): AsyncGenerator<WalkedEntry> {
  for (const entry of await readSorted(absoluteRoot, '', skipped)) {
    const absolutePath = path.join(absoluteRoot, entry.name)
    // A dot-prefixed child is where an install stages a folder before swapping
    // it in, or parks the one it replaced: a second, possibly half-written copy
    // of an extension that is also present under its real name.
    if (entry.name.startsWith('.')) {
      skipped.push({ path: entry.name, reason: 'transient' })
      continue
    }
    if (entry.isSymbolicLink()) {
      skipped.push({ path: entry.name, reason: 'symlink' })
      continue
    }
    if (!entry.isDirectory()) {
      const file = await fileEntry(absolutePath, entry.name)
      if (file) {
        yield file
      }
      continue
    }
    yield await directoryEntry(absolutePath, entry.name)
    const listed = await gitListedFiles(absolutePath)
    if (listed) {
      yield* walkCheckout(absolutePath, entry.name, listed, skipped)
    } else {
      yield* walkAll(absolutePath, entry.name, skipped, NON_CHECKOUT_EXCLUDES)
    }
  }
}

/** Enumerate one root under `dataDirectory`. Yields nothing if the root does not exist. */
export async function* walkRoot(
  dataDirectory: string,
  root: FileRoot,
  skipped: SkippedEntry[],
): AsyncGenerator<WalkedEntry> {
  const absoluteRoot = path.join(dataDirectory, ...root.name.split('/'))
  if (!(await isDirectory(absoluteRoot))) {
    return
  }
  if (root.policy === 'git-aware') {
    yield* walkGitAware(absoluteRoot, skipped)
    return
  }
  yield* walkAll(absoluteRoot, '', skipped)
}
