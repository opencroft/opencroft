'use client'

import { type ReactNode, useEffect, useRef } from 'react'

import { cn } from 'cn'

export type ComposerSuggestionsSide = 'top' | 'bottom'

const SIDE_CLASS: Record<ComposerSuggestionsSide, string> = {
  top: 'bottom-full mb-1',
  bottom: 'top-full mt-1',
}

export interface ComposerSuggestionsProps<T> {
  // What the list offers, named for assistive technology: "Commands", "Mentions".
  label: string
  items: readonly T[]
  // A key unique within `items`.
  itemKey: (item: T) => string
  // What one row shows. Rendered inside the row's button, which lays its
  // children out in a baseline-aligned row; an element with no text baseline
  // (an avatar) centres itself with `self-center`.
  renderItem: (item: T) => ReactNode
  activeIndex: number
  // Mouse selection. Keyboard selection lives in the composer's own keydown
  // handler (it owns the focus), which is why there is no key handling here.
  onSelect: (item: T) => void
  onHover: (index: number) => void
  // Which side of its containing box the list opens on: above it, as over a
  // composer at the foot of a chat (the default), or below it, as under the
  // line being typed in a document.
  side?: ComposerSuggestionsSide
}

/**
 * The popup the composer opens over itself while something is being typed
 * that it can complete: a command after `/`, a person after `@`. One list for
 * every kind, so they open in the same place, move under the same keys and
 * read as one kind of thing; the markdown editor opens the same list under
 * its caret for a mention. Pure presentation — which items, which is active
 * and what selecting does are the composer's; this draws them and reports
 * clicks.
 */
export function ComposerSuggestions<T>({
  label,
  items,
  itemKey,
  renderItem,
  activeIndex,
  onSelect,
  onHover,
  side = 'top',
}: ComposerSuggestionsProps<T>) {
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
      aria-label={label}
      className={cn(
        'absolute inset-x-0 z-20 max-h-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md',
        SIDE_CLASS[side],
      )}
    >
      {items.map((item, index) => (
        <button
          key={itemKey(item)}
          ref={index === activeIndex ? activeRef : undefined}
          type='button'
          role='option'
          aria-selected={index === activeIndex}
          // Mousedown, and prevented, so choosing a row never blurs the
          // composer — the reader is mid-typing and the caret must stay put.
          onMouseDown={(event) => {
            event.preventDefault()
            onSelect(item)
          }}
          onMouseEnter={() => onHover(index)}
          className={cn(
            'flex w-full min-w-0 items-baseline gap-2 rounded-sm px-2 py-1 text-left text-sm',
            index === activeIndex && 'bg-accent text-accent-foreground',
          )}
        >
          {renderItem(item)}
        </button>
      ))}
    </div>
  )
}
