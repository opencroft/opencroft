/**
 * `@opencroft/client/graph` — graph references (nodes, App instances and
 * terminal targets) shown and described by name rather than by id.
 */
import type { FC } from 'react'

export interface NodeRefProps {
  /** A graph node id, or an App instance's id / `<space>.<app-slug>` address. */
  nodeId: string
  /** Text after the name, e.g. which of the node's handles is meant. */
  detail?: string
  className?: string
}

/**
 * A node (or App instance) shown by its icon and name instead of its id,
 * resolved across every space; the raw id stays on hover.
 */
export declare const NodeRef: FC<NodeRefProps>

/** A graph reference as `NodeRef` / `TerminalRef` show it. */
export interface GraphRefDescription {
  kind: 'node' | 'app'
  /** The name its owner gave it, else its type's name. */
  name: string
  /** For a terminal target: which of the node's terminals, when that needs saying. */
  detail?: string
  /** Lucide icon name of its type. */
  icon?: string
  accent?: string
  /** The node type's name, or `App`. */
  typeName: string
  spaceSlug: string
  /** For an App instance: its slug, unique in its space; `/space/<spaceSlug>/app/<slug>` opens it. */
  slug?: string
  /** For an App instance: its address, `<spaceSlug>.<slug>`. */
  address?: string
}

/**
 * The data behind `NodeRef` and `TerminalRef`: node ids, App instance ids or
 * `<space>.<app-slug>` addresses, and "node-id/handle-id" terminal targets,
 * each described across every space, or null when nothing answers to it.
 * Everything asked for in the same tick, by any caller, is one request, and
 * answers are shared with those components.
 */
export declare const describeGraphRefs: (refs: string[]) => Promise<Record<string, GraphRefDescription | null>>

/** Called whenever the graph changed, so a description read before may be stale. */
export declare const subscribeGraphRefs: (listener: () => void) => () => void
