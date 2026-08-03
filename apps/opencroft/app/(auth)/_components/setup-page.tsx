'use client'

import { signIn } from '@opencroft/auth/client'
import type { SetupFailure } from '@opencroft/auth/server'
import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthAdminSetupForm } from 'ui/auth/auth-admin-setup-form'
import { AuthShell } from 'ui/auth/auth-shell'

import { completeSetup } from '@/app/(auth)/_server/setup'

// The copy lives here, not on the server. The server answers with which
// outcome happened; what a person is told about it is a screen's business, and
// keeping it this side means no server-composed prose can leak past it.
const FAILURE_MESSAGE: Record<SetupFailure, string> = {
  'already-completed': 'This instance has already been set up. Reload the page to sign in.',
  rejected: 'Those details were refused. Try a longer password, or a different email address.',
  failed: 'Setup could not be completed. The server log has the details.',
}

// Better Auth's own minimum. Checked here so the field says so before a
// round-trip, not instead of the server — the server still refuses.
const MIN_PASSWORD_LENGTH = 8

interface FieldErrors {
  name?: string
  email?: string
  password?: string
}

function validate(values: { name: string; email: string; password: string }): FieldErrors {
  const errors: FieldErrors = {}
  if (!values.name) {
    errors.name = 'Enter a name.'
  }
  // Deliberately permissive: the only claim worth making in the browser is
  // that this looks addressable. Anything stricter rejects valid addresses.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.email = 'Enter an email address.'
  }
  if (values.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return errors
}

/**
 * First-run screen: creates the administrator account, then signs it in.
 *
 * Whether this is reachable at all is the route's decision (see setup.tsx); by
 * the time this renders, the instance has no accounts.
 */
export function SetupPage() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = () => {
    const values = { name: name.trim(), email: email.trim(), password }
    const errors = validate(values)
    setFieldErrors(errors)
    setError(undefined)
    if (Object.keys(errors).length > 0) {
      return
    }

    setSubmitting(true)
    void (async () => {
      try {
        const result = await completeSetup({ data: values })
        if (!result.ok) {
          setError(FAILURE_MESSAGE[result.reason])
          return
        }
        // Creating the account does not sign this browser in — that needs a
        // cookie, which only a sign-in response carries. Doing it here also
        // proves the credentials just chosen work, before the screen goes away
        // for good.
        const signedIn = await signIn.email({ email: values.email, password: values.password })
        if (signedIn.error) {
          setError('The administrator was created, but signing in failed. Sign in manually to continue.')
          return
        }
        await router.navigate({ to: '/' })
      } catch {
        setError('Could not reach the server. Try again.')
      } finally {
        setSubmitting(false)
      }
    })()
  }

  return (
    <AuthShell>
      <div className='flex flex-col gap-2 text-center'>
        <h1 className='text-2xl font-semibold'>Set up OpenCroft</h1>
        <p className='text-sm text-muted-foreground'>
          This instance has no accounts yet. The one you create now is an administrator.
        </p>
      </div>
      <AuthAdminSetupForm
        name={name}
        onNameChange={setName}
        email={email}
        onEmailChange={setEmail}
        password={password}
        onPasswordChange={setPassword}
        onSubmit={onSubmit}
        nameError={fieldErrors.name}
        emailError={fieldErrors.email}
        passwordError={fieldErrors.password}
        error={error}
        submitting={submitting}
      />
    </AuthShell>
  )
}
