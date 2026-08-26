'use client'

import { useId } from 'react'

import { Button } from 'ui/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from 'ui/components/ui/field'
import { Textarea } from 'ui/components/ui/textarea'

export interface GroupChatPinFormProps {
  text: string
  onTextChange: (value: string) => void
  // Reports that the user asked to save. The form validates nothing and calls
  // nothing -- what happens next, and what comes back, is the host's.
  onSubmit: () => void
  // Renders a cancel beside the submit. Omit and there is none -- a form in a
  // dialog usually has its own way out, a form rendered in place usually does
  // not.
  onCancel?: () => void
  // Switches the submit label only. Pinning a note and editing one are the same
  // act on the same thing, so they are the same form.
  mode?: 'create' | 'edit'
  submitting?: boolean
  // A whole-form failure -- a refused save (the cap), an unreachable server.
  // Displayed, not decided.
  error?: string
  // A host that has a length limit passes it; the field then enforces it and
  // the count appears as the writer approaches it. Unset means unbounded here,
  // which is honest: the kit does not know the server's limit and will not
  // invent one.
  maxLength?: number
  className?: string
}

// The form that writes a pinned note.
//
// One field, because a pin is one thing: a line of standing guidance for this
// group chat. It is a TEXTAREA rather than an input, and that is the whole
// design decision here -- a pin is read by the chat's agents as context, so it
// wants to be a sentence that says what it means, and a single-line box quietly
// argues for a fragment. Three rows is enough to see that a sentence is
// welcome without implying an essay.
//
// Fully controlled and free of the stack it came from -- no form library, no
// router, no client. The text comes in as a prop and every outcome leaves as a
// callback.
export function GroupChatPinForm({
  text,
  onTextChange,
  onSubmit,
  onCancel,
  mode = 'create',
  submitting,
  error,
  maxLength,
  className,
}: GroupChatPinFormProps) {
  // Generated rather than fixed: a docs page renders this form several times
  // over, and duplicate ids would point every label at the first field.
  const textId = useId()

  // Shown only as the limit comes into reach. A counter that is always on reads
  // as a target to fill; one that appears near the end reads as a warning,
  // which is what it is.
  const remaining = maxLength === undefined ? null : maxLength - text.length
  const showCount =
    maxLength !== undefined &&
    remaining !== null &&
    remaining <= Math.max(20, Math.round(maxLength * 0.2))

  return (
    <form
      className={className}
      method='post'
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <FieldGroup>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={textId}>Note</FieldLabel>
          <Textarea
            id={textId}
            name='text'
            value={text}
            rows={3}
            maxLength={maxLength}
            placeholder='Something the agents in this chat should keep in mind.'
            aria-invalid={error ? true : undefined}
            onChange={(event) => onTextChange(event.target.value)}
          />
          {/* Says who else reads this. It is the one thing about a pin that is
              not visible from the panel it lands in, and the reason a note is
              worth writing carefully.

              A plain paragraph rather than the field primitive's description
              slot: the four field parts used across this kit are the ones every
              other form here has proven, and a form is not the place to be the
              first caller of a fifth. */}
          <p className='text-xs text-muted-foreground'>
            {showCount
              ? `Pinned notes are given to the agents in this chat as standing context. ${remaining} characters left.`
              : 'Pinned notes are given to the agents in this chat as standing context.'}
          </p>
        </Field>

        {/* Renders nothing at all when there is no message, so it can stay
            mounted rather than being conditionally spliced into the group. */}
        <FieldError>{error}</FieldError>

        <Field>
          <div className='flex min-w-0 flex-wrap items-center gap-2'>
            {/* Inert only while a save is in flight. Whether an empty note may
                be submitted is the host's rule, reported back through `error`
                -- the same contract the other forms in this kit keep. */}
            <Button type='submit' disabled={submitting}>
              {submitting ? 'Saving…' : mode === 'edit' ? 'Save note' : 'Pin note'}
            </Button>
            {onCancel ? (
              <Button type='button' variant='ghost' onClick={onCancel} disabled={submitting}>
                Cancel
              </Button>
            ) : null}
          </div>
        </Field>
      </FieldGroup>
    </form>
  )
}
