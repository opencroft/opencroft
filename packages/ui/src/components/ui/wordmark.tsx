import type { SVGProps } from 'react'

import { cn } from 'ui/lib/utils'

// The OpenCroft lockup: the "Croft Plot" mark beside the name.
//
// THE ACCENT IS STATED OUTRIGHT rather than read from a theme token, and that
// is the whole design decision in this file. A two-tone lockup is the mark; it
// is not a surface treatment. Reading the host's accent would repaint the logo
// differently on every surface it appears on, and against a neutral palette it
// repaints it into near-invisibility -- a wordmark that disappears on half the
// product is not a variant, it is a broken mark.
//
// Everything that is NOT the accent inherits instead of naming a colour, so the
// outline and the first half of the name take the surface's own text colour and
// one component sits correctly on a light or a dark background. That split --
// the accent fixed, the rest inherited -- is what removes the need for a second
// variant per theme.
//
// THE GEOMETRY IS A COPY, and the seam is worth stating because nothing
// enforces it. This same mark is drawn by the loading indicator in this
// project, and again in the marketing site's own kit. Referencing across design
// projects would tie this product's kit to the site's, which is the wrong
// direction for a dependency to run, so each draws its own. If the mark is ever
// redrawn, every copy has to be walked by hand -- nothing here will fail to say
// so.
const ACCENT = '#3b82f6'

// Decorative: every size renders the name as text beside it, so announcing the
// mark as well would read the product's name twice.
function Mark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' aria-hidden='true' {...props}>
      <rect x='4' y='4' width='7' height='7' rx='1.8' stroke='currentColor' strokeWidth='1.5' />
      <rect x='13' y='4' width='7' height='7' rx='1.8' stroke='currentColor' strokeWidth='1.5' />
      <rect x='4' y='13' width='7' height='7' rx='1.8' stroke='currentColor' strokeWidth='1.5' />
      <rect x='13' y='13' width='7' height='7' rx='1.8' fill={ACCENT} />
    </svg>
  )
}

// One string, one place. The two halves are a single word split by colour, so
// they are never authored as two labels that could drift apart.
function Name() {
  return (
    <>
      Open<span style={{ color: ACCENT }}>Croft</span>
    </>
  )
}

export interface WordmarkProps {
  /** How much of the lockup to draw. `small` is the mark and the name; the two
   *  larger sizes add the line beneath it. */
  variant?: 'large' | 'medium' | 'small'
  className?: string
}

export function Wordmark({ variant = 'small', className }: WordmarkProps) {
  // The header size. The mark holds its width and the name gives way, because a
  // sidebar narrows and a lockup that wrapped onto two lines would stop being
  // one.
  if (variant === 'small') {
    return (
      <span className={cn('inline-flex min-w-0 items-center gap-1.5 font-bold', className)}>
        <Mark className='h-6 w-6 shrink-0' />
        <span className='truncate'>
          <Name />
        </span>
      </span>
    )
  }

  const large = variant === 'large'
  return (
    <span className={cn('inline-flex min-w-0 items-center', large ? 'gap-2' : 'gap-1', className)}>
      <Mark className={cn('shrink-0', large ? 'h-24 w-24' : 'h-16 w-16')} />
      <span className={cn('flex min-w-0 flex-col', large ? 'leading-[1.05]' : 'leading-[1.1]')}>
        <span className={cn('truncate font-bold tracking-[-0.03em]', large ? 'text-[2.6rem]' : 'text-[1.85rem]')}>
          <Name />
        </span>
        <span
          className={cn(
            'truncate font-medium uppercase text-muted-foreground',
            large ? 'mt-[6px] text-[0.9rem] tracking-[0.1em]' : 'mt-[5px] text-[0.72rem] tracking-[0.06em]',
          )}
        >
          Infrastructure, Meet Intelligence
        </span>
      </span>
    </span>
  )
}
