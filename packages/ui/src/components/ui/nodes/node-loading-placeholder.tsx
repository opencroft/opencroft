'use client'

import { NodeCard, NodeCardContent, NodeCardHeader } from '@/components/ui/nodes/node-card'
import { Skeleton } from '@/components/ui/skeleton'

export interface NodeLoadingPlaceholderProps {
  /** The node's name. The graph carries it before the extension does, so this
   * is real text, never a bar -- see the note in the body. */
  name: string
  /** Whether the node is selected on the canvas. Passed straight to the card,
   * which owns what selection looks like. */
  selected?: boolean
  className?: string
}

// What a canvas node looks like in the window between the graph painting and
// its extension registering.
//
// **It IS a node card.** Not a box that resembles one -- the same component the
// real node is drawn with, holding skeleton rows instead of content. That is
// the whole design, and it is the second attempt: the first was a separate box
// that agreed with the card on radius, padding, border, shadow, background,
// brightness and width by having the same values written in two files. Two of
// those seven were found wrong within two days, both by someone comparing them
// by hand. Composition ends the category -- there is no value to disagree about
// because there is only one of each.
//
// The header is shared too, rather than rebuilt with matching padding: a
// rebuilt row would have traded seven agreements for six and added a new one.
// `NodeCardHeader` takes an element for its icon precisely so this can pass a
// bar, and the name then gets the real title's size, weight and truncation for
// free.
//
// **What is a bar and what is text says what is known.** The name is real text
// because the graph has it already; showing a grey bar where we hold a name
// would make this state less readable than the canvas is today, a regression
// inside the very window it exists to improve. The icon IS a bar, because the
// icon belongs to the extension, which is exactly what has not arrived. No
// accent is passed for the same reason -- a node's colour comes from its type,
// and the type is not resolved yet -- so there are no hairlines and no
// travelling dots, and the card reads as quiet rather than working.
//
// **Three channels separate this from the missing-extension error**, because
// any one of them fails somebody:
//   colour -- muted and neutral, never destructive
//   motion -- a gentle pulse, where the error box is static
//   text   -- "Loading" and the node's name, with no error language at all
// Motion is deliberately dropped under `prefers-reduced-motion`. That is safe
// precisely because it is one of three: colour and text still carry the
// distinction on their own, so nobody loses it.
//
// Height is content-driven, exactly as a real node's is -- neither carries a
// definite height and the graph does not supply one. This is as tall as three
// skeleton rows, which is a guess at the node's own content and the one thing
// here that still cannot be right by construction. It does not collapse: with
// the header and caption both intrinsic, an ancestor of zero height still
// leaves the name legible.
export function NodeLoadingPlaceholder({ name, selected, className }: NodeLoadingPlaceholderProps) {
  return (
    <NodeCard selected={selected} className={className} aria-busy='true' aria-label={`${name}, loading`}>
      <NodeCardHeader
        icon={<Skeleton className='h-4 w-4 rounded-sm motion-reduce:animate-none' />}
        title={name}
      />
      <NodeCardContent>
        {/* Three bars at full, four-fifths and three-fifths. Decreasing widths
            read as lines of content rather than as a filled rectangle, and
            three is enough to say "something goes here" without implying a
            shape the arriving extension then contradicts. */}
        <div className='flex flex-col gap-1.5'>
          <Skeleton className='h-2 w-full rounded-sm motion-reduce:animate-none' />
          <Skeleton className='h-2 w-4/5 rounded-sm motion-reduce:animate-none' />
          <Skeleton className='h-2 w-3/5 rounded-sm motion-reduce:animate-none' />
        </div>
        <span className='mt-2 block truncate text-xs text-muted-foreground'>Loading</span>
      </NodeCardContent>
    </NodeCard>
  )
}
