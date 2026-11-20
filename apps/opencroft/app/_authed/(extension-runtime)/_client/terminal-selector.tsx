'use client'

import { TerminalPicker } from 'ui/nodes/terminal-list'

import { TerminalRef } from '@/app/_authed/(extension-runtime)/_client/terminal-ref'
import {
  type TerminalSourceOwner,
  useTerminalSources,
} from '@/app/_authed/(extension-runtime)/_client/terminal-sources'

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
 * Pick one terminal-context source handle from the graph, as the
 * "node-id/handle-id" target string every terminal-taking action accepts.
 * Also exposed to extension client code via `@opencroft/client`.
 */
export function TerminalSelector({
  value,
  onChange,
  spaceSlug,
  exclude,
  allowNone,
  placeholder,
  disabled,
}: TerminalSelectorProps) {
  const { sources, loading } = useTerminalSources(spaceSlug, exclude)
  return (
    <TerminalPicker
      sources={sources}
      loading={loading}
      value={value ?? ''}
      onValueChange={onChange}
      allowNone={allowNone}
      placeholder={placeholder}
      disabled={disabled}
      // A saved target no source lists -- a stopped container, a removed
      // worktree -- is still shown by its name and place rather than its id.
      renderMissing={(target) => <TerminalRef target={target} path />}
    />
  )
}
