/**
 * `@opencroft/client` — the surface an extension's client (node/UI) code
 * imports. The runtime is injected by the host; these are the type
 * declarations.
 *
 * It is organised in modules, each its own entry (`@opencroft/client/canvas`,
 * `@opencroft/client/markdown`, …). The root re-exports every module and the
 * shared contracts of `@opencroft/core`.
 */
import * as legacyApi from './legacy'

export * from '@opencroft/core'

export * from './actions'
export * from './app'
export * from './canvas'
// `@opencroft/core` declares a `Handle` contract too. The root's `Handle` is
// the canvas component, which is what the root serves at run time; the
// contract stays importable from `@opencroft/core`.
export { Handle } from './canvas'
export * from './chat'
export * from './code'
export * from './docker'
export * from './extension'
export * from './files'
export * from './graph'
export * from './markdown'
export * from './secrets'
export * from './storage'
export * from './streams'
export * from './terminal'
export * from './ui'
export * from './values'
export {
  /**
   * @deprecated The whole `@ext/host` + `@ext/ui` surface in one namespace.
   * Import each name from its module instead (`@opencroft/client/canvas`, …);
   * each member's own deprecation names its module.
   */
  legacyApi as legacy,
}
