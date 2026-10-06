'use client'

import { MessagesSquare } from 'lucide-react'
import type * as React from 'react'

import { Button } from 'ui/components/ui/button'
import { CountBadge } from 'ui/components/ui/count-badge'
import { cn } from 'cn'

export interface ChatLauncherProps extends Omit<React.ComponentProps<'button'>, 'children'> {
  /** How many of the chat's threads are waiting on someone -- a permission to
   * grant or a question to answer. Drawn on the button's corner while above
   * zero; the host decides what counts. */
  waitingCount?: number
}

// The closed chat as ONE round button: the primary fill and the chat mark, and
// the count of threads waiting on someone overlaid on its corner -- the same
// corner badge the background-task control wears, in red, because a thread
// that waits is asking for a person rather than reporting progress. Scaled up
// a step with the button, and centred on the circle's edge rather than the
// box's corner, so it reads as attached to the round shape; the ring in the
// page's background colour parts it from the fill it overlaps.
//
// Where the launcher sits is the host's: it passes the placement through
// `className`, since a corner of the viewport is a page decision.
export function ChatLauncher({ waitingCount = 0, className, ...props }: ChatLauncherProps) {
  const label = waitingCount > 0 ? `Open chat, ${waitingCount} waiting` : 'Open chat'
  return (
    <Button
      type='button'
      size='icon'
      aria-label={label}
      title={label}
      className={cn('relative size-14 rounded-full shadow-lg', className)}
      {...props}
    >
      <MessagesSquare className='size-6' />
      <CountBadge count={waitingCount} tone='destructive' size='default' />
    </Button>
  )
}
