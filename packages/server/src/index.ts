/**
 * `@opencroft/server` — the surface an extension's server module imports. The
 * runtime is injected by the host; these are the type declarations.
 *
 * It is organised in modules, each its own entry (`@opencroft/server/graph`,
 * `@opencroft/server/storage`, …). The root re-exports every module, the
 * shared contracts of `@opencroft/core`, and the whole host as its default
 * export.
 */
import * as legacyApi from './legacy'

export * from '@opencroft/core'

export * from './actions'
export * from './apps'
export * from './chat'
export * from './collab'
export * from './events'
export * from './extension'
export * from './graph'
export type { ExtensionServerHost } from './host'
export { default } from './host'
export * from './lifecycle'
export * from './people'
export * from './routes'
export * from './secrets'
export * from './settings'
export * from './storage'
export * from './system'
export * from './terminal'
export * from './tools'
export {
  /**
   * @deprecated The host's whole surface in one namespace. Import each name
   * from its module instead (`@opencroft/server/graph`, …); each member's own
   * deprecation names its module.
   */
  legacyApi as legacy,
}
