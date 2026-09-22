'use client'

import { MessagesSquare } from 'lucide-react'
import type * as React from 'react'

import { Button } from 'ui/components/ui/button'
import { cn } from 'ui/lib/utils'

export interface ChatLauncherProps extends Omit<React.ComponentProps<'button'>, 'children'> {
  /** How many of the chat's threads are waiting on someone -- a permission to
   * grant or a question to answer. Drawn on the button's corner while above
   * zero; the host decides what counts. */
  waitingCount?: number
}

// The closed chat as ONE round button: the primary fill and the chat mark, and
// the count of threads waiting on someone overlaid on its corner -- the same
// corner badge the delegated-work control wears, in red, because a thread
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
      {waitingCount > 0 ? (
        <span
          aria-hidden
          className='absolute -top-0.5 -right-0.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-xs font-medium leading-none text-white ring-2 ring-background'
        >
          {waitingCount}
        </span>
      ) : null}
    </Button>
  )
}
