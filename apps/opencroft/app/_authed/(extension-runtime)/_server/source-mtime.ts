import { type FSWatcher, promises as fs, watch } from 'node:fs'
import path from 'node:path'

import { extDir, projectRoot } from '@/app/_authed/(extension-runtime)/_server/paths'

/** A file's mtime in ms, or 0 when it does not exist. */
export async function statMaybe(file: string): Promise<number> {
  try {
    const stat = await fs.stat(file)
    return stat.mtimeMs
  } catch {
    return 0
  }
}

// Extensions can import any workspace package (agent-client, agent-chat, …)
// via the monorepo's shared node_modules symlinks — esbuild resolves and
// bundles their TS source directly into the extension (see
// ALWAYS_BUNDLED_PACKAGES in compiler.ts; that list isn't exhaustive — any
// workspace package actually imported gets bundled the same way). A merge
// touching only packages/* never changes anything under an extension's own
// directory, so the extension's own tree alone can't see it — walk every
// workspace package's source too. Conservative on purpose: any package change
// invalidates every extension's cache, even ones that don't import it,
// rather than risk missing one that does. Every extension's check asks this,
// so it is kept as one watched answer rather than one per package.
/** The newest mtime of every package's `package.json` and `src/` under the packages directory `dir`. */
export function workspacePackagesMtime(dir: string): Promise<number> {
  return watchedNewest(`packages:${dir}`, dir, (watchDir) => walkPackages(dir, watchDir))
}

async function walkPackages(dir: string, watchDir?: (dir: string) => void): Promise<number> {
  watchDir?.(dir)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return 0
  }
  const mtimes = await Promise.all(
    entries.map(async (entry) => {
      const pkg = path.join(dir, entry)
      // Reports a package.json edit, and its src being added, removed or replaced.
      watchDir?.(pkg)
      const [manifest, sources] = await Promise.all([
        statMaybe(path.join(pkg, 'package.json')),
        walkMtime(path.join(pkg, 'src'), watchDir),
      ])
      return Math.max(manifest, sources)
    }),
  )
  return Math.max(0, ...mtimes)
}

/**
 * The newest mtime among everything an extension's bundles are built from:
 * its manifest, package.json, sources, and every workspace package's source.
 * A bundle older than this is stale.
 */
export async function sourceMtime(extensionId: string): Promise<number> {
  const dir = extDir(extensionId)
  const candidates = [
    path.join(dir, 'extension.json'),
    path.join(dir, 'package.json'),
    path.join(dir, 'src'),
    path.join(dir, 'server'),
    path.join(dir, 'extension.ts'),
    path.join(dir, 'extension.tsx'),
  ]
  const packages = path.join(projectRoot(), '..', '..', 'packages')
  const mtimes = await Promise.all([workspacePackagesMtime(packages), ...candidates.map(newestMtime)])
  return Math.max(...mtimes)
}

// Every extension consultation checks freshness, and one page load consults
// every extension several times over, concurrently. Walking a source tree on
// each check is what made them slow, so a directory's answer is kept while a
// filesystem watch on every directory the walk read reports nothing. Any event
// under the root drops the answer and closes its watches, and the next check
// walks again. A check that starts while a walk is running joins it, unless an
// event arrived since that walk began, in which case it walks afresh.
//
// The answer is per root path, and is only used while the root is still the
// same directory (device and inode): a folder renamed into place over the old
// one, as an install does, or a re-pointed symlink, is a new root and walked,
// though nothing watched in the old tree saw it happen.
//
// A change made just before a check is seen by it: the kernel queues the watch
// event inside the write itself, and the check reads the cache only after its
// own stat of the root has made a round trip through the event loop, whose
// poll delivers the queued event first.
interface WatchedRoot {
  dev: number
  ino: number
  newest: Promise<number>
  watchers: FSWatcher[]
  closed: boolean
}

declare global {
  var __EXT_SOURCE_ROOTS__: Map<string, WatchedRoot> | undefined
}

