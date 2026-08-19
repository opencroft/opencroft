'use client'

// The composer's face for the scoped selection (selection-context.tsx): a
// small pill left of the context ring showing the selection's label. Clicking
// the pill toggles whether the selection is passed with the next message; the
// X drops the selection entirely. Renders nothing when no provider is mounted
// or nothing is selected, so it can sit unconditionally in the composer slot.

import { X } from 'lucide-react'

import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import { cn } from '@/lib/utils'

export function SelectionBadge() {
  const scope = useOptionalSelection()
  if (!scope?.selection) {
    return null
  }
  const { selection, passEnabled, togglePass, clearSelection } = scope
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-48 shrink-0 items-center gap-0.5 rounded-full border pl-2 pr-1 transition-colors',
        passEnabled ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground',
      )}
    >
      <button
        type='button'
        onClick={togglePass}
        // The composer keeps focus when this is pressed — same courtesy the
        // command bar's own controls extend.
        onMouseDown={(e) => e.preventDefault()}
        title={
          passEnabled
            ? `"${selection.label}" is sent with the next message — click to hold it back`
            : `"${selection.label}" is held back — click to send it with the next message`
        }
        aria-pressed={passEnabled}
        className={cn(
          'min-w-0 truncate text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
          passEnabled ? '' : 'line-through',
        )}
      >
        {selection.label}
      </button>
      <button
        type='button'
        onClick={clearSelection}
        onMouseDown={(e) => e.preventDefault()}
        title='Clear selection'
        aria-label='Clear selection'
        className='inline-flex size-4 shrink-0 items-center justify-center rounded-full outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
      >
        <X className='size-3' />
      </button>
    </span>
  )
}
