import { declaredIconNames } from '@/app/_authed/(extension-runtime)/_declared-icons'
import {
  type ActionAccess,
  activateLifecycleExtensions,
  clientBundleVersion,
  clientIconNames,
  ensureExtensionBuilt,
  extensionHasClient,
  getExtensionModule,
  loadAllManifests,
} from '@/app/_authed/(extension-runtime)/_server/loader'
import { folderOf } from '@/app/_authed/(extension-runtime)/_server/paths'
import type { ExtensionClientInfo, ExtensionManifestInfo } from '@/app/_authed/(extension-runtime)/_types'

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

// The extension's declared authorization policy for one action, read from the
// same module `invokeExtensionActionImpl` dispatches through so the two cannot
// disagree about what an action is. Context-free like the impl above: the
// enforcement that consumes this (`requireAdminServerFn`) runs at the
// request-facing serverFn, the only layer with a request to identify the caller
// from. An action the extension does not list is 'signed-in' — the interim
// gate's behaviour, so adding this changes nothing until an action opts in.
export async function getActionAccess(extensionId: string, actionName: string): Promise<ActionAccess> {
  const mod = await getExtensionModule(extensionId)
  return mod.actionAccess?.[actionName] ?? 'signed-in'
}

// Every installed extension's full manifest, for server-side callers that
// don't run inside a TanStack Start request lifecycle — e.g. host.ts's getTerminalContext,
// called from an extension's Nitro HTTP route handler, which never establishes that
// context (see this module's own doc comment above for why the plain/server-fn split
// exists at all).
//
// Starts activating the lifecycle extensions (and reloading any whose sources
// changed) without waiting for it. Nothing this returns depends on it — the
// manifests, `hasClient` and the bundle version are read from disk — and a
// caller that needs an extension's module gets it from `getExtensionModule`,
// which joins an activation already in flight. Waiting would put a source
// freshness check per lifecycle extension in front of every listing, and the
// listing is on the path to every App page's first render. The trade, unless
// `rebuildStaleClients` is set: the first listing after a lifecycle
// extension's sources change can still carry its previous bundle version. That
// listing started the rebuild, so the next one carries the new version.
//
// `rebuildStaleClients` rebuilds a client bundle whose sources changed before
// its version is read, so the version names a current build. It is for the
// browser, which caches each bundle immutably under that version: without it,
// a browser holding the previous bundle would never ask again. An extension
// that fails to build is logged and listed with whatever it has.
export async function listExtensionManifestsImpl({
  rebuildStaleClients = false,
}: {
  rebuildStaleClients?: boolean
} = {}): Promise<ExtensionManifestInfo[]> {
  activateLifecycleExtensions().catch((err) => {
    console.error('[ext] lifecycle activation failed', err)
  })
  const manifests = await loadAllManifests()
  return Promise.all(
    manifests.map(async (manifest) => {
      const hasClient = await extensionHasClient(manifest.id)
      if (hasClient && rebuildStaleClients) {
        await ensureExtensionBuilt(manifest.id).catch((err) => {
          console.error(`[ext] ${manifest.id} client bundle not built`, err)
        })
      }
      return {
        ...manifest,
        folder: folderOf(manifest.id),
        hasClient,
        clientVersion: await clientBundleVersion(manifest.id),
        clientIcons: hasClient ? await clientIconNames(manifest.id) : [],
      }
    }),
  )
}

/** The extensions that ship a client bundle, as the browser imports them. */
export async function listExtensionClientsImpl(): Promise<ExtensionClientInfo[]> {
  const manifests = await listExtensionManifestsImpl({ rebuildStaleClients: true })
  return manifests
    .filter((manifest) => manifest.hasClient)
    .map(({ id, folder, clientVersion, clientIcons }) => ({ id, folder, clientVersion, clientIcons }))
}

/**
 * Every icon name the installed extensions' manifests declare: the set the
 * app's own chrome draws by name -- an app, a node type -- which the browser
 * loads before it is needed. The icons an extension's own code draws are
 * loaded with that extension instead (see `clientIcons`).
 */
export async function listDeclaredIconNamesImpl(): Promise<string[]> {
  const manifests = await loadAllManifests()
  return [...new Set(manifests.flatMap(declaredIconNames))]
}
