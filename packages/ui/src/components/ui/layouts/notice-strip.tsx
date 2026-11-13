import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import type React from 'react'

import { Button } from '../button'
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '../popover'
import { cn } from 'cn'

export type NoticeStripTone = 'info' | 'warning' | 'destructive'

export interface NoticeStripProps {
  /** How much the notice asks of the reader: info only tells, warning wants attention, destructive says something is wrong. */
  tone?: NoticeStripTone
  /** Replaces the tone's own icon. */
  icon?: React.ElementType
  /**
   * The short sentence the strip shows. It stays on one line: wider than the
   * strip, it truncates, and the details title repeats it whole.
   */
  children: React.ReactNode
  /** The full explanation, behind the Details control. Omitted, the strip is the sentence alone. */
  details?: React.ReactNode
  /** The Details control's label. */
  detailsLabel?: string
  className?: string
}

const TONE_CLASS: Record<NoticeStripTone, string> = {
  info: 'bg-muted',
  warning: 'border-warning/30 bg-warning/10',
  destructive: 'border-destructive/30 bg-destructive/10',
}

const ICON_CLASS: Record<NoticeStripTone, string> = {
  info: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
}

const TONE_ICON: Record<NoticeStripTone, React.ElementType> = {
  info: Info,
  warning: TriangleAlert,
  destructive: CircleAlert,
}

// A line across the top of a page about the page's situation, not its
// content: the host places it above everything else the page holds. It is
// one line at every width -- the sentence gives way, the Details control
// never does -- so the full text is reachable on a phone as on a desktop.
// The details open in a popover rather than unfolding below, so opening
// them never moves the page underneath.
export function NoticeStrip({
  tone = 'info',
  icon,
  children,
  details,
  detailsLabel = 'Details',
  className,
}: NoticeStripProps) {
  const Icon = icon ?? TONE_ICON[tone]
  return (
    <div
      data-slot='notice-strip'
      data-tone={tone}
      className={cn(
        'flex h-9 w-full min-w-0 shrink-0 items-center gap-2 border-b px-3 text-sm',
        TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className={cn('size-4 shrink-0', ICON_CLASS[tone])} aria-hidden='true' />
      <p className='min-w-0 flex-1 truncate'>{children}</p>
      {details == null ? null : (
        <Popover>
          <PopoverTrigger render={<Button variant='ghost' size='xs' className='shrink-0 pointer-coarse:h-8' />}>
            {detailsLabel}
          </PopoverTrigger>
          {/* The explanation may carry a path or other long unbroken words,
              so it wraps anywhere rather than widening the popover. */}
          <PopoverContent align='end' className='w-[min(28rem,calc(100vw-1rem))]'>
            <PopoverHeader>
              <PopoverTitle>{children}</PopoverTitle>
              <PopoverDescription render={<div />} className='[overflow-wrap:anywhere]'>
                {details}
              </PopoverDescription>
            </PopoverHeader>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}
