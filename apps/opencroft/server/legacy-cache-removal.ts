import { rm, stat } from 'node:fs/promises'

import { cacheDir } from '@/server/cache'

/**
 * Cache folders written by builds that had the legacy dashboard: its Key Store
 * keys, its generated SSH config and its Application nodes' files. Nothing in
 * this build reads or writes them. `key-store` is not one of them: the Key
 * Store node's cache files are copied into the database from there.
 */
export const LEGACY_CACHE_FOLDERS = ['ssh-keys', 'ssh-config', 'apps'] as const

/** Deletes the legacy dashboard's cache folders; answers the ones that were there. */
export async function removeLegacyCacheFolders(): Promise<string[]> {
  const removed: string[] = []
  for (const folder of LEGACY_CACHE_FOLDERS) {
    const dir = cacheDir(folder)
    const present = await stat(dir).then(
      () => true,
      () => false,
    )
    if (present) {
      await rm(dir, { recursive: true, force: true })
      removed.push(folder)
    }
  }
  return removed
}
