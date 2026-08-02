import {
  activateLifecycleExtensions,
  clientBundleVersion,
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
//
// Kept in its own module, separate from actions.ts's createServerFn exports, and
// never imported by client-side code (see exec-dispatch.ts). TanStack's server-fn
// client-build code splitting only elides a *handler body*, not a shared file's own
// top-level imports — a plain export living alongside createServerFn exports keeps
// their imports "live" for the client bundle too. That let loader.ts's eager
// compiler.ts import (tailwindcss/lightningcss native bindings) leak into the client
// dependency graph and broke the production build.
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

// Plain (non-server-fn) implementation of listExtensionManifests, for callers that
// don't run inside a TanStack Start request lifecycle — e.g. host.ts's getTerminalContext,
// called from an extension's Nitro HTTP route handler, which never establishes that
// context (see this module's own doc comment above for why the plain/server-fn split
// exists at all).
export async function listExtensionManifestsImpl(): Promise<ExtensionManifestInfo[]> {
  await activateLifecycleExtensions()
  const manifests = await loadAllManifests()
  return Promise.all(
    manifests.map(async (manifest) => ({
      ...manifest,
      hasClient: await extensionHasClient(manifest.id),
      clientVersion: await clientBundleVersion(manifest.id),
    })),
  )
}
