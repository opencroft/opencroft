'use client'

import { useId } from 'react'

import { Button } from 'ui/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from 'ui/components/ui/field'
import { Input } from 'ui/components/ui/input'

export interface AuthAdminSetupFormProps {
  name: string
  onNameChange: (value: string) => void
  email: string
  onEmailChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  // Reports that the user asked to create the administrator. The form
  // validates nothing and calls nothing.
  onSubmit: () => void
  // Per-field messages, each shown under the field it belongs to. Displayed,
  // not decided: the host owns the rules that produced them.
  nameError?: string
  emailError?: string
  passwordError?: string
  // A whole-form failure -- setup rejected, or a server that did not answer.
  error?: string
  // The account is being created: the submit goes inert and says so.
  submitting?: boolean
  className?: string
}

// The form that creates the first administrator, with no page frame around it.
// A host supplies the heading that explains why it is being shown -- in the
// screens this came from, that no accounts exist yet.
//
// Fully controlled and free of the stack it came from: no form library, no
// router, no auth client.
export function AuthAdminSetupForm({
  name,
  onNameChange,
  email,
  onEmailChange,
  password,
  onPasswordChange,
  onSubmit,
  nameError,
  emailError,
  passwordError,
  error,
  submitting,
  className,
}: AuthAdminSetupFormProps) {
  // Generated rather than fixed: a docs page renders this form several times
  // over, and duplicate ids would point every label at the first field.
  const nameId = useId()
  const emailId = useId()
  const passwordId = useId()

  return (
    // method='post' so a submit before hydration is a POST with credentials in
    // the body, not the default GET that puts them in the URL. The handler
    // still preventDefault()s and does the real submit.
    <form
      method='post'
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <FieldGroup>
        <Field data-invalid={nameError ? true : undefined}>
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
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

        <Field data-invalid={emailError ? true : undefined}>
          <FieldLabel htmlFor={emailId}>Email</FieldLabel>
          <Input
            id={emailId}
            name='email'
            type='email'
            placeholder='admin@example.com'
            autoComplete='email'
            value={email}
            aria-invalid={emailError ? true : undefined}
            onChange={(event) => onEmailChange(event.target.value)}
          />
          <FieldError>{emailError}</FieldError>
        </Field>

        <Field data-invalid={passwordError ? true : undefined}>
          <FieldLabel htmlFor={passwordId}>Password</FieldLabel>
          <Input
            id={passwordId}
            name='password'
            type='password'
            autoComplete='new-password'
            value={password}
            aria-invalid={passwordError ? true : undefined}
            onChange={(event) => onPasswordChange(event.target.value)}
          />
          <FieldError>{passwordError}</FieldError>
        </Field>

        {/* Renders nothing at all when there is no message, so it can stay
            mounted rather than being conditionally spliced into the group. */}
        <FieldError>{error}</FieldError>

        <Field>
          <Button type='submit' disabled={submitting}>
            {submitting ? 'Creating admin…' : 'Create admin account'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
