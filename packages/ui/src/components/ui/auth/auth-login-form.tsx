'use client'

import { useId } from 'react'

import { AuthSocialButtons, type SocialProvider } from 'ui/components/ui/auth/auth-social-buttons'
import { Button } from 'ui/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from 'ui/components/ui/field'
import { Input } from 'ui/components/ui/input'

export interface AuthLoginFormProps {
  email: string
  onEmailChange: (value: string) => void
  password: string
  onPasswordChange: (value: string) => void
  // Reports that the user asked to sign in. The form validates nothing and
  // calls nothing -- what happens next, and what comes back, is the host's.
  onSubmit: () => void
  onSocialSelect: (provider: SocialProvider) => void
  // Which social providers this deployment has configured. Omit to offer every
  // provider the pair knows; an empty list renders neither the buttons nor the
  // "Or" separator above them, leaving an email-only sign-in.
  socialProviders?: SocialProvider[]
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
  socialProviders,
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

  // Omitted means every provider the pair knows; an empty list is a deployment
  // with none configured. The separator belongs to this form rather than to the
  // pair, so dropping it is this component's job -- an "Or" introducing nothing
  // is worse than no separator at all.
  const offersSocial = socialProviders === undefined || socialProviders.length > 0

  return (
    // method='post' so a submit before hydration (before this handler attaches)
    // is a POST with credentials in the body, not the default GET that puts
    // them in the URL. The handler still preventDefault()s and does the real
    // submit; this only changes the pre-hydration fallback.
    <form
      method='post'
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

        {offersSocial ? (
          <>
            <FieldSeparator>Or</FieldSeparator>

            <AuthSocialButtons
              providers={socialProviders}
              onSelect={onSocialSelect}
              // A sign-in already in flight takes the pair inert along with the
              // submit, so a second one cannot be started to race the first.
              disabled={submitting}
            />
          </>
        ) : null}
      </FieldGroup>
    </form>
  )
}
