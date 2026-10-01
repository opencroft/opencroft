import type { ReactNode } from 'react'
import { cn } from 'cn'

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

export type ChainedAlign = 'first-line' | 'start'

// Distance from the segment top to the marker's top edge when it aligns to the
// first line: the content's top padding (py-2) plus half a line of body text,
// minus half the marker. --chained-leading overrides the line height for content
// whose first line is taller or shorter than the default, so this stays decoupled
// from the content's own font.
const FIRST_LINE_OFFSET = 'calc(0.5rem + var(--chained-leading, 1.5rem) / 2 - 0.25rem)'

export interface ChainedProps {
  // The marker rendered in the rail (e.g. a <ChainDot /> or an avatar).
  marker: ReactNode
  // Draw the connecting line above / below the marker (omit at the chain ends).
  lineAbove: boolean
  lineBelow: boolean
  // `first-line` (default) centres the marker on the first line of content; `start`
  // pins it to the segment's top edge (used for a large marker like an avatar).
  align?: ChainedAlign
  children: ReactNode
}

// One segment of a vertical chain: a left rail (connecting line + marker) beside
// the segment's content. Stack several to form a connected timeline. By default
// the marker centres on the first line of content, so on a tall segment it reads
// as labelling that first line rather than floating at the vertical middle.
export function Chained({ marker, lineAbove, lineBelow, align = 'first-line', children }: ChainedProps) {
  const top = align === 'start'
  return (
    <div className='flex min-h-8 min-w-0 gap-2'>
      <div className='flex flex-col items-center w-8 shrink-0'>
        {top ? (
          // start: no spacer -- the marker sits at the segment's top edge.
          <div className={cn('w-px', lineAbove && 'bg-secondary')} />
        ) : (
          // first-line: a fixed spacer pins the marker to the first line. The 1px
          // connecting line crosses behind the marker, which covers it, so the
          // rail still reads as one continuous line.
          <div className={cn('w-px shrink-0', lineAbove && 'bg-secondary')} style={{ height: FIRST_LINE_OFFSET }} />
        )}
        {/* `contents` generates no box, so the marker's containing block becomes
            the rail column rather than a wrapper sized to hug it. That matters
            for a marker that sticks: a sticky box cannot leave its containing
            block, so inside a hugging wrapper it has nowhere to travel and does
            nothing at all -- no error and no movement. The column stretches to
            the segment's height, which is the travel a marker needs. */}
        <div className='contents'>{marker}</div>
        <div className={cn('w-px flex-1', lineBelow && 'bg-secondary')} />
      </div>
      <div className='flex-1 min-w-0 py-2 self-start'>{children}</div>
    </div>
  )
}
