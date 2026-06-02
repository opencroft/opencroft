import { createServerFn } from '@tanstack/react-start'

import { type InstalledExtensionRecord, installExtensionFromUrl } from '@/app/(extension-editor)/_actions/installed-extensions-actions'
import type { RegistryExtension, ResolvedRegistry } from '@/app/(extension-runtime)/_server/registry'
import { fetchAllRegistries, resolveExtensionRepo, searchRegistries } from '@/app/(extension-runtime)/_server/registry'

export const listRegistryExtensions = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((query?: string) => query)
  .handler(async ({ data: query }): Promise<(RegistryExtension & { registryName: string })[]> => {
    return searchRegistries(query)
  })

export const installRegistryExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; ref?: string }) => data)
  .handler(async ({ data }): Promise<InstalledExtensionRecord> => {
    const { extensionId, ref } = data
    const resolved = await resolveExtensionRepo({ id: extensionId })
    if (!resolved) {
      throw new Error(`Extension "${extensionId}" not found in any registry`)
    }
    return installExtensionFromUrl({ data: { url: resolved.repository, ref, auth: resolved.auth } })
  })

export const getRegistries = createServerFn({ strict: { output: false } }).handler(async (): Promise<ResolvedRegistry[]> => {
  return fetchAllRegistries()
})

export const refreshRegistries = createServerFn({ strict: { output: false } }).handler(async (): Promise<ResolvedRegistry[]> => {
  return fetchAllRegistries(true)
})
