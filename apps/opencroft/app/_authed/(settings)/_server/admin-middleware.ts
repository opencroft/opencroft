import { AdminActionError, requireAdminUser } from '@opencroft/auth/server'
import { createMiddleware } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

// The admin gate for server functions, in one place.
//
// A `createServerFn` is a directly callable RPC endpoint regardless of which
// page links to it, so the `_authed` route guard is UX only (see app/_authed.tsx)
// and the real authorization has to sit on the function itself. This is that
// check, as a middleware rather than a `requireAdminUser` line repeated in each
// handler body: a handler-body guard is invisible when it is left out, so the
// default for a new endpoint on an admin surface is "open", and the gap is only
// found later. Attaching a middleware is visible in the declaration, is the same
// object everywhere (one definition of what "admin" means), and a surface can
// assert every one of its endpoints carries it — which a scatter of identical
// guard statements cannot.
//
// Attach with `.middleware([adminOnly])` in the createServerFn chain, in the
// same file as `.handler(...)`: the Start compiler only splits the handler off
// the client bundle when the whole `createServerFn().….handler()` chain is in
// one file, so this cannot be hidden behind a factory wrapper without shipping
// the handler body to the browser. The middleware's own `.server` body IS
// stripped from the client build, so attaching it pulls no auth/db code into
// the browser.
//
// `requireAdminUser` returns the admin or null — it does not throw — so the
// result is acted on here, failing closed: no resolved admin means the call is
// refused before the handler runs.
export const adminOnly = createMiddleware({ type: 'function' }).server(async ({ next }) => {
  if (!(await requireAdminUser(getRequest()))) {
    throw new AdminActionError('forbidden', 'Only an administrator may call this endpoint')
  }
  return next()
})
