import { createServerFn } from '@tanstack/react-start'

import { readSidecar } from '@/app/_authed/(extension-editor)/_actions/extension-checkout'
import { getManifest } from '@/app/_authed/(extension-runtime)/_server/loader'
import { listAllExtensionIds } from '@/app/_authed/(extension-runtime)/_server/manifest'
import { extDir } from '@/app/_authed/(extension-runtime)/_server/paths'
import { requireSessionServerFn } from '@/app/_server/require-session'

/**
 * One row of the extensions list: what this instance has, and what to call it.
 *
 * Everything else an extension can be asked about — its files, its checkout,
 * what it is running, whether origin has moved — is read when one extension is
 * opened. This is the index, and it is the only thing the page needs before it
 * can draw.
 */
export interface ExtensionIndexEntry {
  id: string
  slug: string
  name: string
  version: string
  /** A local extension is a checkout on this instance; an installed one is a
   *  copy of a repository, kept in step by reinstalling it. */
  kind: 'local' | 'installed'
  /** For an installed extension: the ref it was installed at. */
  ref?: string
  /** For an installed extension: the repository it came from. Carried so a
   *  registry search can mark what this instance already holds. */
  sourceUrl?: string
}

/**
 * The extensions this instance holds, from what the server already knows.
 *
 * `getManifest` reads the loader's manifest cache — the same one every
 * extension surface in the product resolves through, populated as the instance
 * starts and re-read only when a manifest's mtime moves. So this costs a
 * directory listing and a stat per extension, and no git at all.
 *
 * It exists because the list used to be built from full records: every file of
 * every extension, then a `git status`, a `rev-parse` and a branch read each,
 * for a panel that draws names. That work still happens — for the one
 * extension somebody opens.
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
    const ids = await listAllExtensionIds()
    const entries: ExtensionIndexEntry[] = []
    for (const id of ids) {
      const [scope, slug] = id.split('/')
      // Builtins are part of the product rather than something anyone installs,
      // edits or deletes — this page has never listed them.
      if ((scope !== 'local' && scope !== 'installed') || !slug) {
        continue
      }
      let name: string
      let version: string
      try {
        const manifest = await getManifest(id)
        name = manifest.name || slug
        version = manifest.version
      } catch {
        // A manifest that cannot be read is still an extension on disk, and
        // leaving it out of the list is how it becomes impossible to delete.
        name = slug
        version = '—'
      }
      const sidecar = scope === 'installed' ? await readSidecar(extDir(id)) : null
      entries.push({
        id,
        slug,
        name,
        version,
        kind: scope,
        ref: sidecar?.ref,
        sourceUrl: sidecar?.source.url,
      })
    }
    return entries
  },
)
