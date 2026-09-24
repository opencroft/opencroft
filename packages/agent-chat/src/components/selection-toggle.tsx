'use client'

import { Eye, EyeOff } from 'lucide-react'
import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef } from 'react'

// THE TWO IMPORTS BELOW HAVE TWO DESTINATIONS, and that is why their shapes
// differ. The command bar is a sibling of this file and installs beside it, in
// the same package; the button is a primitive that lives in the shared one.
// Normalising either to match the other sends it to a package the file is not
// in, and nothing here reports that -- the failure is at the consumer's build.
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
  // Names the selection in the button's tooltip, when there IS one. An icon on
  // its own says what the control does and not what it is about, and while
  // something is selected this control is about that particular thing.
  //
  // Optional, because the control stands whether or not anything is selected.
  // With no label the wording speaks about selections in general instead --
  // which is what the press means at that moment, since the answer is kept by
  // the scope rather than by whatever happens to be selected.
  label?: string
  // Whether a selection is quoted above the composer AND goes with the next
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
// IT STANDS WHETHER OR NOT ANYTHING IS SELECTED, and it is live either way.
// The answer belongs to the surface, not to whatever happens to be selected on
// it, so a reader can settle it before selecting anything and have it hold. A
// control that appeared only once there was something to hide would be asking
// the question at the one moment the reader is busy with something else.
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
  // Named when there is something to name, general when there is not. The
  // second pair is not a placeholder for the first: with nothing selected the
  // press is about what happens to the NEXT selection, and wording that named
  // nothing would leave the reader guessing whether the control was inert.
  const title = label
    ? included
      ? `"${label}" is shown here and goes with the next message — press to hold it back`
      : `"${label}" is held back — press to show it and send it with the next message`
    : included
      ? 'What you select is shown here and goes with the next message — press to hold selections back'
      : 'Selections are held back — press to show them and send them with the next message'
  return (
    <Button
      ref={ref}
      // Spread first, this component's own presentation and state after. A
      // composer slot is exactly the sort of place something gets wrapped in a
      // tooltip or a menu trigger later, and a parent that takes this as its
      // `render` element draws no element of its own -- it renders this one and
      // merges its handlers, its ref and its attributes onto it. A component that destructured a fixed
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
