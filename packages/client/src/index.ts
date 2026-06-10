/**
 * `@opencroft/client` — the surface an extension's client (node/UI) code imports.
 *
 * Re-exports the shared contracts from `@opencroft/core` at the root, and the
 * full ported `@ext/host` + `@ext/ui` surface under `legacy` for migration. The
 * runtime is injected by the host; these are the type declarations.
 */
export * from '@opencroft/core'
export * as legacy from './legacy'
