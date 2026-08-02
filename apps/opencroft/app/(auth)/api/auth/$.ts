import { ensureAuth } from '@opencroft/auth/server'
import { createFileRoute } from '@tanstack/react-router'

// Better Auth's own endpoints (sign-in, sign-out, session, and the rest) live
// under this splat. It must stay reachable without a session for the obvious
// reason: signing in is how you get one.
//
// `ensureAuth()` rather than a module-level instance: building it needs
// BETTER_AUTH_SECRET, and doing that at import would take the whole app down at
// boot on a deployment that has not set it. Built here instead, so such a
// deployment serves every page and fails only on these endpoints, naming the
// variable.
export const Route = createFileRoute('/(auth)/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => ensureAuth().handler(request),
      POST: ({ request }) => ensureAuth().handler(request),
    },
  },
})
