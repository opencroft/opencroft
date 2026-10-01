// Which extension folders exist, and which extension id each one runs under.
//
// The folder name is the extension id for everything but a local copy: a
// folder `local.<name>` runs under the id its manifest claims (falling back to
// the folder name when it claims none), so a development checkout of
// `acme.widgets` in `local.widgets` serves `acme.widgets` in place of the
// installed one. When more than one folder serves an id:
//   - a local folder wins over the folder named by the id, which stays on disk
//     untouched and comes back into effect when the local copy goes;
//   - of two local folders, the one that appeared on the instance first wins,
//     by the extension table's `createdAt`, so a new copy can never displace
//     one that is already working.
// A folder that loses, or whose manifest claims an id it may not, is listed
// with the reason and not served.

import { promises as fs } from 'node:fs'
import path from 'node:path'

import { db, extension } from '@opencroft/db'
import { inArray } from 'drizzle-orm'

import {
  BUILTIN_OWNER,
  isLocalFolder,
  isReservedOwner,
  parseExtensionId,
} from '@/app/_authed/(extension-runtime)/_extension-id'
import {
  builtinSourceRoot,
  extensionsRoot,
  folderDir,
  hasResolvedFolders,
  setResolvedFolders,
} from '@/app/_authed/(extension-runtime)/_server/paths'

export const MANIFEST_FILE = 'extension.json'

export interface ExtensionFolder {
  folder: string
  /** The id the folder runs under, or null when its manifest gives none it may use. */
  extensionId: string | null
  /** Whether this folder is the one serving its id. */
  active: boolean
  /** Why the folder is not served. */
  error?: string
}

async function hasManifest(dir: string): Promise<boolean> {
  try {
    await fs.access(path.join(dir, MANIFEST_FILE))
    return true
  } catch {
    return false
  }
}

async function readdirOrEmpty(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir)).sort()
  } catch {
    return []
  }
}

/** Every folder that holds an extension: the builtins in the app tree, then the extensions root. */
async function listFolders(): Promise<string[]> {
  const folders: string[] = []
  for (const name of await readdirOrEmpty(builtinSourceRoot())) {
    const folder = `${BUILTIN_OWNER}.${name}`
    if (parseExtensionId(folder) && (await hasManifest(folderDir(folder)))) {
      folders.push(folder)
    }
  }
  // Only names that are extension ids: staging and backup folders are
  // dot-prefixed, and a dot-prefixed name never parses. A `builtin.*` folder
  // here holds only a builtin's build output.
  for (const name of await readdirOrEmpty(extensionsRoot())) {
    const parsed = parseExtensionId(name)
    if (parsed && parsed.owner !== BUILTIN_OWNER && (await hasManifest(folderDir(name)))) {
      folders.push(name)
    }
  }
  return folders
}

/**
 * The id a folder runs under, given the `id` its manifest declares, or the
 * reason it may not run.
 *
 * Only a local folder takes its id from the manifest, falling back to its own
 * name when the manifest declares none; any other folder runs under its name
 * whatever the manifest says. A manifest does not get to name a fetched
 * repository, because the id owns a storage namespace, a data directory and
 * message authorship. A local folder is put on the instance deliberately, so it
 * may claim another extension's id — that is what makes it a stand-in — but
 * never a builtin's.
 */
export function extensionIdOf(folder: string, manifestId: unknown): { extensionId: string } | { error: string } {
  if (!isLocalFolder(folder) || manifestId === undefined || manifestId === null || manifestId === '') {
    return { extensionId: folder }
  }
  const parsed = typeof manifestId === 'string' ? parseExtensionId(manifestId) : null
  if (!parsed) {
    return { error: `manifest id ${JSON.stringify(manifestId)} is not an extension id (<owner>.<extension>)` }
  }
  if (parsed.owner === BUILTIN_OWNER) {
    return { error: `manifest id "${manifestId}" names a builtin extension` }
  }
  return { extensionId: manifestId as string }
}

/** The id a local folder runs under, read from its manifest. */
async function claimedId(folder: string): Promise<{ extensionId: string } | { error: string }> {
  let manifestId: unknown
  try {
    manifestId = JSON.parse(await fs.readFile(path.join(folderDir(folder), MANIFEST_FILE), 'utf-8')).id
  } catch (error) {
    return { error: `cannot read ${MANIFEST_FILE}: ${error instanceof Error ? error.message : String(error)}` }
  }
  return extensionIdOf(folder, manifestId)
}

/** When each folder first appeared on the instance; a folder with no row counts as appearing now. */
async function appearedAt(folders: string[]): Promise<Map<string, number>> {
  const rows = await db
    .select({ folder: extension.folder, createdAt: extension.createdAt })
    .from(extension)
    .where(inArray(extension.folder, folders))
  const now = Date.now()
  return new Map(
    folders.map((folder) => [folder, rows.find((row) => row.folder === folder)?.createdAt.getTime() ?? now]),
  )
}

/**
 * Read every extension folder, decide which one serves each extension id, and
 * publish that to `extDir` and the rest of the runtime. The database is read
 * only when two local folders claim one id.
 */
export async function scanExtensionFolders(): Promise<ExtensionFolder[]> {
  const entries: ExtensionFolder[] = []
  for (const folder of await listFolders()) {
    if (!isLocalFolder(folder)) {
      entries.push({ folder, extensionId: folder, active: false })
      continue
    }
    const claim = await claimedId(folder)
    entries.push(
      'error' in claim
        ? { folder, extensionId: null, active: false, error: claim.error }
        : { folder, extensionId: claim.extensionId, active: false },
    )
  }

  const byId = new Map<string, ExtensionFolder[]>()
  for (const entry of entries) {
    if (entry.extensionId) {
      byId.set(entry.extensionId, [...(byId.get(entry.extensionId) ?? []), entry])
    }
  }

  const resolved = new Map<string, string>()
  for (const [extensionId, claimants] of byId) {
    const locals = claimants.filter((entry) => isLocalFolder(entry.folder))
    let winner = claimants[0]
    if (locals.length === 1) {
      winner = locals[0]
    } else if (locals.length > 1) {
      const since = await appearedAt(locals.map((entry) => entry.folder))
      winner = [...locals].sort((a, b) => (since.get(a.folder) ?? 0) - (since.get(b.folder) ?? 0))[0]
    }
    winner.active = true
    resolved.set(extensionId, winner.folder)
    for (const loser of claimants) {
      if (loser !== winner) {
        loser.error = `${extensionId} is served by ${winner.folder}`
      }
    }
  }

  setResolvedFolders(resolved)
  return entries
}

/**
 * Scan the folders if this process has not yet, so `folderOf` knows which
 * folder stands in for an id. For a request that can arrive before anything
 * listed the extensions: without it a local copy would be ignored until the
 * first listing, and the registry build served in its place.
 */
export async function ensureFoldersScanned(): Promise<void> {
  if (!hasResolvedFolders()) {
    await scanExtensionFolders()
  }
}

/** Every extension id some folder serves, builtins first. */
export async function listAllExtensionIds(): Promise<string[]> {
  const entries = await scanExtensionFolders()
  return entries.flatMap((entry) => (entry.active && entry.extensionId ? [entry.extensionId] : []))
}

/**
 * Whether a folder name may be created by an install or the editor: an
 * extension id whose owner is not reserved, or a local one.
 */
export function isInstallableFolder(folder: string, { local }: { local: boolean }): boolean {
  const parsed = parseExtensionId(folder)
  if (!parsed) {
    return false
  }
  return local ? isLocalFolder(folder) : !isReservedOwner(parsed.owner)
}
