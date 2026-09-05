/**
 * `@opencroft/client` — the surface an extension's client (node/UI) code imports.
 *
 * Re-exports the shared contracts from `@opencroft/core` at the root, and the
 * full ported `@ext/host` + `@ext/ui` surface under `legacy` for migration. The
 * runtime is injected by the host; these are the type declarations.
 */
import type { AppEntry } from '@opencroft/core'
import type { TerminalProps } from '@opencroft/terminal/client'
import type { ComponentType, FC } from 'react'

export * from '@opencroft/core'
export type { TerminalConfig, TerminalProps, TerminalStatus } from '@opencroft/terminal/client'

export * as legacy from './legacy'

/** Embeddable xterm terminal connected to the host's terminal WebSocket. */
export declare const Terminal: FC<TerminalProps>

export interface SecretSelectorProps {
  /** `<storeId>/<key>` of the selected secret, or '' for none. */
  value?: string
  onChange: (value: string) => void
  /** Offer an explicit "None" choice (reported as ''). */
  allowNone?: boolean
  placeholder?: string
  disabled?: boolean
}

/**
 * Pick one secret KEY from the host's Secrets Stores. Only the key's address
 * (`<storeId>/<key>`) crosses the component — never the value; resolve it
 * server-side with `host.secrets.get(storeId, key)`.
 */
export declare const SecretSelector: FC<SecretSelectorProps>

export interface TerminalSelectorProps {
  /** "node-id/handle-id" of the selected terminal source, or '' for none. */
  value?: string
  onChange: (value: string) => void
  /** Limit the choices to one space's nodes; omit to offer every space. */
  spaceSlug?: string
  /** Offer an explicit "None" choice (reported as ''). */
  allowNone?: boolean
  placeholder?: string
  disabled?: boolean
}

/**
 * Pick one terminal-context SOURCE handle from the graph. The value is the
 * "node-id/handle-id" target string every terminal-taking host API accepts
 * (`host.terminal.getContext`, the remote file tools).
 */
export declare const TerminalSelector: FC<TerminalSelectorProps>

/** Props the host passes to an App's component when rendering it in a space. */
export interface AppComponentProps {
  /** Which added instance is being rendered — matches the server hooks' `instanceId`. */
  instanceId: string
  spaceSlug: string
  /** The parameter values the user entered when adding the App, keyed by parameter id. */
  params: Record<string, string>
}

/**
 * Props the host passes to an App's custom parameter form. The form is
 * CONTROLLED: it renders `params` and reports every change through
 * `onChange`; the host owns the dialog, the submit button, and persistence.
 */
export interface AppFormProps {
  /** The space the instance is being added to (or lives in, when editing). */
  spaceSlug: string
  params: Record<string, string>
  onChange: (params: Record<string, string>) => void
}

/**
 * The client half of an App: the manifest's `provides.apps` entry plus the
 * React component. Declared under the same `apps` point in the client
 * `provides` of `defineExtension`, mirroring how dashboards register theirs.
 */
export interface AppDefinition extends AppEntry {
  component: ComponentType<AppComponentProps>
  /**
   * Custom parameter form, replacing the host's generic one (which renders a
   * text input per declared manifest parameter). Declared `required`
   * parameters are still validated by the host on save.
   */
  form?: ComponentType<AppFormProps>
}
