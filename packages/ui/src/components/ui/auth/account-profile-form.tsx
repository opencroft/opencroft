'use client'

import type { ReactNode } from 'react'
import { useId } from 'react'

import { Button } from 'ui/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from 'ui/components/ui/field'
import { Input } from 'ui/components/ui/input'

export interface AccountProfileFormProps {
  name: string
  onNameChange: (value: string) => void
  // The handle that identifies the account, as opposed to the name that says
  // what to call them. Saved by this same submit -- unlike the email, it needs
  // no confirmation step.
  username: string
  onUsernameChange: (value: string) => void
  // What a username may be made of, in the host's words. A prop rather than a
  // sentence written here, because the rule that produced it lives with the
  // rule itself -- a second copy in this file is how the two start disagreeing
  // about what is allowed.
  usernameHint?: ReactNode
  // Message under the username field. Displayed, not decided: the host owns
  // the rules that produced it, including whether the handle is already taken.
  usernameError?: string
  // The account's current email. Read-only here: changing it is a separate
  // operation (it can require confirmation), so it is not part of this submit.
  email: string
  // Opens the host's email-change flow. Distinct from the name save on
  // purpose -- the two operations are not the same.
  onRequestEmailChange: () => void
  // When an email change is awaiting confirmation, the address that's pending.
  // Shown as a notice under the email field; empty when nothing is pending.
  pendingEmail?: string
  // Cancels a pending email change. Omit to hide the cancel affordance.
  onCancelEmailChange?: () => void
  // Reports that the user asked to save their display name. The form
  // validates nothing and calls nothing -- what happens next is the host's.
  onSubmit: () => void
  // Message under the name field. Displayed, not decided: the host owns the
  // rules that produced it.
  nameError?: string
  // A whole-form failure -- a rejected save, a server that did not answer.
  error?: string
  // The name is being saved: the submit goes inert and says so.
  submitting?: boolean
  className?: string
}

// The profile form for a signed-in person, with no page frame around it. The
// display name and the username are saved here; the email is shown but
// changed through its own operation, because an email change can require
// confirmation and neither of the others can -- so the fields are not treated
// alike.
//
// Name and username sit together, in that order, because they answer two
// different questions about the same person: what to call them, and which
// account they are. Only the second has to be unique, and only the second is
// what a durable reference gets written against.
//
// Fully controlled and free of the stack it came from: no form library, no
// router, no auth client. Values arrive as props, every outcome leaves as a
// callback.
export function AccountProfileForm({
  name,
  onNameChange,
  username,
  onUsernameChange,
  usernameHint,
  usernameError,
  email,
  onRequestEmailChange,
  pendingEmail,
  onCancelEmailChange,
  onSubmit,
  nameError,
  error,
  submitting,
  className,
}: AccountProfileFormProps) {
  // Generated rather than fixed: a docs page renders this form several times
  // over, and duplicate ids would point every label at the first field.
  const nameId = useId()
  const usernameId = useId()
  const emailId = useId()

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <FieldGroup>
        <Field data-invalid={nameError ? true : undefined}>
          <FieldLabel htmlFor={nameId}>Display name</FieldLabel>
          <Input
            id={nameId}
            name='name'
            placeholder='Ada Lovelace'
            autoComplete='name'
            value={name}
            aria-invalid={nameError ? true : undefined}
            onChange={(event) => onNameChange(event.target.value)}
          />
          <FieldError>{nameError}</FieldError>
        </Field>

        <Field data-invalid={usernameError ? true : undefined}>
          <FieldLabel htmlFor={usernameId}>Username</FieldLabel>
          <Input
            id={usernameId}
            name='username'
            placeholder='ada.lovelace'
            autoComplete='username'
            autoCapitalize='none'
            spellCheck={false}
            value={username}
            aria-invalid={usernameError ? true : undefined}
            onChange={(event) => onUsernameChange(event.target.value)}
          />
          {/* The hint gives way to a refusal rather than stacking under it:
              two lines of small grey text, one of them now wrong, reads as
              noise at the moment the reader most needs the one that matters. */}
          {usernameHint && !usernameError ? (
            <p className='text-sm text-muted-foreground'>{usernameHint}</p>
          ) : null}
          <FieldError>{usernameError}</FieldError>
        </Field>

        <Field>
          <FieldLabel htmlFor={emailId}>Email</FieldLabel>
          {/* Read-only: the current email. Changing it is a different operation
              from saving the name, so it is not an input this submit writes --
              the "Change email" button starts the host's separate flow. */}
          <div className='flex flex-col gap-2 sm:flex-row sm:items-center'>
            <Input
              id={emailId}
              type='email'
              value={email}
              readOnly
              aria-readonly='true'
              className='sm:flex-1'
            />
            <Button
              type='button'
              variant='outline'
              onClick={onRequestEmailChange}
              disabled={submitting}
              className='sm:shrink-0'
            >
              Change email
            </Button>
          </div>
          {pendingEmail ? (
            <p className='text-sm text-muted-foreground'>
              Confirmation sent to{' '}
              <span className='font-medium text-foreground'>{pendingEmail}</span>.
              {onCancelEmailChange ? (
                <>
                  {' '}
                  <button
                    type='button'
                    onClick={onCancelEmailChange}
                    className='font-medium text-primary underline-offset-4 hover:underline'
                  >
                    Cancel
                  </button>
                </>
              ) : null}
            </p>
          ) : (
            <p className='text-sm text-muted-foreground'>
              Changing your email requires confirmation.
            </p>
          )}
        </Field>

        {/* Renders nothing at all when there is no message, so it can stay
            mounted rather than being conditionally spliced into the group. */}
        <FieldError>{error}</FieldError>

        <Field>
          <Button type='submit' disabled={submitting}>
            {submitting ? 'Saving…' : 'Save changes'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
