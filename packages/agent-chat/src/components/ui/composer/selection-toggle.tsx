'use client'

import { Eye, EyeOff } from 'lucide-react'
import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'

// RELATIVE ON PURPOSE, rather than through the package alias. The command bar
// is a sibling of this file in the same design project and the same category,
// and an aliased path to one of those gets rewritten on install -- into the
// shared UI package, where a chat-generic component does not live. The
// installed file then imports its way straight out of the package it was just
// installed into, and the failure is invisible from here: the preview resolves
// by name, so it renders either way. A relative path has no alias to be
// rewritten through.
//
// The rule, and the line between the two imports below: a same-category
// sibling in this project is imported relatively; a primitive that really does
// live in the shared package keeps the alias, which is why the button import
// is the shape it is. Please do not normalise this one to match it.
//
// The paths themselves are deliberately not written out in this comment. The
// installer rewrites module specifiers wherever it finds them, comment text
// included -- so a comment naming a path in order to reject it arrives in the
// consuming app rewritten INTO that path, reading as an instruction to do the
// very thing it exists to prevent.
import { commandBarControlClass } from './agent-command-bar'

import { Button } from 'ui/components/ui/button'
import { cn } from 'ui/lib/utils'

// Without-ref on purpose: `forwardRef` below already contributes the ref to the
// public props, and carrying it in both places is how the two definitions get
// to disagree.
export interface SelectionToggleProps extends Omit<ComponentPropsWithoutRef<'button'>, 'children'> {
  // Names the selection in the button's tooltip. An icon on its own says what
  // the control does and not what it is about, and this control is about one
  // particular thing the reader picked.
  label: string
  // Whether the selection is quoted above the composer AND goes with the next
  // message. One flag, both consequences -- see the note on the component.
  //
  // Positive form on purpose: the control states what will happen, not what
  // will not.
  included: boolean
  // What the press MEANS to this feature, kept separate from the DOM `onClick`
  // above it. A parent that wraps this control has its own reason to hear the
  // press and is not the thing that decides what the press does; both run.
  onToggle: () => void
}

// The switch for whatever the reader has selected elsewhere on the screen: on,
// it is quoted above the composer and rides along with the next message; off,
// neither.
//
// ONE FLAG, TWO CONSEQUENCES, AND THAT IS THE POINT. A reader who hides the
// quotation means "do not send this", not "tidy my screen" -- so a control that
// only hid it would leave the message carrying something invisible, which is
// the worse half of the two possible mistakes. Showing and sending move
// together and cannot be set against each other.
//
// IT DOES NOT TOUCH THE SELECTION. Pressing it holds the selection back;
// pressing it again brings the same one straight back, unchanged. Whatever
// published the selection goes on publishing it, and dropping it is that
// publisher's business, not this control's -- so there is no state here a
// second press cannot undo.
//
// AN ICON BUTTON IN THE ACTION ROW, sized from the bar's own exported constant
// rather than a number typed into this file: a number copied into a slot child
// drifts from the row it copied. It is a fixed-size affordance, so it keeps its
// width when the row narrows -- shrinking an icon button costs hittability,
// and the quotation above is the thing in this feature that yields instead.
//
// THE STATE IS TOLD BY SHAPE, NOT COLOUR: an eye or a crossed-out eye, and
// `aria-pressed` carries the same fact to anything listening.
//
// Presentational: it holds no selection and phrases nothing about what the
// agent receives.
export const SelectionToggle = forwardRef<HTMLButtonElement, SelectionToggleProps>(function SelectionToggle(
  { label, included, onToggle, className, onClick, onMouseDown, ...rest },
  ref,
) {
  const title = included
    ? `"${label}" is shown here and goes with the next message — press to hold it back`
    : `"${label}" is held back — press to show it and send it with the next message`
  return (
    <Button
      ref={ref}
      // Spread first, this component's own presentation and state after. A
      // composer slot is exactly the sort of place something gets wrapped in a
      // tooltip or a menu trigger later, and an `asChild` parent renders no
      // element of its own -- it clones this one and injects its handlers, its
      // ref and its attributes onto it. A component that destructured a fixed
      // prop list and spread nothing would drop them on the floor: no error, no
      // warning, a trigger wired to nothing.
      //
      // The handlers below are the part the badge beside this file does not
      // have to deal with, because it declares none. Here an injected handler
      // and this component's own both want the same event, so they are COMPOSED
      // rather than one replacing the other -- the wrapper's first, since its
      // reason for listening (open a menu, show a tip) is not conditional on
      // what this control decides to do afterwards.
      //
      // What stays this component's own: everything derived from `included`.
      // The pressed state, the wording and the icon describe a fact the parent
      // does not have, so they are set after the spread and win.
      {...rest}
      type='button'
      variant='ghost'
      size='icon'
      onClick={(event) => {
        onClick?.(event)
        onToggle()
      }}
      // The composer keeps focus when this is pressed -- losing it mid-sentence
      // to a control beside the box is its own small betrayal.
      onMouseDown={(event) => {
        onMouseDown?.(event)
        event.preventDefault()
      }}
      aria-pressed={included}
      title={title}
      aria-label={title}
      className={cn(commandBarControlClass, className)}
    >
      {included ? <Eye className='size-4' /> : <EyeOff className='size-4 text-muted-foreground' />}
    </Button>
  )
})
