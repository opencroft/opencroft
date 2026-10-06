'use client'

import { TerminalPicker } from 'ui/nodes/terminal-list'

import { TerminalRef } from '@/app/_authed/(extension-runtime)/_client/terminal-ref'
import { useTerminalSources } from '@/app/_authed/(extension-runtime)/_client/terminal-sources'

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
 * Pick one terminal-context source handle from the graph, as the
 * "node-id/handle-id" target string every terminal-taking action accepts.
 * Also exposed to extension client code via `@opencroft/client`.
 */
export function TerminalSelector({
  value,
  onChange,
  spaceSlug,
  allowNone,
  placeholder,
  disabled,
}: TerminalSelectorProps) {
  const { sources, loading } = useTerminalSources(spaceSlug)
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
      // worktree -- is still shown by its owner's name rather than its id.
      renderMissing={(target) => <TerminalRef target={target} />}
    />
  )
}
