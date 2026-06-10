/**
 * `@opencroft/server` — the surface an extension's server module imports.
 *
 * Re-exports the shared contracts from `@opencroft/core`, the curated host API
 * (default `host` plus named `fs`, `exec`, `terminal`, `ssh`, …), and the same
 * host surface under `legacy` for the `opencroft.legacy.*` migration namespace.
 * The runtime is injected by the host; these are the type declarations.
 */
export * from '@opencroft/core'
export * from './host'
export * as legacy from './host'
export { default } from './host'
export * from './lifecycle'
