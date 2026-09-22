'use client'

import { Plus } from 'lucide-react'
import { forwardRef, useRef } from 'react'
import type { ChangeEvent, ComponentPropsWithoutRef } from 'react'

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
export interface AttachButtonProps extends Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'onChange'> {
  // What the picker offers, as an `accept` attribute. Defaults to the image
  // types a vision model is actually served by; a host that reaches something
  // else narrows or widens it here.
  accept?: string
  // Whether one press may pick several files.
  multiple?: boolean
  // Why the control cannot be used, when it cannot. Present means disabled --
  // one prop rather than two, because a disabled control with no reason is the
  // state this component exists to avoid.
  unavailableReason?: string
  // What the press MEANS to this feature, kept separate from the DOM handlers
  // above it. Called with what the reader picked, never with an empty list.
  onFiles: (files: File[]) => void
}

// The control that puts a picture in the next message: one plus in the
// composer's action row, opening the reader's own file picker.
//
// IT STANDS EVEN WHERE IT CANNOT BE USED. An agent that never advertised image
// prompts gets the button disabled with the reason in its tooltip, rather than
// no button: a control that appeared on some chats and not others would leave
// the reader unable to tell "this agent cannot see pictures" from "this product
// cannot send them". The first is a fact about a choice they made; the second
// would be a feature they never find.
//
// A HIDDEN INPUT, NOT A LABEL WRAPPING THE BUTTON. The row's controls are all
// buttons of one exported size, and a label styled to match would be a second
// definition of that size -- but the reason it matters is keyboard focus: a
// label containing a button puts two focusable things where the reader sees
// one. So the input stays out of the flow and the button opens it.
//
// THE PICKER IS CLEARED AFTER EVERY PICK. A file input holds its value, and
// picking the same screenshot twice in a row fires no change event the second
// time -- which reads as the control being broken by the one action most likely
// to be repeated.
//
// Presentational and fully controlled: it hands over the files it was given.
// Re-encoding, size limits, uploading and what a message says about them all
// belong to the host.
export const AttachButton = forwardRef<HTMLButtonElement, AttachButtonProps>(function AttachButton(
  { accept = 'image/png,image/jpeg,image/webp,image/gif', multiple = true, unavailableReason, onFiles, className, onClick, onMouseDown, disabled, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null)
  const title = unavailableReason ?? 'Attach an image to the next message'
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    // Cleared before the callback, not after: a host that throws would
    // otherwise leave the picker holding the file it failed on, and the reader's
    // second attempt at the same one would be silently ignored.
    event.target.value = ''
    if (files.length > 0) {
      onFiles(files)
    }
  }
  return (
    <>
      <input
        ref={inputRef}
        type='file'
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        // Out of the flow rather than `display: none`: a hidden input is still
        // the element the picker reports back to, and some browsers refuse to
        // open one that was never laid out.
        className='sr-only'
        tabIndex={-1}
        aria-hidden='true'
      />
      <Button
        ref={ref}
        // Spread first, this component's own presentation and state after. A
        // composer slot is exactly the sort of place something gets wrapped in
        // a tooltip or a menu trigger later, and an `asChild` parent renders no
        // element of its own -- it clones this one and injects its handlers,
        // its ref and its attributes onto it. A component that destructured a
        // fixed prop list and spread nothing would drop them on the floor: no
        // error, no warning, a trigger wired to nothing.
        {...rest}
        type='button'
        variant='ghost'
        size='icon'
        disabled={disabled || unavailableReason !== undefined}
        onClick={(event) => {
          onClick?.(event)
          inputRef.current?.click()
        }}
        // The composer keeps focus when this is pressed -- losing it
        // mid-sentence to a control beside the box is its own small betrayal.
        onMouseDown={(event) => {
          onMouseDown?.(event)
          event.preventDefault()
        }}
        title={title}
        aria-label={title}
        className={cn(commandBarControlClass, className)}
      >
        <Plus className='size-4' />
      </Button>
    </>
  )
})
