import { createFileRoute, redirect } from '@tanstack/react-router'

import { LoginPage } from '@/app/(auth)/_components/login-page'
import { safeRedirect } from '@/app/(auth)/_lib/safe-redirect'
import { getAuthState, getSocialProviders } from '@/app/(auth)/_server/session'

// Reachable without a session — it is how you get one.
//
// Someone already signed in is sent on rather than shown the form again, and
// an instance with no accounts at all belongs in setup: signing in is
// impossible before an account exists, so offering the form would be a dead
// end.
export const Route = createFileRoute('/(auth)/login')({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    // Reduced to a path on this origin, or dropped. See safe-redirect.ts for
    // why this resolves an origin rather than matching prefixes — the prefix
    // form this replaces let `/\evil.com` through.
    redirect: safeRedirect(search.redirect),
  }),
  beforeLoad: async () => {
    const state = await getAuthState()
    if (state.needsSetup) {
      throw redirect({ to: '/setup' })
    }
    if (state.signedIn) {
      throw redirect({ to: '/' })
    }
  },
  // What this deployment can actually sign someone in with. Loaded rather than
  // assumed, so the screen self-enables the day credentials are configured.
  loader: async () => ({ socialProviders: await getSocialProviders() }),
  component: LoginPage,
})
