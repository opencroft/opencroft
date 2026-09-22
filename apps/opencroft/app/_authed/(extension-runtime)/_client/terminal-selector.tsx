'use client'

import { useEffect, useState } from 'react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/select'
import { Spinner } from 'ui/spinner'

import { TerminalRef } from '@/app/_authed/(extension-runtime)/_client/terminal-ref'
import { listTerminalTargets, type TerminalTargetOption } from '@/app/_authed/(extension-runtime)/_server/actions'

const NONE = '__none__'

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
  const [options, setOptions] = useState<TerminalTargetOption[]>([])
  // The list takes a while to fill: it asks every application node's docker
  // host what is running. Until it arrives the control says so rather than
  // looking like a picker with nothing in it.
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let current = true
    setLoading(true)
    listTerminalTargets({ data: { spaceSlug } })
      .then((next) => current && setOptions(next))
      .catch(() => current && setOptions([]))
      .finally(() => current && setLoading(false))
    return () => {
      current = false
    }
  }, [spaceSlug])

  // A previously saved target whose handle is gone (a stopped container, a
  // removed worktree) still has to render as the selection rather than as an
  // empty control that silently discards it on the next change. While the
  // list is loading it is simply not known yet -- not "unavailable".
  const known = options.some((option) => option.target === value)

  return (
    <Select
      value={value || (allowNone ? NONE : undefined)}
      onValueChange={(next) => onChange(next === NONE ? '' : next)}
      disabled={disabled}
    >
      <SelectTrigger aria-busy={loading}>
        <SelectValue
          placeholder={
            loading ? (
              <>
                <Spinner />
                Loading terminals…
              </>
            ) : (
              (placeholder ?? 'Select a terminal')
            )
          }
        />
      </SelectTrigger>
      <SelectContent>
        {allowNone && <SelectItem value={NONE}>None</SelectItem>}
        {!known && value && (
          <SelectItem value={value}>
            <TerminalRef target={value} />
            {loading ? null : ' (unavailable)'}
          </SelectItem>
        )}
        {options.map((option) => (
          <SelectItem key={option.target} value={option.target}>
            {spaceSlug ? option.title : `${option.title} · ${option.spaceSlug}`}
          </SelectItem>
        ))}
        {loading ? (
          <div className='flex items-center gap-2 px-2 py-1.5 text-sm text-muted-foreground'>
            <Spinner />
            Loading terminals…
          </div>
        ) : options.length === 0 ? (
          <div className='px-2 py-1.5 text-sm text-muted-foreground'>No terminals found</div>
        ) : null}
      </SelectContent>
    </Select>
  )
}
