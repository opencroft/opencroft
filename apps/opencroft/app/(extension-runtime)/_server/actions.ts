import { createServerFn } from '@tanstack/react-start'

import {
  activateLifecycleExtensions,
  ensureExtensionBuilt,
  extensionHasClient,
  getExtensionModule,
  loadAllManifests,
} from '@/app/(extension-runtime)/_server/loader'
import type { ExtensionManifestInfo } from '@/app/(extension-runtime)/_types'

export const invokeExtensionAction = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; actionName: string; args: unknown[] }) => data)
  .handler(async ({ data }): Promise<unknown> => {
    const { extensionId, actionName, args } = data
    const mod = await getExtensionModule(extensionId)
    const fn = mod.actions[actionName]
    if (!fn) {
      throw new Error(`Extension ${extensionId} has no action "${actionName}"`)
    }
    return fn(...args)
  })

export const listExtensionManifests = createServerFn({ strict: { output: false } }).handler(
  async (): Promise<ExtensionManifestInfo[]> => {
    await activateLifecycleExtensions()
    const manifests = await loadAllManifests()
    return Promise.all(
      manifests.map(async (manifest) => ({ ...manifest, hasClient: await extensionHasClient(manifest.id) })),
    )
  },
)

export const rebuildExtension = createServerFn({ method: 'POST' })
  .inputValidator((extensionId: string) => extensionId)
  .handler(async ({ data: extensionId }): Promise<void> => {
    await ensureExtensionBuilt(extensionId)
  })
