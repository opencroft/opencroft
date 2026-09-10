import { cn } from 'ui/lib/utils'

import { BRAND_ACCENT, Logo } from 'ui/components/ui/logo'

// The OpenCroft lockup: the mark beside the name.
//
// It draws the sibling mark rather than repeating its geometry, and takes the
// accent from the same place, so the colour of the filled square and the colour
// of the second half of the name cannot drift apart.
//
// NOTHING HERE NAMES A THEME COLOUR. The accent is fixed because it is part of
// the mark; everything else inherits, so the outline and "Open" take whatever
// text colour surrounds them and the lockup sits correctly on a light or a dark
// surface. The line under the two larger sizes is dimmed with opacity rather
// than given a muted colour token -- a token would tie this to one product's
// palette, which is the thing this project exists to avoid.

const MARK_SIZE = { large: 96, medium: 64, small: 24 }

// One string, one place. The two halves are a single word split by colour, so
// they are never authored as two labels that could drift apart.
function Name() {
  return (
    <>
      Open<span style={{ color: BRAND_ACCENT }}>Croft</span>
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
        <Logo size={MARK_SIZE.small} className='shrink-0' aria-hidden='true' />
        <span className='truncate'>
          <Name />
        </span>
      </span>
    )
  }

  const large = variant === 'large'
  return (
    <span className={cn('inline-flex min-w-0 items-center', large ? 'gap-2' : 'gap-1', className)}>
      <Logo size={large ? MARK_SIZE.large : MARK_SIZE.medium} className='shrink-0' aria-hidden='true' />
      <span className={cn('flex min-w-0 flex-col', large ? 'leading-[1.05]' : 'leading-[1.1]')}>
        <span className={cn('truncate font-bold tracking-[-0.03em]', large ? 'text-[2.6rem]' : 'text-[1.85rem]')}>
          <Name />
        </span>
        <span
          className={cn(
            'truncate font-medium uppercase opacity-70',
            large ? 'mt-[6px] text-[0.9rem] tracking-[0.1em]' : 'mt-[5px] text-[0.72rem] tracking-[0.06em]',
          )}
        >
          Infrastructure, Meet Intelligence
        </span>
      </span>
    </span>
  )
}
