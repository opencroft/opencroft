'use client'

import { TerminalList as KitTerminalList } from 'ui/nodes/terminal-list'

import { useTargetSources } from '@/app/_authed/(extension-runtime)/_client/terminal-sources'

export interface TerminalListProps {
  /**
   * "node-id/handle-id" targets, in the order to show them; `unavailable` for
   * one that does not resolve now. One no source lists is marked as well.
   */
  targets: Array<{ target: string; unavailable?: boolean }>
  /** The chosen target; its row carries the check. */
  value?: string
  onSelect?: (target: string) => void
  /** When given, every row can be removed. */
  onRemove?: (target: string) => void
  disabled?: boolean
}

/**
 * Terminal targets a host already holds -- a router's routes -- listed the way
 * the TerminalSelector lists them: grouped by the node or App they belong to,
 * each named as its owner's terminal.
 * Also exposed to extension client code via `@opencroft/client`.
 */
export function TerminalList({ targets, value, onSelect, onRemove, disabled }: TerminalListProps) {
  const { sources, loading } = useTargetSources(targets)
  return (
    <KitTerminalList
      sources={sources}
      loading={loading}
      value={value}
      onSelect={onSelect}
      onRemove={onRemove}
      disabled={disabled}
      // Picked one by one, so there are few; a search would only add a field.
      searchable={false}
    />
  )
}
