import { promises as fs } from 'node:fs'
import path from 'node:path'

import { createServerFn } from '@tanstack/react-start'

import { dirMtime, listSourceFiles } from '@/app/_authed/(extension-editor)/_actions/extension-files'
import { isBuiltinFolder, isLocalFolder } from '@/app/_authed/(extension-runtime)/_extension-id'
import { MANIFEST_FILE, scanExtensionFolders } from '@/app/_authed/(extension-runtime)/_server/extension-folders'
import {
  type ExtensionRow,
  getExtensionRow,
  type InstallAuth,
} from '@/app/_authed/(extension-runtime)/_server/extension-rows'
import {
  checkForUpdates,
  installFromUrl,
  type UpdateCheck,
  uninstallExtension as uninstallExtensionFolder,
  updateExtension,
} from '@/app/_authed/(extension-runtime)/_server/install'
import { manifestForDisplay } from '@/app/_authed/(extension-runtime)/_server/manifest'
import { folderDir } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { ExtensionManifest } from '@/app/_authed/(extension-runtime)/_types'

export type { InstallAuth, UpdateCheck }

/** Where an installed extension came from, as its row records it. */
export interface InstalledSourceInfo {
  url: string
  registryName: string | null
  ref: string | null
  commit: string | null
  /** When the extension first appeared on this instance, epoch ms. */
  installedAt: number
}

/**
 * An extension installed from a repository into its own folder: read-only on
 * this instance, and changed only by updating it from its source.
 */
export interface InstalledExtensionRecord {
  /** The extension id: for an installed extension, its folder name. */
  id: string
  folder: string
  manifest: ExtensionManifest
  source: InstalledSourceInfo | null
  files: Record<string, string>
  updatedAt: number
}

function sourceInfo(row: ExtensionRow | null): InstalledSourceInfo | null {
  if (!row?.sourceUrl) {
    return null
  }
  return {
    url: row.sourceUrl,
    registryName: row.registryName,
    ref: row.ref,
    commit: row.commit,
    installedAt: row.createdAt.getTime(),
  }
}

async function readRecord(folder: string): Promise<InstalledExtensionRecord | null> {
  if (isLocalFolder(folder) || isBuiltinFolder(folder)) {
    return null
  }
  const dir = folderDir(folder)
  let declared: ExtensionManifest
  try {
    declared = JSON.parse(await fs.readFile(path.join(dir, MANIFEST_FILE), 'utf-8')) as ExtensionManifest
  } catch {
    return null
  }
  return {
    id: folder,
    folder,
    manifest: manifestForDisplay(declared, folder),
    source: sourceInfo(await getExtensionRow(folder)),
    files: await listSourceFiles(dir),
    updatedAt: await dirMtime(dir),
  }
}

async function requireRecord(folder: string): Promise<InstalledExtensionRecord> {
  const record = await readRecord(folder)
  if (!record) {
    throw new Error(`Failed to read ${folder} after installing it`)
  }
  return record
}

/**
 * Install from a repository URL or `owner/repo`. The extension id is
 * `<owner>.<repo>` from the URL, or `id` when given (required for a URL whose
 * path is not exactly owner/repo). With `asLocal` it becomes a development
 * checkout in `local.<repo>` instead, standing in for the extension its
 * manifest names.
 */
export const installExtensionFromUrl = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((input: { url: string; id?: string; ref?: string; auth?: InstallAuth; asLocal?: boolean }) => input)
  .handler(async ({ data: input }): Promise<{ folder: string }> => {
    const row = await installFromUrl(input)
    return { folder: row.folder }
  })

export const listInstalledExtensions = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<InstalledExtensionRecord[]> => {
    const records: InstalledExtensionRecord[] = []
    for (const entry of await scanExtensionFolders()) {
      const record = await readRecord(entry.folder)
      if (record) {
        records.push(record)
      }
    }
    return records
  },
)

// One installed extension with its files, for the page that opens it.
export const getInstalledExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((folder: string) => folder)
  .handler(async ({ data: folder }): Promise<InstalledExtensionRecord | null> => readRecord(folder))

export const updateInstalledExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { folder: string; ref?: string }) => data)
  .handler(async ({ data }): Promise<InstalledExtensionRecord> => {
    await updateExtension(data.folder, data.ref)
    return requireRecord(data.folder)
  })

/** Remove any non-builtin extension folder, then its row. Nodes and apps using it are kept. */
export const uninstallExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((folder: string) => folder)
  .handler(async ({ data: folder }): Promise<void> => uninstallExtensionFolder(folder))

export const checkInstalledForUpdates = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((folder: string) => folder)
  .handler(async ({ data: folder }): Promise<UpdateCheck> => checkForUpdates(folder))
