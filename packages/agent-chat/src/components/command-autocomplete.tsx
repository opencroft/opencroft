'use client'

import type { AvailableCommand } from 'agent-client/types'
import { useEffect, useRef } from 'react'

import { cn } from 'ui/lib/utils'

/**
 * How a command is typed into the composer. A name the agent already spells
 * with a leading `$` is a mention the agent reads out of the prompt rather than
 * a slash command it intercepts -- behind a `/` it would reach the agent as
 * text naming nothing -- so it is typed as spelled; every other name is typed
 * behind `/`. The popup row and the inserted text both come from here, so what
 * a reader picks is what they were shown.
 */
export function commandInvocation(command: Pick<AvailableCommand, 'name'>): string {
  return command.name.startsWith('$') ? command.name : `/${command.name}`
}

/**
 * The composer text's command token, sigil included, or null when the text is
 * not a command being typed.
 *
 * "Being typed" is the whole first token and nothing after it: `/`, `/rev`,
 * `/review`, `$`, `$sk` all qualify; `/review src/` does not (the name is
 * settled, the reader is writing arguments), and neither does anything with a
 * newline or that starts with neither `/` nor `$`. Leading whitespace is
 * ignored the same way the engine's own command detection ignores it.
 */
export function commandToken(text: string): string | null {
  const lead = text.trimStart()
  return /^[/$]\S*$/.test(lead) ? lead : null
}

// The part of a name a reader types after the sigil.
function bareName(command: AvailableCommand): string {
  return command.name.replace(/^\$/, '').toLowerCase()
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
 *
 * `/` offers every command, the `$` ones included, so they can be found from
 * the key a reader already knows; `$` offers only those. A `$` with no such
 * command is not a command being typed at all -- `$5` is a price -- so it
 * answers null and leaves Enter to send.
 */
export function matchCommands(commands: readonly AvailableCommand[], text: string): AvailableCommand[] | null {
  const token = commandToken(text)
  if (token === null) {
    return null
  }
  const candidates = token.startsWith('$') ? commands.filter((command) => command.name.startsWith('$')) : commands
  if (candidates.length === 0) {
    return null
  }
  const lower = token.slice(1).toLowerCase()
  const prefixed = candidates.filter((command) => bareName(command).startsWith(lower))
  if (prefixed.length > 0) {
    return prefixed
  }
  // Prefix first, substring as the fallback — `/plan` should offer `plan`
  // before it offers `create_plan`, but typing a memorable middle still finds.
  return candidates.filter((command) => bareName(command).includes(lower))
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
 * The command popup: a list of agent-advertised commands over the
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
          <span className='shrink-0 font-mono'>{commandInvocation(command)}</span>
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
