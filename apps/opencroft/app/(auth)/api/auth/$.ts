import { handleAuthRequest } from '@opencroft/auth/server'
import { createFileRoute } from '@tanstack/react-router'

// Better Auth's own endpoints (sign-in, sign-out, session, and the rest) live
// under this splat. It must stay reachable without a session for the obvious
// reason: signing in is how you get one.
//
// Registration is refused here — see handleAuthRequest. This app has no public
// sign-up; accounts come from setup or from an administrator.
//
// The handler builds the auth instance on first use rather than at import,
// because building it needs BETTER_AUTH_SECRET and doing that at import would
// take the whole app down at boot on a deployment that has not set it.
export const Route = createFileRoute('/(auth)/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request),
      POST: ({ request }) => handleAuthRequest(request),
    },
  },
})
