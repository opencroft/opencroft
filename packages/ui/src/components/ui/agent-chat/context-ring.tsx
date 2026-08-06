'use client'

import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export interface ContextRingProps {
  // Tokens currently in the agent's context.
  used: number
  // The session's context window. The ring reads as empty (0%) when this is 0
  // or unset -- some adapters do not report a window.
  size: number
  className?: string
}

// "12.0k" / "200k" -- the same compact token formatting the rest of the chat
// uses, so the tooltip matches what the conversation surfaces elsewhere.
function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`
  return String(n)
}

// A circular context-usage indicator for an agent chat: the fraction of the
// window in use drawn as a ring, the integer percentage written in the centre,
// and the exact token counts on hover. Read-only -- it shows a value the host
// already holds, it does not decide one.
//
// Wraps its own TooltipProvider so it works anywhere: the app does not mount a
// global one, and the indicator is small enough that a local provider is
// cheaper than a host having to remember to wrap it.
export function ContextRing({ used, size, className }: ContextRingProps) {
  const ratio = size > 0 ? Math.min(1, used / size) : 0
  const pct = Math.round(ratio * 100)
  const radius = 9
  const circumference = 2 * Math.PI * radius
  const dash = circumference * ratio
  const label =
    size > 0 ? `${formatTokens(used)} / ${formatTokens(size)} ctx` : `${formatTokens(used)} ctx`

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role='progressbar'
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label='Context usage'
            className={cn('relative inline-flex size-7 items-center justify-center', className)}
          >
            <svg className='absolute inset-0 size-7 -rotate-90' viewBox='0 0 24 24'>
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
            <span className='relative tabular-nums text-muted-foreground' style={{ fontSize: 10 }}>
              {pct}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
