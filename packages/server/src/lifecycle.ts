/**
 * Server-only lifecycle contracts. The host calls `load` when an extension is
 * activated and `unload` when it is torn down, passing the same
 * {@link ExtensionContext} to both. During `load` the extension registers the
 * types and nodes it contributes. These run on the server bundle only.
 */
import type { Node, Type } from '@opencroft/core'

/** Runtime context handed to an extension's lifecycle hooks. Grows over time. */
export interface ExtensionContext {
  /** Fully-qualified id of the extension, e.g. `local/git`. */
  extensionId: string
  /** Register a connection type that node handles can reference. */
  registerType(type: Type): void
  /** Register a node contributed by this extension. */
  registerNode(node: Node): void
}

/** Lifecycle hook invoked when the extension is activated. */
export type Load = (context: ExtensionContext) => void | Promise<void>

/** Lifecycle hook invoked when the extension is torn down. */
export type Unload = (context: ExtensionContext) => void | Promise<void>
