import type {
  ExtensionClientModules,
  ExtensionHostApi,
  extensionUiApi,
} from '@/app/_authed/(extension-runtime)/_client/host'

/**
 * The API objects the browser hands extension bundles: `__extHost.modules`
 * behind `@opencroft/client/<module>`, and the deprecated flat `__extHost.host`
 * and `__extHost.ui` behind `@ext/host` and `@ext/ui`.
 */
export interface ClientHostApi {
  host: ExtensionHostApi
  ui: typeof extensionUiApi
  modules: ExtensionClientModules
}

// What the server knows about the browser's extension API is read off the
// objects themselves, never restated: the shims a build emits, and the stand-in
// a bundle's provider points are read against, both have to match them.
//
// Loaded on demand rather than imported statically, for two reasons. The module
// is the client host, which reaches the app's server actions and from there
// back into the extension compiler, so a static import would close an import
// cycle. It also pulls in the app's whole component tree, which a server that
// never needs it should not pay for. One load serves the whole process.
let clientHostApi: Promise<ClientHostApi> | null = null

export function loadClientHostApi(): Promise<ClientHostApi> {
  clientHostApi ??= import('@/app/_authed/(extension-runtime)/_client/host')
    .then((host) => ({ host: host.extensionHostApi, ui: host.extensionUiApi, modules: host.extensionClientModules }))
    // A rejected promise caches as readily as a resolved one, which would turn
    // one transient failure into every later caller failing with no way back.
    // Dropping the reference costs the next caller a reload.
    .catch((error: unknown) => {
      clientHostApi = null
      throw error
    })
  return clientHostApi
}
