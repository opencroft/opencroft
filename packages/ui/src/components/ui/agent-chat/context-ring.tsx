'use client'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

export interface ContextRingProps {
  // Tokens consumed so far.
  used: number
  // The context window's total size. Not every adapter reports one -- when it
  // is 0 or unset the ring reads as 0% and the popover falls back to the used
  // count alone, rather than showing a fraction of a window nobody knows. So a
  // 0% ring means "no window reported", not "nothing used"; the popover is what
  // distinguishes them.
  size: number
  className?: string
}

// Compact token counts -- 18k, 200k -- matching how the chat formats tokens
// elsewhere, so the same number does not appear in two shapes on one screen.
// Below 1000 the exact figure is shown; at 100k and above the decimal is
// dropped, since a tenth of a k is noise at that magnitude.
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`
  return String(n)
}

// A circular context-usage indicator for an agent chat: the fraction of the
// window in use drawn as a ring, the integer percentage written in the centre,
// and the exact token counts in a popover on press. Read-only -- it shows a
// value the host already holds, it does not decide one.
//
// A popover (not a tooltip): a tooltip is hover/focus-transient, so on touch it
// flashes and closes the moment the pointer leaves. A popover opens on press and
// stays open until dismissed -- which is what a tap should do -- and works the
// same with a mouse click. aria-label carries the counts too.
export function ContextRing({ used, size, className }: ContextRingProps) {
  const ratio = size > 0 ? Math.min(1, used / size) : 0
  const pct = Math.round(ratio * 100)
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const dash = circumference * ratio
  const label =
    size > 0 ? `${formatTokens(used)} / ${formatTokens(size)} ctx` : `${formatTokens(used)} ctx`

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label={`Context usage: ${label}`}
          className={cn(
            'relative inline-flex size-7 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
        >
          <svg className='pointer-events-none absolute inset-0 size-7 -rotate-90' viewBox='0 0 24 24'>
            <circle cx='12' cy='12' r={radius} fill='none' strokeWidth='2.5' style={{ stroke: 'var(--border)' }} />
            <circle
              cx='12'
              cy='12'
              r={radius}
              fill='none'
              strokeWidth='2.5'
              strokeLinecap='round'
              strokeDasharray={`${dash} ${circumference - dash}`}
              style={{ stroke: 'var(--primary)' }}
            />
          </svg>
          <span className='pointer-events-none relative tabular-nums text-muted-foreground' style={{ fontSize: 10 }}>
            {pct}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' side='top' className='text-xs'>
        {label}
      </PopoverContent>
    </Popover>
  )
}
