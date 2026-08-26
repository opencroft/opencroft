'use client'

import { Flex, type FlexProps } from 'ui/components/ui/layout/flex'
import { cn } from 'ui/lib/utils'

export type StickySide = 'top' | 'bottom' | 'left' | 'right'
export type StickyVariant = 'primary' | 'secondary' | 'background' | 'ghost'

export interface StickySectionProps extends FlexProps {
  side?: StickySide
  fade?: boolean
  variant?: StickyVariant
}

const SIDE_CLASSES: Record<StickySide, string> = {
  top: 'top-0 pb-0 w-full',
  bottom: 'bottom-0 pt-0 w-full',
  left: 'left-0 pr-0 h-full',
  right: 'right-0 pl-0 h-full',
}

const FADE_CLASSES: Record<StickySide, string> = {
  top: 'inset-x-0 h-full top-0 bg-linear-to-b to-transparent from-background',
  bottom: 'inset-x-0 h-full bottom-0 bg-linear-to-t to-transparent from-background',
  left: 'inset-y-0 w-full left-0 bg-linear-to-r to-transparent from-background',
  right: 'inset-y-0 w-full right-0 bg-linear-to-l to-transparent from-background',
}

const VARIANT_CLASSES: Record<StickyVariant, string> = {
  primary: 'bg-primary text-primary-foreground rounded-xl shadow-lg p-1 gap-1',
  secondary: 'bg-secondary text-secondary-foreground rounded-xl shadow-lg p-1 gap-1',
  background: 'bg-background rounded-xl shadow-lg p-1 gap-1',
  ghost: '',
}

const isHorizontal = (side: StickySide) => side === 'left' || side === 'right'

// A header or footer that stays pinned to one edge of a scrolling ancestor
// while its own content scrolls behind it -- the fade is what sells the
// overlay: without it the edge where scrolled content meets the sticky one is
// a hard, visible seam rather than a soft handoff.
export function StickySection({
  side = 'top',
  fade,
  variant = 'ghost',
  className,
  children,
  ...props
}: StickySectionProps) {
  const horizontal = isHorizontal(side)
  const content =
    variant !== 'ghost' ? (
      <Flex row={!horizontal} className={VARIANT_CLASSES[variant]}>
        {children}
      </Flex>
    ) : (
      children
    )

  return (
    <Flex row={horizontal} withSpacing className={cn('sticky z-1', SIDE_CLASSES[side], className)} {...props}>
      {fade && <div className={cn('absolute pointer-events-none -z-1', FADE_CLASSES[side])} />}
      {content}
    </Flex>
  )
}
