import type { LucideIcon } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { cn } from 'ui/lib/utils'

export interface MarkdownBlockMenuItem {
  id: string
  label: string
  icon: LucideIcon
}

export interface MarkdownBlockMenuProps {
  items: readonly MarkdownBlockMenuItem[]
  activeIndex: number
  // Mouse selection. Keyboard selection is the editor's: it owns the focus, so
  // arrows and Enter are handled where the typing is.
  onSelect: (index: number) => void
  onHover: (index: number) => void
}

/**
 * The blocks a `/` typed on an empty line can insert, as a list under the
 * caret. The same rows as the chat composer's command popup, so the two read
 * as one kind of thing. Pure presentation: which items, which is active and
 * where the list sits are the editor's.
 */
export function MarkdownBlockMenu({ items, activeIndex, onSelect, onHover }: MarkdownBlockMenuProps) {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  // Keep the keyboard-active row visible as arrows move it; 'nearest' so mouse
  // scrolling isn't yanked back when the index hasn't left the viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the index is the trigger -- the ref it moves is read, not depended on
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (items.length === 0) {
    return null
  }
  return (
    <div
      role='listbox'
      aria-label='Blocks'
      className='max-h-64 w-56 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md'
    >
      {items.map((item, index) => {
        const Icon = item.icon
        return (
          <button
            key={item.id}
            ref={index === activeIndex ? activeRef : undefined}
            type='button'
            role='option'
            aria-selected={index === activeIndex}
            // Mousedown, and prevented, so choosing a block never blurs the
            // editor -- the caret must stay where the block goes.
            onMouseDown={(event) => {
              event.preventDefault()
              onSelect(index)
            }}
            onMouseEnter={() => onHover(index)}
            className={cn(
              'flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-sm',
              index === activeIndex && 'bg-accent text-accent-foreground',
            )}
          >
            <Icon className='size-4 shrink-0 text-muted-foreground' aria-hidden />
            <span className='truncate'>{item.label}</span>
          </button>
        )
      })}
    </div>
  )
}
