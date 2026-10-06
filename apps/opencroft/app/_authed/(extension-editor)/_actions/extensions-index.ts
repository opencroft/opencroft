import { createServerFn } from '@tanstack/react-start'

import { readDirtyLocalFolders } from '@/app/_authed/(extension-editor)/_actions/local-extensions-actions-impl'
import { isBuiltinFolder, isLocalFolder } from '@/app/_authed/(extension-runtime)/_extension-id'
import { scanExtensionFolders } from '@/app/_authed/(extension-runtime)/_server/extension-folders'
import { ensureExtensionRows, listExtensionRows } from '@/app/_authed/(extension-runtime)/_server/extension-rows'
import { getManifest } from '@/app/_authed/(extension-runtime)/_server/loader'
import { requireSessionServerFn } from '@/app/_server/require-session'

/**
 * One row of the extensions list: what this instance has, and what to call it.
 *
 * Everything else an extension can be asked about — its files, the rest of its
 * checkout, what it is running, whether origin has moved — is read when one
 * extension is opened. This is the index, and it is the only thing the page
 * needs before it can draw.
 */
export interface ExtensionIndexEntry {
  /** The folder under `extensions/`: what is opened, edited and removed. */
  folder: string
  /** The extension id the folder runs under; null when its manifest claims one it may not use. */
  id: string | null
  name: string
  version: string
  /** A local extension is editable on this instance; an installed one is a copy of a repository, kept in step by updating it. */
  kind: 'local' | 'installed'
  /** Whether this folder serves its id. False for one whose id another folder serves, or that cannot run. */
  active: boolean
  /** Why the folder is not served, or why the install is broken. */
  error?: string
  /** A recorded install whose folder is gone. It can be reinstalled or removed. */
  missing?: true
  /**
   * A local extension whose own git checkout carries uncommitted changes. Absent
   * when the checkout is clean, and when the folder is not the root of its own
   * checkout, since then nothing is known about it.
   */
  dirty?: true
  /** The ref it was installed at, for one installed from a repository. */
  ref?: string
  /** The repository it came from. Carried so a registry search can mark what this instance already holds. */
  sourceUrl?: string
  registryName?: string
}

/**
 * The extensions this instance holds, from what the server already knows.
 *
 * `getManifest` reads the loader's manifest cache — re-read only when a
 * manifest's mtime moves — so this costs a directory listing, a stat per
 * extension, one table read, and a git status read per LOCAL extension only:
 * a local extension is edited in place on this instance, so whether it carries
 * uncommitted work is what the list has to show, while an installed one is a
 * snapshot nobody edits. A folder with no row gets one here, the first time it
 * is listed (see ensureExtensionRows).
 *
 * Called from the route's loader, so the list arrives with the document rather
 * than one round trip after the page has finished booting.
 */
export const listExtensionsIndex = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<ExtensionIndexEntry[]> => {
    // A server function is an HTTP endpoint of its own, so the route's own
    // guard does not cover it — this is what the manifest listing beside it
    // does, and what tells an unauthenticated caller nothing about what this
    // instance runs.
    await requireSessionServerFn()
    // Builtins are part of the product rather than something anyone installs,
    // edits or deletes — this page does not list them.
    const folders = (await scanExtensionFolders()).filter((entry) => !isBuiltinFolder(entry.folder))
    const rows = await ensureExtensionRows(folders.map((entry) => entry.folder))
    const dirtyFolders = await readDirtyLocalFolders(folders.map((entry) => entry.folder))
    const entries: ExtensionIndexEntry[] = []
    for (const entry of folders) {
      let name = entry.folder
      let version = '—'
      if (entry.active && entry.extensionId) {
        try {
          const manifest = await getManifest(entry.extensionId)
          name = manifest.name || entry.folder
          version = manifest.version
        } catch {
          // A manifest that cannot be read is still an extension on disk, and
          // leaving it out of the list is how it becomes impossible to delete.
        }
      }
      const row = rows.get(entry.folder)
      entries.push({
        folder: entry.folder,
        id: entry.extensionId,
        name,
        version,
        kind: isLocalFolder(entry.folder) ? 'local' : 'installed',
        active: entry.active,
        ...(entry.error ? { error: entry.error } : {}),
        ...(dirtyFolders.has(entry.folder) ? { dirty: true as const } : {}),
        ...(row?.ref ? { ref: row.ref } : {}),
        ...(row?.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
        ...(row?.registryName ? { registryName: row.registryName } : {}),
      })
    }
    const present = new Set(folders.map((entry) => entry.folder))
    for (const row of await listExtensionRows()) {
      if (present.has(row.folder)) {
        continue
      }
      entries.push({
        folder: row.folder,
        id: null,
        name: row.folder,
        version: '—',
        kind: isLocalFolder(row.folder) ? 'local' : 'installed',
        active: false,
        missing: true,
        error: 'The folder is missing: reinstall or remove it.',
        ...(row.ref ? { ref: row.ref } : {}),
        ...(row.sourceUrl ? { sourceUrl: row.sourceUrl } : {}),
        ...(row.registryName ? { registryName: row.registryName } : {}),
      })
    }
    return entries
  },
)
