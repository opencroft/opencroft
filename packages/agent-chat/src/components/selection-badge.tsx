'use client'

import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from 'cn'

// Without-ref on purpose: `forwardRef` below already contributes the ref to
// the public props, and carrying it in both places is how the two definitions
// get to disagree.
export interface SelectionBadgeProps extends Omit<ComponentPropsWithoutRef<'blockquote'>, 'children'> {
  // What the reader sees. Presentation only: what the message actually carries
  // is the host's business and deliberately not this component's -- a label
  // reads like "3 commits" or a heading, while what travels may be pages.
  label: string
}

// What the reader has selected somewhere else on the screen, quoted above the
// composer so it is visible that the next message will carry it -- and, in a
// delivered message, quoted again as the record of what that message carried.
//
// A QUOTATION, NOT A CHIP. It is the shape a reader already meets when they
// select text and ask about it elsewhere in the product: a rule down the left,
// the quoted words small and muted beside it. Selecting something and seeing it
// quoted back is one idea, and it should not have two appearances depending on
// which surface the reader happens to be on.
//
// IT QUOTES THE LABEL, WHICH IS NOT WHAT TRAVELS, and that is the decision
// rather than an oversight. A selection carries two things -- a short label for
// the reader and the content the agent receives -- and only the first is a
// quotation a person can take in at a glance. The content may be pages, and a
// composer that grew to fit it would bury the message being written. So the
// component is given the label and nothing else: it cannot show what it was
// never handed, which is also what keeps it honest about being presentational.
//
// NO CONTROLS INSIDE IT. Holding a selection back is a control of its own,
// standing in the action row below the input where the reader's other switches
// are; putting it in here would make the quotation a button, and a quotation
// that is also a target invites a press that was meant for the words. There is
// nothing to discard from here either -- the selection is dropped by whatever
// published it, when it stops publishing.
//
// ONE ELEMENT, ONE BEHAVIOUR. The composer's copy and the delivered message's
// copy are the same element rendering the same way, with no flag distinguishing
// "live" from "record": the difference is entirely in what the surrounding
// surface does about it, so neither can drift into a second appearance.
//
// IT YIELDS WIDTH. `min-w-0` and no `shrink-0`: whatever row this sits in is a
// flex container, and a flex item refuses to shrink below its longest
// unbreakable word until it is told it may -- without it a long path widens the
// row instead of being cut. Three lines is where it stops growing downward, for
// the same reason the reference clamps: the quotation is context for the
// message, and context that pushes the message off the screen has stopped being
// context.
export const SelectionBadge = forwardRef<HTMLQuoteElement, SelectionBadgeProps>(function SelectionBadge(
  { label, className, ...rest },
  ref,
) {
  return (
    <blockquote
      ref={ref}
      // Spread first, this component's own presentation after. A composer slot
      // is exactly the sort of place something gets wrapped in a tooltip or a
      // menu trigger later, and a parent that takes this as its `render` element
      // draws no element of its own -- it renders this one and merges its
      // handlers and its ref onto it.
      // A component that destructured a fixed prop list and spread nothing
      // would drop them on the floor: no error, no warning, a trigger wired to
      // nothing. This declares no handler of its own at this level, so there is
      // nothing here to compose with rather than replace.
      {...rest}
      className={cn(
        'm-0 min-w-0 border-l-2 border-primary pl-2 text-xs text-muted-foreground',
        'line-clamp-3 break-words',
        className,
      )}
    >
      {label}
    </blockquote>
  )
})
