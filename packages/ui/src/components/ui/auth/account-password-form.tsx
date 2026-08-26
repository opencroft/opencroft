'use client'

import { useId } from 'react'

import { Button } from 'ui/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from 'ui/components/ui/field'
import { Input } from 'ui/components/ui/input'

export interface AccountPasswordFormProps {
  currentPassword: string
  onCurrentPasswordChange: (value: string) => void
  newPassword: string
  onNewPasswordChange: (value: string) => void
  confirmPassword: string
  onConfirmPasswordChange: (value: string) => void
  // Reports that the user asked to change the password. The form validates
  // nothing and calls nothing -- what happens next is the host's.
  onSubmit: () => void
  // Per-field messages, each shown under the field it belongs to. Displayed,
  // not decided: the host owns the rules that produced them.
  currentPasswordError?: string
  newPasswordError?: string
  confirmPasswordError?: string
  // A whole-form failure -- a rejected change, a server that did not answer.
  error?: string
  // The password is being changed: the submit goes inert and says so.
  submitting?: boolean
  className?: string
}

// The password-change form, with no page frame around it. Three fields, not
// two: current password, new password, confirmation. Without the current
// password the form would describe a different, weaker operation, so it is
// always present. A host supplies the heading.
//
// Fully controlled and free of the stack it came from: no form library, no
// router, no auth client. Values arrive as props, every outcome leaves as a
// callback.
export function AccountPasswordForm({
  currentPassword,
  onCurrentPasswordChange,
  newPassword,
  onNewPasswordChange,
  confirmPassword,
  onConfirmPasswordChange,
  onSubmit,
  currentPasswordError,
  newPasswordError,
  confirmPasswordError,
  error,
  submitting,
  className,
}: AccountPasswordFormProps) {
  // Generated rather than fixed: a docs page renders this form several times
  // over, and duplicate ids would point every label at the first field.
  const currentId = useId()
  const newId = useId()
  const confirmId = useId()

  return (
    // method='post' so a submit before hydration is a POST with the three
    // passwords in the body, not the default GET that puts current/new/confirm
    // in the URL. The handler still preventDefault()s and does the real submit.
    <form
      method='post'
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <FieldGroup>
        <Field data-invalid={currentPasswordError ? true : undefined}>
          <FieldLabel htmlFor={currentId}>Current password</FieldLabel>
          <Input
            id={currentId}
            name='current-password'
            type='password'
            autoComplete='current-password'
            value={currentPassword}
            aria-invalid={currentPasswordError ? true : undefined}
            onChange={(event) => onCurrentPasswordChange(event.target.value)}
          />
          <FieldError>{currentPasswordError}</FieldError>
        </Field>

        <Field data-invalid={newPasswordError ? true : undefined}>
          <FieldLabel htmlFor={newId}>New password</FieldLabel>
          <Input
            id={newId}
            name='new-password'
            type='password'
            autoComplete='new-password'
            value={newPassword}
            aria-invalid={newPasswordError ? true : undefined}
            onChange={(event) => onNewPasswordChange(event.target.value)}
          />
          <FieldError>{newPasswordError}</FieldError>
        </Field>

        <Field data-invalid={confirmPasswordError ? true : undefined}>
          <FieldLabel htmlFor={confirmId}>Confirm new password</FieldLabel>
          <Input
            id={confirmId}
            name='confirm-password'
            type='password'
            autoComplete='new-password'
            value={confirmPassword}
            aria-invalid={confirmPasswordError ? true : undefined}
            onChange={(event) => onConfirmPasswordChange(event.target.value)}
          />
          <FieldError>{confirmPasswordError}</FieldError>
        </Field>

        {/* Renders nothing at all when there is no message, so it can stay
            mounted rather than being conditionally spliced into the group. */}
        <FieldError>{error}</FieldError>

        <Field>
          <Button type='submit' disabled={submitting}>
            {submitting ? 'Updating…' : 'Update password'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