// On globalThis so a dev-server module reload does not orphan open watches.
function watchedRoots(): Map<string, WatchedRoot> {
  if (!globalThis.__EXT_SOURCE_ROOTS__) {
    globalThis.__EXT_SOURCE_ROOTS__ = new Map()
  }
  return globalThis.__EXT_SOURCE_ROOTS__
}

// statfs types of filesystems that can change on another machine, where no
// local event ever reports it: a root on one is walked on every check.
const REMOTE_FILESYSTEMS = new Set([
  0x6969, // NFS
  0x517b, // SMB
  0xfe534d42, // SMB2
  0xff534d42, // CIFS
  0x01021997, // 9P
  0x65735546, // FUSE
  0x00c36400, // Ceph
])

/** The newest mtime of `start` and, for a directory, everything below it except node_modules, dist and .git; 0 when absent. */
export function newestMtime(start: string): Promise<number> {
  return watchedNewest(start, start, (watchDir) => walkMtime(start, watchDir))
}

type Walk = (watchDir?: (dir: string) => void) => Promise<number>

/** `walk`'s answer for the directory `start`, kept under `key` while nothing it watched reports a change. */
async function watchedNewest(key: string, start: string, walk: Walk): Promise<number> {
  const stat = await fs.stat(start).catch(() => null)
  if (!stat?.isDirectory()) {
    dropRoot(key)
    return stat?.isFile() ? stat.mtimeMs : 0
  }
  const known = watchedRoots().get(key)
  if (known && known.dev === stat.dev && known.ino === stat.ino) {
    return known.newest
  }
  dropRoot(key)
  const root: WatchedRoot = { dev: stat.dev, ino: stat.ino, newest: Promise.resolve(0), watchers: [], closed: false }
  watchedRoots().set(key, root)
  root.newest = walkWatched(key, start, root, walk)
  return root.newest
}

async function walkWatched(key: string, start: string, root: WatchedRoot, walk: Walk): Promise<number> {
  if (await isRemote(start)) {
    dropRoot(key, root)
    return walk()
  }
  return walk((dir) => watchDir(key, root, dir))
}

async function isRemote(dir: string): Promise<boolean> {
  if (process.platform !== 'linux') {
    return false
  }
  try {
    return REMOTE_FILESYSTEMS.has((await fs.statfs(dir)).type)
  } catch {
    return false
  }
}

const unwatchableReported = new Set<string>()

function watchDir(key: string, root: WatchedRoot, dir: string): void {
  if (root.closed) {
    return
  }
  const changed = () => dropRoot(key, root)
  const unwatchable = (err: unknown) => {
    if (!unwatchableReported.has(key)) {
      unwatchableReported.add(key)
      console.warn(`[ext] cannot watch ${dir}, so the sources it is under are walked on every check:`, err)
    }
    changed()
  }
  try {
    const watcher = watch(dir, { persistent: false }, changed)
    watcher.on('error', unwatchable)
    root.watchers.push(watcher)
  } catch (err) {
    unwatchable(err)
  }
}

/** Forget the answer kept under `key` and close its watches; with `root`, only if that is still the one kept. */
function dropRoot(key: string, root = watchedRoots().get(key)): void {
  if (!root) {
    return
  }
  root.closed = true
  for (const watcher of root.watchers) {
    watcher.close()
  }
  root.watchers = []
  if (watchedRoots().get(key) === root) {
    watchedRoots().delete(key)
  }
}

const NOT_SOURCES = new Set(['node_modules', 'dist', '.git'])

async function walkMtime(start: string, watchDir?: (dir: string) => void): Promise<number> {
  try {
    let stat = await fs.stat(start)
    if (stat.isFile()) {
      return stat.mtimeMs
    }
    if (!stat.isDirectory()) {
      return 0
    }
    if (watchDir) {
      // Watched before it is read and stat-ed again after, so a change landing
      // between the two stats is either read here or reported by the watch.
      watchDir(start)
      stat = await fs.stat(start)
    }
    const entries = (await fs.readdir(start)).filter((entry) => !NOT_SOURCES.has(entry))
    const mtimes = await Promise.all(entries.map((entry) => walkMtime(path.join(start, entry), watchDir)))
    return Math.max(stat.mtimeMs, ...mtimes)
  } catch {
    return 0
  }
}
