'use client'

import type { AvailableCommand } from 'agent-client/types'
import { useEffect, useRef } from 'react'

import { cn } from 'ui/lib/utils'

/**
 * The composer text's command token, or null when the text is not a command
 * being typed.
 *
 * "Being typed" is the whole first token and nothing after it: `/`, `/rev`,
 * `/review` all qualify; `/review src/` does not (the name is settled, the
 * reader is writing arguments), and neither does anything with a newline or
 * that doesn't start with `/`. Leading whitespace is ignored the same way the
 * engine's own command detection ignores it.
 */
export function commandToken(text: string): string | null {
  const lead = text.trimStart()
  return /^\/\S*$/.test(lead) ? lead.slice(1) : null
}

/**
 * The commands the popup offers for the composer's current text, or null when
 * the popup should not be open at all.
 *
 * Null and [] are different answers on purpose: null means the text is not a
 * command being typed (nothing to offer, nothing to intercept keys for), []
 * means it is one but nothing matches — the popup hides in both cases, but a
 * caller deciding whether Enter selects-or-sends needs the distinction to
 * collapse to "no visible choices" in one place, here.
 */
export function matchCommands(commands: readonly AvailableCommand[], text: string): AvailableCommand[] | null {
  const token = commandToken(text)
  if (token === null || commands.length === 0) {
    return null
  }
  const lower = token.toLowerCase()
  const prefixed = commands.filter((command) => command.name.toLowerCase().startsWith(lower))
  if (prefixed.length > 0) {
    return prefixed
  }
  // Prefix first, substring as the fallback — `/plan` should offer `plan`
  // before it offers `create_plan`, but typing a memorable middle still finds.
  return commands.filter((command) => command.name.toLowerCase().includes(lower))
}

export interface CommandAutocompleteProps {
  items: readonly AvailableCommand[]
  activeIndex: number
  // Mouse selection. Keyboard selection lives in the composer's own keydown
  // handler (it owns the focus), which is why there is no key handling here.
  onSelect: (command: AvailableCommand) => void
  onHover: (index: number) => void
}

/**
 * The slash-command popup: a list of agent-advertised commands over the
 * composer. Pure presentation — which commands, which is active and what
 * selecting does are the composer's; this draws them and reports clicks.
 */
export function CommandAutocomplete({ items, activeIndex, onSelect, onHover }: CommandAutocompleteProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  // Keep the keyboard-active row visible as arrows move it; 'nearest' so mouse
  // scrolling isn't yanked back when the index hasn't left the viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeIndex is the trigger, not an input -- the body reads the ref it moves
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (items.length === 0) {
    return null
  }
  return (
    <div
      role='listbox'
      aria-label='Commands'
      className='absolute inset-x-0 bottom-full z-20 mb-1 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md'
    >
      {items.map((command, index) => (
        <button
          key={command.name}
          ref={index === activeIndex ? activeRef : undefined}
          type='button'
          role='option'
          aria-selected={index === activeIndex}
          // Mousedown, and prevented, so choosing a command never blurs the
          // composer — the reader is mid-typing and the caret must stay put.
          onMouseDown={(event) => {
            event.preventDefault()
            onSelect(command)
          }}
          onMouseEnter={() => onHover(index)}
          className={cn(
            'flex w-full min-w-0 items-baseline gap-2 rounded-sm px-2 py-1 text-left text-sm',
            index === activeIndex && 'bg-accent text-accent-foreground',
          )}
        >
          <span className='shrink-0 font-mono'>/{command.name}</span>
          {command.input?.hint ? (
            <span className='shrink-0 font-mono text-xs text-muted-foreground'>{command.input.hint}</span>
          ) : null}
          {command.description ? (
            <span className='min-w-0 flex-1 truncate text-xs text-muted-foreground'>{command.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}
