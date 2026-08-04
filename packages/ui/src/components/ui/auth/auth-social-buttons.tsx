'use client'

import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { cn } from '@/lib/utils'

export type SocialProvider = 'apple' | 'google'

// The providers and their marks are the design, not the host's data: these two
// are what the auth screens know how to offer. Which of them a given
// deployment has credentials for is the host's business, and arrives as
// `providers`. Their marks are drawn here because lucide carries no brand
// icons, and they take no dimensions of their own -- the button sizes its own
// svg children, so an explicit size here would fight it.
const PROVIDERS: Array<{ id: SocialProvider; label: string; icon: ReactNode }> = [
  {
    id: 'apple',
    label: 'Continue with Apple',
    icon: (
      <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' aria-hidden='true'>
        <path
          d='M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'
          fill='currentColor'
        />
      </svg>
    ),
  },
  {
    id: 'google',
    label: 'Continue with Google',
    icon: (
      <svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' aria-hidden='true'>
        <path
          d='M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z'
          fill='currentColor'
        />
      </svg>
    ),
  },
]

export interface AuthSocialButtonsProps {
  // Reports the chosen provider. The sign-in itself, and whatever happens
  // after it, belong to the host.
  onSelect: (provider: SocialProvider) => void
  // Which providers this deployment has configured. Omit to offer every one
  // the component knows; an empty list renders nothing at all, so a screen
  // never advertises a sign-in method that is not actually wired up.
  providers?: SocialProvider[]
  // The offered buttons go inert -- for a host that is already signing in.
  disabled?: boolean
  className?: string
}

// The "Continue with Apple / Google" pair from the auth screens.
//
// Two up from the `sm` breakpoint and stacked below it, so it holds at a phone
// width without the caller arranging anything. With one provider offered it is
// a single full-width button, which the same grid already gives.
export function AuthSocialButtons({ onSelect, providers, disabled, className }: AuthSocialButtonsProps) {
  // Filtering PROVIDERS rather than mapping the prop keeps the order the
  // design chose, whatever order the host lists them in, and drops any name
  // this component has no mark for instead of rendering a blank button.
  const offered = providers ? PROVIDERS.filter((provider) => providers.includes(provider.id)) : PROVIDERS

  // Nothing configured: render nothing, not an empty box. The caller owns
  // whatever sat above it -- see auth-login-form's "Or" separator.
  if (offered.length === 0) return null

  return (
    <Field className={cn('grid gap-4 sm:grid-cols-2', className)}>
      {offered.map((provider) => (
        <Button
          key={provider.id}
          type='button'
          variant='outline'
          disabled={disabled}
          onClick={() => onSelect(provider.id)}
        >
          {provider.icon} {provider.label}
        </Button>
      ))}
    </Field>
  )
}
