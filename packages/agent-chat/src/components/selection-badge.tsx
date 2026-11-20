'use client'

import { ChevronRight } from 'lucide-react'
import { forwardRef, useLayoutEffect, useRef, useState } from 'react'
import type { ComponentPropsWithoutRef } from 'react'

import { cn } from 'cn'

// Without-ref on purpose: `forwardRef` below already contributes the ref to
// the public props, and carrying it in both places is how the two definitions
// get to disagree.
export interface SelectionBadgeProps extends Omit<ComponentPropsWithoutRef<'blockquote'>, 'children'> {
  // What the reader sees: what is selected. Presentation only: what the
  // message actually carries is the host's business and deliberately not this
  // component's -- a label reads like "3 commits" or a heading, while what
  // travels may be pages.
  label: string
  // Where it was selected, outermost first: the space, then the App. Given,
  // the quote is one line, `Space › App › label`, shortened to fit its width.
  // Absent, the label is quoted on its own, wrapping over up to three lines.
  place?: readonly string[]
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
// WITH A PLACE, A PATH. `Space › App › label` while it fits, then
// `Space › … › label`, then the label alone, cut with an ellipsis: the longest
// form that fits the width this quote is given, measured against that width
// and not the window's, and followed as it changes. The space and App are
// muted, and whenever a part is hidden the full path is the hover hint, unless
// the caller gives a `title` of its own. The place is a prop rather than text
// inside the label, so nothing here parses what it is handed.
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
// row instead of being cut. Three lines is where a label without a place stops
// growing downward, for the same reason the reference clamps: the quotation is
// context for the message, and context that pushes the message off the screen
// has stopped being context.
//
// A PATH NEEDS A WIDTH GIVEN TO IT. It measures the width its container gives
// it, so it must fill that width: in a block or a column it does; as an item
// of a wrapping row it sizes itself to its content, and the caller gives it the
// row's line (`basis-full`), or it would size itself to its full path and never
// shorten.
export const SelectionBadge = forwardRef<HTMLQuoteElement, SelectionBadgeProps>(function SelectionBadge(
  { label, place, className, title, ...rest },
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
      title={title}
      className={cn(
        'm-0 min-w-0 border-l-2 border-primary pl-2 text-xs text-muted-foreground',
        place?.length ? 'flex' : 'line-clamp-3 break-words',
        className,
      )}
    >
      {place?.length ? <QuotePath label={label} place={place} title={title} /> : label}
    </blockquote>
  )
})

/** How much of a quote's path is shown: every part, the first and the last, or the last alone. */
export type QuotePathForm = 'full' | 'short' | 'label'

/** The longest form whose natural width fits `available` px. */
export function quotePathForm(available: number, widths: { full: number; short: number }): QuotePathForm {
  if (widths.full <= available) {
    return 'full'
  }
  if (widths.short <= available) {
    return 'short'
  }
  return 'label'
}

/** The parts of one form; `…` stands for the parts a short form leaves out. */
export function quotePathParts(form: QuotePathForm, place: readonly string[], label: string): string[] {
  if (form === 'label') {
    return [label]
  }
  if (form === 'short' && place.length > 1) {
    return [place[0], '…', label]
  }
  return [...place, label]
}

function PathText({ parts }: { parts: string[] }) {
  const last = parts.length - 1
  return (
    <>
      {parts.map((part, index) =>
        index === last ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a form's parts are rebuilt whole on every render and never reorder; the position is what each one is.
          <span key={index} className='min-w-0 truncate'>
            {part}
          </span>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: as above.
          <span key={index} className='flex shrink-0 items-center gap-1 opacity-70'>
            {part}
            <ChevronRight className='size-3 shrink-0' />
          </span>
        ),
      )}
    </>
  )
}

function QuotePath({ label, place, title }: { label: string; place: readonly string[]; title?: string }) {
  const textRef = useRef<HTMLSpanElement>(null)
  const fullRef = useRef<HTMLSpanElement>(null)
  const shortRef = useRef<HTMLSpanElement>(null)
  const [form, setForm] = useState<QuotePathForm>('full')
  const full = quotePathParts('full', place, label)
  const short = quotePathParts('short', place, label)
  const shown = quotePathParts(form, place, label)
  // What the measurement depends on: the text of the full path.
  const path = full.join(' › ')

  useLayoutEffect(() => {
    void path
    const text = textRef.current
    if (!text || typeof ResizeObserver === 'undefined') {
      return
    }
    const measure = () =>
      setForm(
        quotePathForm(text.clientWidth, {
          full: fullRef.current?.scrollWidth ?? 0,
          short: shortRef.current?.scrollWidth ?? 0,
        }),
      )
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(text)
    return () => observer.disconnect()
  }, [path])

  const hidden = form === 'label' || (form === 'short' && place.length > 1)
  return (
    // Its width is what the quote is given, whatever form it shows: a width
    // that followed the form shown would never grow back to fit a longer one.
    <span
      ref={textRef}
      className='relative flex min-w-0 flex-1 basis-0 items-center gap-1 overflow-hidden'
      // A caller's own title is on the quote around this, and stands.
      title={title === undefined && hidden ? path : undefined}
    >
      <PathText parts={shown} />
      {/* The two longer forms, laid out unseen at their natural widths. */}
      <span
        ref={fullRef}
        aria-hidden
        className='pointer-events-none invisible absolute top-0 left-0 flex items-center gap-1 whitespace-nowrap'
      >
        <PathText parts={full} />
      </span>
      <span
        ref={shortRef}
        aria-hidden
        className='pointer-events-none invisible absolute top-0 left-0 flex items-center gap-1 whitespace-nowrap'
      >
        <PathText parts={short} />
      </span>
    </span>
  )
}
