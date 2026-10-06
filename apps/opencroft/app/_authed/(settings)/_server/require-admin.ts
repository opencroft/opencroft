import { AdminActionError, requireAdminUser } from '@opencroft/auth/server'
import { getRequest } from '@tanstack/react-start/server'

// `requireAdminUser` RETURNS the admin or null -- it does not throw -- so the
// result has to be acted on. A bare `await requireAdminUser(...)` with the
// value dropped type-checks and gates nothing. This mirrors the guard every
// admin-only function in packages/auth/src/server.ts already uses.
export async function requireAdmin(): Promise<void> {
  if (!(await requireAdminUser(getRequest()))) {
    throw new AdminActionError('forbidden', 'Only an administrator can access settings')
  }
}
