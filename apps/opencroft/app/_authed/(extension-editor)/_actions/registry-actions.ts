import { createServerFn } from '@tanstack/react-start'

import { installFromRegistry } from '@/app/_authed/(extension-runtime)/_server/install'
import type { RegistryExtension, ResolvedRegistry } from '@/app/_authed/(extension-runtime)/_server/registry'
import { fetchAllRegistries, searchRegistries } from '@/app/_authed/(extension-runtime)/_server/registry'

export const listRegistryExtensions = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((query?: string) => query)
  .handler(async ({ data: query }): Promise<(RegistryExtension & { registryName: string })[]> => {
    return searchRegistries(query)
  })

/**
 * Install the extension a registry lists under `extensionId`, into the folder of
 * that id — or with `asLocal` as a development checkout in `local.<extension>`.
 */
export const installRegistryExtension = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; ref?: string; asLocal?: boolean }) => data)
  .handler(async ({ data }): Promise<{ folder: string }> => {
    const row = await installFromRegistry(data.extensionId, { ref: data.ref, asLocal: data.asLocal })
    return { folder: row.folder }
  })

export const getRegistries = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<ResolvedRegistry[]> => {
    return fetchAllRegistries()
  },
)

export const refreshRegistries = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<ResolvedRegistry[]> => {
    return fetchAllRegistries(true)
  },
)
