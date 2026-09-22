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
 * untracked-but-not-ignored files, and `.git` itself.
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
 * `extensions/local` is `git-aware` because it is 370 MB of which 2 MB is
 * authored. The rest is `node_modules`, `dist`, and vendored binaries the
 * checkouts gitignore — measured 2026-09-22: 43 MB of onnxruntime wasm under
 * `audio-pipelines/assets/vad`. Dropping those loses nothing, because the host
 * rebuilds them: `ensureDependencies` in the extension compiler runs
 * `npm ci`/`npm install` for a checkout whose node_modules does not match its
 * manifest, that install runs each extension's `postinstall` (which is what
 * copies the wasm out of node_modules), and `ensureBuilt` in the loader treats
 * a missing bundle as stale and compiles it.
 */
export const BACKUP_FILE_ROOTS: readonly FileRoot[] = [
  { name: 'app-data', policy: 'all' },
  { name: 'extension-data', policy: 'all' },
  { name: 'extensions/local', policy: 'git-aware' },
  { name: 'agent-workspace', policy: 'all' },
]

/**
 * Directories a `git-aware` root skips in a child that is NOT a git checkout.
 *
 * The fallback for an extension installed from a tarball, or one whose `.git`
 * is gone. Both are rebuilt on demand, exactly as in a checkout.
 */
const NON_CHECKOUT_EXCLUDES: ReadonlySet<string> = new Set(['node_modules', 'dist'])

/**
 * The host's own record of where an extension was installed from — its git
 * URL, ref and the secret used to fetch it.
 *
 * Carried even when the checkout gitignores it, which `audio-pipelines` does:
 * an extension's `.gitignore` is about that extension's repository and has no
 * standing to decide whether the HOST keeps its own install record.
 */
const HOST_SIDECAR = 'installed.json'

export interface WalkedEntry {
  /** Path relative to the root, '/'-separated. A trailing '/' marks a directory. */
  relativePath: string
  absolutePath: string
  isDirectory: boolean
  sizeBytes: number
  mtime: Date
  /** Unix mode bits, carried so an executable file restores as one. */
  mode: number
}

export interface SkippedEntry {
  /** Path relative to the root. */
  path: string
  reason: string
}

async function statMaybe(absolutePath: string): Promise<{ size: number; mtime: Date; mode: number } | null> {
  try {
    const stat = await fs.stat(absolutePath)
    return { size: stat.size, mtime: stat.mtime, mode: stat.mode & 0o7777 }
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
  let entries: Dirent[]
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true })
  } catch (err) {
    skipped.push({ path: relativePrefix || '.', reason: `unreadable: ${(err as Error).message}` })
    return
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
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
      const stat = await statMaybe(absolutePath)
      yield {
        relativePath: `${relativePath}/`,
        absolutePath,
        isDirectory: true,
        sizeBytes: 0,
        mtime: stat?.mtime ?? new Date(),
        mode: stat?.mode ?? 0o755,
      }
      yield* walkAll(absolutePath, relativePath, skipped, excludeNames)
      continue
    }
    if (!entry.isFile()) {
      // Sockets, fifos, devices. `data/pglite.lock` is one of these; nothing
      // in these roots is, but a backup must not stall reading one if it ever is.
      skipped.push({ path: relativePath, reason: 'not a regular file' })
      continue
    }
    const stat = await statMaybe(absolutePath)
    if (!stat) {
      skipped.push({ path: relativePath, reason: 'vanished while reading' })
      continue
    }
    yield { relativePath, absolutePath, isDirectory: false, sizeBytes: stat.size, mtime: stat.mtime, mode: stat.mode }
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
  const names = new Set(listed)
  // Always, whatever the checkout's .gitignore says about it.
  if (await statMaybe(path.join(checkoutDir, HOST_SIDECAR))) {
    names.add(HOST_SIDECAR)
  }
  for (const name of [...names].sort()) {
    const absolutePath = path.join(checkoutDir, name)
    const stat = await statMaybe(absolutePath)
    if (!stat) {
      // In the index but not in the worktree — a staged delete. Nothing to store.
      continue
    }
    yield {
      relativePath: `${relativePrefix}/${name}`,
      absolutePath,
      isDirectory: false,
      sizeBytes: stat.size,
      mtime: stat.mtime,
      mode: stat.mode,
    }
  }
  // The history itself, so an unpushed commit or a local branch survives.
  const gitDir = path.join(checkoutDir, '.git')
  const gitStat = await statMaybe(gitDir)
  yield {
    relativePath: `${relativePrefix}/.git/`,
    absolutePath: gitDir,
    isDirectory: true,
    sizeBytes: 0,
    mtime: gitStat?.mtime ?? new Date(),
    mode: gitStat?.mode ?? 0o755,
  }
  yield* walkAll(gitDir, `${relativePrefix}/.git`, skipped)
}

async function* walkGitAware(absoluteRoot: string, skipped: SkippedEntry[]): AsyncGenerator<WalkedEntry> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(absoluteRoot, { withFileTypes: true })
  } catch (err) {
    skipped.push({ path: '.', reason: `unreadable: ${(err as Error).message}` })
    return
  }
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const absolutePath = path.join(absoluteRoot, entry.name)
    if (entry.isSymbolicLink()) {
      skipped.push({ path: entry.name, reason: 'symlink' })
      continue
    }
    if (!entry.isDirectory()) {
      const stat = await statMaybe(absolutePath)
      if (stat) {
        yield {
          relativePath: entry.name,
          absolutePath,
          isDirectory: false,
          sizeBytes: stat.size,
          mtime: stat.mtime,
          mode: stat.mode,
        }
      }
      continue
    }
    const stat = await statMaybe(absolutePath)
    yield {
      relativePath: `${entry.name}/`,
      absolutePath,
      isDirectory: true,
      sizeBytes: 0,
      mtime: stat?.mtime ?? new Date(),
      mode: stat?.mode ?? 0o755,
    }
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
