/**
 * `@opencroft/client` — the surface an extension's client (node/UI) code imports.
 *
 * Re-exports the shared contracts from `@opencroft/core` at the root, and the
 * full ported `@ext/host` + `@ext/ui` surface under `legacy` for migration. The
 * runtime is injected by the host; these are the type declarations.
 */
import type { TerminalProps } from '@opencroft/terminal/client'
import type { FC } from 'react'

export * from '@opencroft/core'
export type { TerminalConfig, TerminalProps, TerminalStatus } from '@opencroft/terminal/client'

export * as legacy from './legacy'

/** Embeddable xterm terminal connected to the host's terminal WebSocket. */
export declare const Terminal: FC<TerminalProps>
