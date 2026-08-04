'use client'

import { signIn } from '@opencroft/auth/client'
import { useLoaderData, useRouter, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { AuthLoginForm } from 'ui/auth/auth-login-form'
import { AuthShell } from 'ui/auth/auth-shell'
import type { SocialProvider } from 'ui/auth/auth-social-buttons'

// Which providers exist is deployment configuration, resolved server-side (see
// the route's loader) so this screen offers only what can actually be honoured
// and starts offering a provider the moment its credentials are set, with no
// code change. The list is handed to the form, which renders those providers
// and — for a deployment with none — neither the buttons nor the separator
// above them.
//
// A backstop, not a path anyone should reach: the form is only given providers
// this deployment has, so an unconfigured one cannot be pressed. It stays
// because the guard is what makes that a fact rather than a promise, and the
// cost of it being wrong is a redirect to a provider that cannot sign anyone in.
const SOCIAL_UNAVAILABLE = 'Social sign-in is not configured on this instance. Use your email and password.'

export function LoginPage() {
  const router = useRouter()
  const search = useSearch({ from: '/(auth)/login' })
  const { socialProviders } = useLoaderData({ from: '/(auth)/login' })
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = () => {
    setError(undefined)
    if (!email.trim() || !password) {
      setError('Enter your email and password.')
      return
    }

    setSubmitting(true)
    void (async () => {
      try {
        const result = await signIn.email({ email: email.trim(), password })
        if (result.error) {
          // Deliberately not distinguishing "no such account" from "wrong
          // password": that difference tells an anonymous visitor which
          // addresses have accounts.
          setError('That email and password did not match.')
          return
        }
        // `redirect` is where the guard sent us from. Falling back to the root
        // rather than trusting an absent value keeps this from becoming a way
        // to bounce someone off-site.
        await router.navigate({ to: search.redirect ?? '/' })
      } catch {
        setError('Could not reach the server. Try again.')
      } finally {
        setSubmitting(false)
      }
    })()
  }

  const onSocialSelect = (provider: SocialProvider) => {
    if (!socialProviders.includes(provider)) {
      setError(SOCIAL_UNAVAILABLE)
      return
    }
    setError(undefined)
    setSubmitting(true)
    // Better Auth takes it from here: it redirects to the provider and back to
    // the callback, so there is nothing to await and no navigation to make.
    void signIn.social({ provider, callbackURL: search.redirect ?? '/' })
  }

  return (
    <AuthShell>
      <div className='flex flex-col gap-2 text-center'>
        <h1 className='text-2xl font-semibold'>Sign in to OpenCroft</h1>
        <p className='text-sm text-muted-foreground'>Use the account an administrator created for you.</p>
      </div>
      <AuthLoginForm
        email={email}
        onEmailChange={setEmail}
        password={password}
        onPasswordChange={setPassword}
        onSubmit={onSubmit}
        onSocialSelect={onSocialSelect}
        socialProviders={socialProviders}
        error={error}
        submitting={submitting}
      />
    </AuthShell>
  )
}
