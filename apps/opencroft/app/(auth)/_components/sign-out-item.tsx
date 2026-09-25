'use client'

import { signOut, useSession } from '@opencroft/auth/client'
import { useRouter } from '@tanstack/react-router'

/**
 * Signing out is an action, not a screen.
 *
 * The demo these screens came from had a logout page, but once its header and
 * footer were stripped there was nothing left of it — which is the answer: a
 * page here would only ask someone to confirm the thing they just asked for.
 *
 * Returns null when there is no session, so the auth screens (which sit
 * outside the shell anyway) never show a way to sign out of nothing.
 */
export function useSignOut(): (() => void) | null {
  const router = useRouter()
  const { data: session } = useSession()

  if (!session) {
    return null
  }

  return () => {
    void (async () => {
      await signOut()
      // A full navigation rather than a router push: everything already
      // rendered was loaded for the account being signed out, and the guard
      // should decide what this browser may see next from scratch.
      await router.invalidate()
      await router.navigate({ to: '/login' })
    })()
  }
}
