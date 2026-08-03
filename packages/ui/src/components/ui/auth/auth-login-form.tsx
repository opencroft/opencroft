'use client'

import { useId } from 'react'

import { AuthSocialButtons, type SocialProvider } from '@/components/ui/auth/auth-social-buttons'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

export interface AuthLoginFormProps {
  email: string
  onEmailChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  // Reports that the user asked to sign in. The form validates nothing and
  // calls nothing -- what happens next, and what comes back, is the host's.
  onSubmit: () => void
  onSocialSelect: (provider: SocialProvider) => void
  // Per-field messages, each shown under the field it belongs to. Displayed,
  // not decided: the host owns the rules that produced them.
  emailError?: string
  passwordError?: string
  // A whole-form failure -- a rejected sign-in, an unreachable server.
  error?: string
  // A sign-in is in flight: the submit goes inert and says so.
  submitting?: boolean
  className?: string
}

// The sign-in form, with no page frame around it: a host supplies its own
// heading, shell and footer.
//
// Fully controlled and free of the stack it came from -- no form library, no
// router, no auth client. Values come in as props and every outcome leaves as
// a callback.
export function AuthLoginForm({
  email,
  onEmailChange,
  password,
  onPasswordChange,
  onSubmit,
  onSocialSelect,
  emailError,
  passwordError,
  error,
  submitting,
  className,
}: AuthLoginFormProps) {
  // Generated rather than fixed: a docs page renders this form several times
  // over, and duplicate ids would point every label at the first field.
  const emailId = useId()
  const passwordId = useId()

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <FieldGroup>
        <Field data-invalid={emailError ? true : undefined}>
          <FieldLabel htmlFor={emailId}>Email</FieldLabel>
          <Input
            id={emailId}
            name='email'
            type='email'
            placeholder='m@example.com'
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
            autoComplete='current-password'
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
            {submitting ? 'Signing in…' : 'Login'}
          </Button>
        </Field>

        <FieldSeparator>Or</FieldSeparator>

        <AuthSocialButtons onSelect={onSocialSelect} />
      </FieldGroup>
    </form>
  )
}
