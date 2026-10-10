/**
 * `@opencroft/client/extension` — declaring an extension's client half, and
 * the extension's own identity and URLs.
 */
import type { ComponentType } from 'react'

import type { AppDefinition } from './app'
import type { CommandModeDefinition, ExtensionHandleType, NodeDefinition } from './canvas'
import type { AgentChatInputControl, AgentChatStatusIndicator } from './chat'
import type { MarkdownResolver } from './markdown'

export interface ExtensionDeclarationManifest {
  /**
   * @deprecated The runtime supplies the extension's id when it loads the
   * bundle, and files everything the bundle declares under that. Leave it out;
   * a different value is ignored, with a console warning.
   */
  id?: string
  name?: string
  version?: string
  description?: string
}

export interface SettingsPageDefinition {
  id: string
  label: string
  icon?: string
  component: ComponentType
}

/** An entry of the `right-sidebar-panels` provider point: a tab of the panel host on the right of the application shell. */
export interface RightSidebarPanel {
  id: string
  label: string
  /** Lucide icon name; falls back to a placeholder when absent or unknown. */
  icon?: string
  component: ComponentType
}

/**
 * The provider points the host reads: each key is a point, each entry one
 * contribution to it. Declaring an entry is all it takes; nothing else is
 * registered. The host imports a client bundle only on the surfaces whose
 * points it provides.
 */
export interface ProvidedPoints {
  /**
   * Apps a person can add to a space. Each entry is the client half of an App
   * also declared, with the same bare `type`, under `provides.apps` in
   * `extension.json`, which the server reads before any bundle loads.
   */
  apps?: AppDefinition[]
  /** Identifiers recognised in every `Markdown` and `MarkdownEditor` the host renders. */
  markdownResolvers?: MarkdownResolver[]
  /** Tabs of the panel host on the right of the application shell. */
  'right-sidebar-panels'?: RightSidebarPanel[]
  /** Controls beside the agent chat's composer. */
  'agent-chat-input-controls'?: AgentChatInputControl[]
  /** Components at the foot of the agent chat's message list. */
  'agent-chat-status-indicators'?: AgentChatStatusIndicator[]
}

export interface ExtensionDeclaration {
  manifest: ExtensionDeclarationManifest
  /** The handle types this extension declares, bare. */
  handleTypes?: ExtensionHandleType[]
  /** @deprecated Declare `handleTypes`. Read only when `handleTypes` is absent. */
  contexts?: ExtensionHandleType[]
  // Each node declares its own data type, and a definition is invariant in it
  // (its components read the data and its inspector writes it), so no one data
  // type admits a list of them.
  // biome-ignore lint/suspicious/noExplicitAny: a list of nodes each typed on its own data
  nodes?: NodeDefinition<any>[]
  commandModes?: CommandModeDefinition[]
  settings?: SettingsPageDefinition[]
  /**
   * What the extension contributes to the host's provider points, typed for
   * the points in `ProvidedPoints`. Any other key is a point some other code
   * reads; the host stores its entries without looking at them.
   */
  provides?: ProvidedPoints & Record<string, unknown[]>
}

/**
 * The client bundle's declaration, exported as its default. Throws when it
 * declares nothing: no node, command mode, settings page or provided entry.
 */
export declare const defineExtension: (decl: ExtensionDeclaration) => ExtensionDeclaration

/** The extension's own id, `<owner>.<extension>`. Never hard-code it. */
export declare const extensionId: string

/**
 * Where the host serves this extension: `/api/ext/<extensionId>`. Extensions
 * never build their own URLs — use this, `assetUrl`, `routeUrl` and
 * `absoluteUrl`.
 */
export declare const urlBase: string

/** The URL of a static file under the extension's `assets/` folder. */
export declare const assetUrl: (path: string) => string

/** The URL of one of the extension's declared HTTP `routes`. */
export declare const routeUrl: (path: string) => string

/**
 * An instance-relative URL (`urlBase`, or what `assetUrl` / `routeUrl` return)
 * in absolute form, resolved against the page's origin — for a link handed
 * outside the instance. Defaults to `urlBase`.
 */
export declare const absoluteUrl: (url?: string) => string
