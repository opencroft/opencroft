import type { ReactNode } from 'react'
import { Flex } from 'ui/components/ui/layout/flex'
import { cn } from 'ui/lib/utils'

const DOT_COLORS = {
  default: 'bg-muted-foreground',
  success: 'bg-green-500',
  destructive: 'bg-destructive',
} as const

export type ChainDotVariant = keyof typeof DOT_COLORS

// A small status dot used as a chain marker (neutral / success / error).
export function ChainDot({ variant = 'default' }: { variant?: ChainDotVariant }) {
  return <div className={cn('size-2 rounded-full', DOT_COLORS[variant])} />
}

export type ChainedAlign = 'center' | 'start'

export interface ChainedProps {
  // The marker rendered in the rail (e.g. a <ChainDot /> or an avatar).
  marker: ReactNode
  // Draw the connecting line above / below the marker (omit at the chain ends).
  lineAbove: boolean
  lineBelow: boolean
  // Center the marker against the content, or pin it to the top.
  align?: ChainedAlign
  children: ReactNode
}

// One segment of a vertical chain: a left rail (connecting line + marker) beside
// the segment's content. Stack several to form a connected timeline.
export function Chained({ marker, lineAbove, lineBelow, align = 'center', children }: ChainedProps) {
  const top = align === 'start'
  return (
    <Flex row className='min-h-8 min-w-0 gap-2'>
      <Flex align='center' className='w-8 shrink-0'>
        <div className={cn('w-px', !top && 'flex-1', lineAbove && 'bg-secondary')} />
        <div className='shrink-0'>{marker}</div>
        <div className={cn('w-px flex-1', lineBelow && 'bg-secondary')} />
      </Flex>
      <div className={cn('flex-1 min-w-0 py-2', top ? 'self-start' : 'self-center')}>{children}</div>
    </Flex>
  )
}
