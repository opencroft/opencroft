import type { ComponentProps } from 'react'
import { ChevronLeft } from 'lucide-react'

import { Button } from '../button'
import { cn } from 'cn'

export interface BackButtonProps extends Omit<ComponentProps<typeof Button>, 'children' | 'size' | 'variant'> {
  /** What the control announces. Defaults to "Back", which is right nearly
   * everywhere; name the destination only where the glyph alone would be
   * ambiguous. The label is not drawn -- this control is the chevron. */
  label?: string
}

// The back affordance shared by every surface that nests inside another. It is
// a Button at ghost/icon rather than a hand-rolled element, so hover and focus
// are the kit's treatment and not this control's own opinion -- the thing that
// went wrong when three screens each wrote their own.
//
// Narrower than the primitive's icon size on purpose: this sits in a header row
// beside a title and that row's actions, not in a toolbar of its own.
export function BackButton({ label = 'Back', className, ...props }: BackButtonProps) {
  return (
    <Button
      type='button'
      variant='ghost'
      size='icon'
      aria-label={label}
      className={cn('size-7 shrink-0 text-muted-foreground', className)}
      {...props}
    >
      <ChevronLeft className='size-4' />
    </Button>
  )
}
