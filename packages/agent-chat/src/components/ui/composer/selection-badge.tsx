'use client'

import { X } from 'lucide-react'

import { cn } from 'ui/lib/utils'

export interface SelectionBadgeProps {
  // What the reader sees. Presentation only: what the message actually carries
  // is the host's business and deliberately not this component's -- a label
  // reads like "3 commits" or a heading, while what travels may be pages.
  label: string
  // Whether the selection goes with the next message. Positive form on
  // purpose -- the pill states what will happen, not what will not.
  included: boolean
  // A press on the pill: hold the selection back, or send it again. The
  // selection itself survives either way; only this flag moves.
  onToggleIncluded: () => void
  // The X: drop the selection entirely. Distinct from holding it back, which
  // is why the two are separate controls rather than one three-state press.
  onClear: () => void
  className?: string
}

// What the reader has selected somewhere else on the screen, shown in the
// composer so it is visible that the next message will carry it.
//
// TWO CONTROLS, NOT ONE. Holding a selection back and discarding it are
// different intentions -- the first is about this message, the second about the
// selection -- and a single control cycling through both would make the
// destructive one reachable by a press meant for the reversible one.
//
// The held-back state is struck through as well as dimmed, so it differs from
// the active one in shape and not by colour alone.
//
// Presentational throughout: it holds no selection, stores no flag and phrases
// nothing about what the agent receives.
export function SelectionBadge({ label, included, onToggleIncluded, onClear, className }: SelectionBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex h-6 max-w-48 shrink-0 items-center gap-0.5 rounded-full border pl-2 pr-1 transition-colors',
        included ? 'border-primary/40 bg-primary/10 text-foreground' : 'border-border text-muted-foreground',
        className,
      )}
    >
      <button
        type='button'
        onClick={onToggleIncluded}
        // The composer keeps focus when this is pressed -- losing it
        // mid-sentence to a control beside the box is its own small betrayal.
        onMouseDown={(event) => event.preventDefault()}
        aria-pressed={included}
        title={
          included
            ? `"${label}" is sent with the next message — press to hold it back`
            : `"${label}" is held back — press to send it with the next message`
        }
        className={cn(
          'min-w-0 truncate text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring',
          included ? '' : 'line-through',
        )}
      >
        {label}
      </button>
      <button
        type='button'
        onClick={onClear}
        onMouseDown={(event) => event.preventDefault()}
        title='Clear selection'
        aria-label='Clear selection'
        className='inline-flex size-4 shrink-0 items-center justify-center rounded-full outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
      >
        <X className='size-3' />
      </button>
    </span>
  )
}
