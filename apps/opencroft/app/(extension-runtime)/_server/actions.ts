import { createServerFn } from '@tanstack/react-start'

import {
  activateLifecycleExtensions,
  ensureExtensionBuilt,
  extensionHasClient,
  getExtensionModule,
  loadAllManifests,
} from '@/app/(extension-runtime)/_server/loader'
import type { ExtensionManifestInfo } from '@/app/(extension-runtime)/_types'

// Plain (non-server-fn) implementation, callable directly from other server-side
// code that's already running server-side (e.g. the exec-context dispatcher) without
// going through another `createServerFn` layer. Nesting one `createServerFn` call
// inside another's handler is fragile — it depends on TanStack Start's request-scoped
// AsyncLocalStorage context propagating cleanly through the inner call, which doesn't
// always hold (see the exec-dispatch.ts caller for the concrete failure this caused).
// A future caller with NO request context at all (e.g. a background scheduler tick)
// couldn't use the server-fn wrapper regardless — only this plain function works there.
export async function invokeExtensionActionImpl(data: {
  extensionId: string
  actionName: string
  args: unknown[]
}): Promise<unknown> {
  const { extensionId, actionName, args } = data
  const mod = await getExtensionModule(extensionId)
  const fn = mod.actions[actionName]
  if (!fn) {
    throw new Error(`Extension ${extensionId} has no action "${actionName}"`)
  }
  return fn(...args)
}

// Client-callable wrapper — used when the caller is genuinely client-side code (see
// _client/host.ts) or a plain HTTP route handler, both of which need the real
// request/response round trip this provides.
export const invokeExtensionAction = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { extensionId: string; actionName: string; args: unknown[] }) => data)
  .handler(async ({ data }): Promise<unknown> => invokeExtensionActionImpl(data))

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
