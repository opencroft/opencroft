/**
 * `@opencroft/client/terminal` — terminals: the embeddable terminal, and
 * picking, showing and listing "node-id/handle-id" terminal targets.
 */
import type { TerminalConfig, TerminalProps } from '@opencroft/terminal/client'
import type { FC } from 'react'

export type { TerminalConfig, TerminalProps, TerminalStatus } from '@opencroft/terminal/client'

/** Embeddable xterm terminal connected to the host's terminal WebSocket. */
export declare const Terminal: FC<TerminalProps>

/**
 * A terminal-context value (what a `terminal-context` handle carries: local, wsl, ssh or
 * docker-exec) as the `connection` a `Terminal` opens, or null for none. A docker-exec context
 * opens its `shell`, else bash where the container has it and sh where it doesn't, as its `user`
 * and in its `cwd` when given.
 */
export declare const connectionFromContext: (value: Record<string, unknown> | undefined) => TerminalConfig | null

/** A node or App instance offering terminals, as `TerminalSelector`'s `exclude` is asked about it. */
export interface TerminalSourceOwner {
  /** The node id, or the App instance id. */
  id: string
  /** The node's stored, qualified type (`<owner>.<extension>.<type>`); `app:<type>` for an App instance. */
  type: string
}

export interface TerminalSelectorProps {
  /** "node-id/handle-id" of the selected terminal source, or '' for none. */
  value?: string
  onChange: (value: string) => void
  /**
   * Limit the choices to one space's terminals and the routes of its Terminal
   * Routers, the way that space reaches a terminal of another; omit to offer
   * every space's terminals and every router's routes.
   */
  spaceSlug?: string
  /**
   * Leave out the terminals of each source (a node or App instance) it answers
   * true for: the consumer's own rule, such as a Terminal Router leaving out
   * routes, which a route cannot point at.
   */
  exclude?: (source: TerminalSourceOwner) => boolean
  /** Offer an explicit "None" choice (reported as ''). */
  allowNone?: boolean
  placeholder?: string
  disabled?: boolean
}

/**
 * Pick one terminal-context SOURCE handle from the graph. The value is the
 * "node-id/handle-id" target string every terminal-taking host API accepts
 * (`terminal.getContext` on the server, the remote file tools). Every node
 * whose type declares a terminal is offered, each Terminal Router's routes
 * included, a route named by the terminal it reaches.
 */
export declare const TerminalSelector: FC<TerminalSelectorProps>

export interface TerminalRefProps {
  /** "node-id/handle-id" -- the form the TerminalSelector hands out. */
  target: string
  /**
   * Show where the terminal is, as Space › App › Terminal (App: the graph its
   * node is on, or the App offering it), shortened to Space › … › Terminal and
   * then Terminal as the width its container gives runs out; the full path is
   * on hover. For a terminal shown away from its context. Needs a container
   * that gives it a width (a flex row, a block), which it fills.
   */
  path?: boolean
  className?: string
}

/** A terminal target shown by its kind's icon and its one name, the same one the TerminalSelector lists. */
export declare const TerminalRef: FC<TerminalRefProps>

export interface TerminalListProps {
  /** "node-id/handle-id" targets, in the order to show them; `unavailable` for one that does not resolve now. */
  targets: Array<{ target: string; unavailable?: boolean }>
  /** The chosen target; its row carries the check. */
  value?: string
  onSelect?: (target: string) => void
  /** When given, every row can be removed: an X on the row and Remove in its context menu. */
  onRemove?: (target: string) => void
  disabled?: boolean
}

/**
 * Terminal targets you already hold, listed the way `TerminalSelector` lists
 * its choices: grouped by the node or App they belong to, each named as that
 * owner's terminal.
 */
export declare const TerminalList: FC<TerminalListProps>
