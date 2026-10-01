import type { HTMLAttributes } from 'react'

import { cn } from 'cn'

export type StatusVariant = 'primary' | 'secondary' | 'muted' | 'accent' | 'success' | 'warning' | 'destructive'

// The colour is looked up, not composed.
//
// This used to be fourteen `group-[.<variant>]:bg-<token>` classes: a class
// name built from a prop, and an arbitrary variant selector on top of it.
// Whether such a class renders at all depends on the exact string turning up
// somewhere the Tailwind scanner reads -- and wherever this file is installed,
// it is not one of those places. The old classes worked only while some
// unrelated file in the same repository happened to spell the same selector,
// which is a colour that can go inert in a commit that never touches this
// component.
//
// A literal lookup is the kit's documented answer -- the same pattern as
// sticky-section and chain -- because every value below is a plain class string
// a scanner can see. It also removes the indirection: the colour no longer
// depends on a marker class on an ancestor matching a selector written on a
// descendant.
//
// The root keeps `group` and the variant name as classes so the rendered DOM is
// unchanged for anything already targeting them. They no longer decide the
// colour.
const VARIANT_BG: Record<StatusVariant, string> = {
  primary: 'bg-primary',
  secondary: 'bg-secondary',
  muted: 'bg-muted',
  accent: 'bg-accent',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
}

export interface StatusIndicatorProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'className'> {
  variant?: StatusVariant
  className?: string
}

export function StatusIndicator({ variant, className, ...props }: StatusIndicatorProps) {
  // No variant means no colour, exactly as before: an uncoloured dot rather
  // than a defaulted one, so a host that has nothing to report shows nothing.
  const bg = variant ? VARIANT_BG[variant] : undefined

  return (
    <span className={cn('relative flex h-2 w-2', 'group', variant, className)} {...props}>
      <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', bg)} />
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', bg)} />
    </span>
  )
}
