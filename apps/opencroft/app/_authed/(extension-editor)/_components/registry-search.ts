import type { ExtensionSearchResult } from 'ui/extensions/extension-search-results'

import type { ExtensionIndexEntry } from '@/app/_authed/(extension-editor)/_actions/extensions-index'
import type { RegistryExtension } from '@/app/_authed/(extension-runtime)/_server/registry'

export type RegistryHit = RegistryExtension & { registryName: string }

/** Two registries can list the same extension id, so a result is named by both. */
export function hitKey(hit: RegistryHit): string {
  return `${hit.registryName}/${hit.id}`
}

/**
 * The folder each installed repository went into. A result whose repository is
 * here is already on the instance: it is opened rather than offered again.
 */
export function installedFolders(installed: ExtensionIndexEntry[]): ReadonlyMap<string, string> {
  return new Map(installed.flatMap((entry) => (entry.sourceUrl ? [[entry.sourceUrl, entry.folder] as const] : [])))
}

/** What the search found, as the results list shows it, with the install under way when there is one. */
export function searchResults(
  hits: RegistryHit[],
  folders: ReadonlyMap<string, string>,
  installing: string | null,
): ExtensionSearchResult[] {
  return hits.map((hit) => ({
    id: hitKey(hit),
    name: hit.name,
    description: hit.description,
    source: hit.registryName,
    state: folders.has(hit.repository) ? 'installed' : installing === hitKey(hit) ? 'installing' : 'available',
  }))
}
