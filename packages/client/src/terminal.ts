/**
 * `@opencroft/client/terminal` — terminals: the embeddable terminal, and
 * picking, showing and listing "node-id/handle-id" terminal targets.
 */
import type { TerminalProps } from '@opencroft/terminal/client'
import type { FC } from 'react'

export type { TerminalConfig, TerminalProps, TerminalStatus } from '@opencroft/terminal/client'

/** Embeddable xterm terminal connected to the host's terminal WebSocket. */
export declare const Terminal: FC<TerminalProps>

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
 * (`terminal.getContext` on the server, the remote file tools). Terminal
 * Router outputs are not offered: they only re-expose terminals the list
 * already has.
 */
export declare const TerminalSelector: FC<TerminalSelectorProps>

export interface TerminalRefProps {
  /** "node-id/handle-id" -- the form the TerminalSelector hands out. */
  target: string
  className?: string
}

/** A terminal target shown as its node's name plus which of its terminals it is. */
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
