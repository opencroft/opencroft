'use client'

import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export interface NodeLoadingPlaceholderProps {
  /** The node's name. The graph carries it before the extension does, so this
   * is real text, never a bar -- see the note in the body. */
  name: string
  className?: string
}

// What a canvas node looks like in the window between the graph painting and
// its extension registering.
//
// **It takes no size of its own.** `h-full w-full` and nothing else: the canvas
// already positions and sizes each node's box, and edge attachment points are
// computed from that box -- so filling it is the only version that cannot be
// the wrong size. A placeholder carrying its own dimensions would have to be
// kept in step with the app's node shell by hand, and the day it drifted every
// node would jump and drag its edges when the extension landed. Inheriting is
// not laziness here; it is the constraint being met by construction.
//
// **What is a bar and what is text says what is known.** The name is real text
// because the graph has it already, and showing a grey bar where we hold a name
// would make this state less readable than the canvas is today -- a regression
// inside the very window it exists to improve. The icon IS a bar, because the
// icon belongs to the extension, which is exactly what has not arrived. Read
// together, the card is an honest picture of what is and is not known yet.
//
// **Three channels separate this from the missing-extension error**, because
// any one of them fails somebody:
//   colour -- muted and neutral, never destructive
//   motion -- a gentle pulse, where the error box is static
//   text   -- "Loading" and the node's name, with no error language at all
// Motion is deliberately dropped under `prefers-reduced-motion`. That is safe
// precisely because it is one of three: colour and text still carry the
// distinction on their own, so nobody loses it.
export function NodeLoadingPlaceholder({ name, className }: NodeLoadingPlaceholderProps) {
  return (
    <div
      aria-busy='true'
      aria-label={`${name}, loading`}
      className={cn(
        'flex h-full w-full min-w-0 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-card p-2',
        className,
      )}
    >
      <div className='flex min-w-0 shrink-0 items-center gap-2'>
        <Skeleton className='size-5 shrink-0 rounded-md motion-reduce:animate-none' />
        {/* min-w-0 as well as truncate: this is a flex item, so without it the
            automatic minimum size is the whole name, the ellipsis never fires,
            and a long name widens the card past the node's box. */}
        <span className='min-w-0 flex-1 truncate text-xs font-medium text-foreground'>{name}</span>
      </div>

      {/* Three bars at full, four-fifths and three-fifths. Decreasing widths
          read as lines of content rather than as a filled rectangle, and three
          is enough to say "something goes here" without implying a shape the
          arriving extension then contradicts. They clip rather than squeeze on
          a short node -- a placeholder is not worth a scroll region. */}
      <div className='flex min-h-0 flex-1 flex-col gap-1.5 overflow-hidden'>
        <Skeleton className='h-2 w-full shrink-0 rounded-sm motion-reduce:animate-none' />
        <Skeleton className='h-2 w-4/5 shrink-0 rounded-sm motion-reduce:animate-none' />
        <Skeleton className='h-2 w-3/5 shrink-0 rounded-sm motion-reduce:animate-none' />
      </div>

      <span className='shrink-0 truncate text-xs text-muted-foreground'>Loading</span>
    </div>
  )
}
