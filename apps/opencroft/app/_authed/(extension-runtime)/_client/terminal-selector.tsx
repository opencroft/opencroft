'use client'

import { useEffect, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/select'

import { listTerminalTargets, type TerminalTargetOption } from '@/app/_authed/(extension-runtime)/_server/actions'

const NONE = '__none__'

export interface TerminalSelectorProps {
  /** "node-id/handle-id" of the selected terminal source, or '' for none. */
  value?: string
  /** `option` is the picked choice as offered (its display title), absent for "None". */
  onChange: (value: string, option?: TerminalTargetOption) => void
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
  const [options, setOptions] = useState<TerminalTargetOption[]>([])

  useEffect(() => {
    listTerminalTargets({ data: { spaceSlug } })
      .then(setOptions)
      .catch(() => setOptions([]))
  }, [spaceSlug])

  // A previously saved target whose handle is gone (a stopped container, a
  // removed worktree) still has to render as the selection rather than as an
  // empty control that silently discards it on the next change.
  const known = options.some((option) => option.target === value)

  return (
    <Select
      value={value || (allowNone ? NONE : undefined)}
      onValueChange={(next) =>
        next === NONE
          ? onChange('')
          : onChange(
              next,
              options.find((option) => option.target === next),
            )
      }
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? 'Select a terminal'} />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>None</SelectItem>}
        {!known && value && <SelectItem value={value}>{value} (unavailable)</SelectItem>}
        {options.map((option) => (
          <SelectItem key={option.target} value={option.target}>
            {spaceSlug ? option.title : `${option.title} · ${option.spaceSlug}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
