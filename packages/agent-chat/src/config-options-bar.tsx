'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { Flex } from 'ui/components/ui/layout/flex'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/components/ui/select'
import { Switch } from 'ui/components/ui/switch'

export interface ConfigOptionsBarProps {
  // The session's dynamically advertised config options — pass
  // `useAgentSession().configOptions` straight through. Adapters that don't
  // advertise any leave this empty; render nothing rather than a placeholder.
  options: SessionConfigOption[]
  onSetOption: (configId: string, value: string | boolean) => void
  // Context usage meter (tokens used / window). Omit, or omit `size` (or set
  // it <= 0), to hide the "/ window" portion — some adapters don't report one.
  usage?: { used: number; size?: number }
  // Option ids the host has pinned, mapped to the reason why — rendered inert
  // with the reason as its tooltip. A host locks an option when something
  // outside this session is holding it (e.g. a global switch that forces one
  // value); the wording is the host's, since only it knows what is doing the
  // holding. Refusing the interaction here is kinder than accepting it and
  // letting the value snap back a moment later.
  lockedOptions?: Record<string, string>
  className?: string
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`
  return String(n)
}

// A select option's values can be a flat list or grouped under labeled
// sections — flatten for a plain dropdown (group labels aren't shown; the
// values themselves are what matters for selection).
function flattenSelectOptions(options: unknown): Array<{ name: string; value: string }> {
  const flat: Array<{ name: string; value: string }> = []
  if (!Array.isArray(options)) {
    return flat
  }
  for (const entry of options as Array<Record<string, unknown>>) {
    if (Array.isArray(entry.options)) {
      flat.push(...(entry.options as Array<{ name: string; value: string }>))
    } else if (typeof entry.value === 'string' && typeof entry.name === 'string') {
      flat.push({ name: entry.name, value: entry.value })
    }
  }
  return flat
}

// Renders the session's agent-advertised config options (model, reasoning
// effort, mode, …) as select dropdowns / toggles, plus an optional context
// usage meter — meant to sit directly below the composer input. Selectors are
// built entirely from what this session advertises, never a hardcoded list:
// different adapters expose different options (and different value sets for
// the same option, e.g. an 'xhigh' effort some agents don't have).
export function ConfigOptionsBar({ options, onSetOption, usage, lockedOptions, className }: ConfigOptionsBarProps) {
  if (options.length === 0 && !usage) {
    return null
  }
  return (
    <Flex row align='center' className={className ?? 'flex-wrap gap-2 text-xs text-muted-foreground'}>
      {options.map((option) =>
        option.type === 'boolean' ? (
          <label
            key={option.id}
            htmlFor={`config-option-${option.id}`}
            className='flex items-center gap-1.5 cursor-pointer'
          >
            <Switch
              id={`config-option-${option.id}`}
              size='sm'
              checked={option.currentValue}
              disabled={Boolean(lockedOptions?.[option.id])}
              onCheckedChange={(checked) => onSetOption(option.id, checked)}
            />
            {option.name}
          </label>
        ) : (
          <Select
            key={option.id}
            value={option.currentValue}
            disabled={Boolean(lockedOptions?.[option.id])}
            // The trigger shows an entry's name, not its raw value.
            items={flattenSelectOptions(option.options).map((entry) => ({ value: entry.value, label: entry.name }))}
            // Base UI reports a cleared selection as `null`, which a fixed list
            // of advertised values never produces -- ignore it rather than
            // sending an empty value back to the agent.
            onValueChange={(value) => {
              if (value !== null) {
                onSetOption(option.id, value)
              }
            }}
          >
            <SelectTrigger size='sm' title={lockedOptions?.[option.id] ?? option.description ?? option.name}>
              <SelectValue placeholder={option.name} />
            </SelectTrigger>
            <SelectContent className='w-auto max-w-(--available-width) min-w-(--anchor-width)'>
              {flattenSelectOptions(option.options).map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ),
      )}
      {usage && (
        <span className='tabular-nums' title='Context: tokens in context / window'>
          {formatTokens(usage.used)}
          {usage.size && usage.size > 0 ? ` / ${formatTokens(usage.size)}` : ''} ctx
        </span>
      )}
    </Flex>
  )
}
