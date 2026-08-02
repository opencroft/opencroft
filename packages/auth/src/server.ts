// The auth server: Better Auth over the app's existing Postgres connection.
//
// Server-only. Nothing here may be imported from client code — it pulls in the
// database connection and the whole Better Auth server runtime. The browser
// talks to it over HTTP through the `/api/auth/*` handler; see ./client.

import { db } from '@opencroft/db'
import { account, session, user, verification } from '@opencroft/db/schema'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { tanstackStartCookies } from 'better-auth/tanstack-start'
import { count, eq } from 'drizzle-orm'

// The placeholder an explicitly-development deployment falls back to. Fixed
// rather than random because sessions are signed with it: a value that changed
// per process would sign everyone out on every restart, which reads as a bug in
// session handling rather than as missing configuration.
const DEVELOPMENT_SECRET = 'opencroft-development-secret-not-for-production'

// Sessions are cookie-backed and the secret keys them, so this must be set
// anywhere real sessions matter.
//
// The fallback is gated on NODE_ENV being *explicitly* 'development', not on it
// not being 'production'. The production container leaves NODE_ENV unset
// entirely, so "not production" would quietly hand it a secret published in
// this repo — anyone could forge a session cookie. Unset means the throw, which
// is the safe direction to be wrong in: a deployment that has not been
// configured says so instead of pretending.
function resolveSecret(): string {
  const configured = process.env.BETTER_AUTH_SECRET
  if (configured) {
    return configured
  }
  if (process.env.NODE_ENV === 'development') {
    return DEVELOPMENT_SECRET
  }
  throw new Error(
    'BETTER_AUTH_SECRET is not set. Sessions are signed with it, so it is required ' +
      'outside development (set NODE_ENV=development to use the built-in placeholder). ' +
      'Use at least 32 random characters, and keep it stable — changing it signs everyone out.',
  )
}

// Built on first use, not at import.
//
// This module is reached from the route that mounts the handler, so building
// eagerly would make an unconfigured deployment fail at boot — the whole app,
// not just sign-in. Deferring it means such a deployment starts, serves every
// page, and fails only where auth is actually used, with an error naming the
// variable to set.
function buildAuth() {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: 'pg',
      // The tables live in the db package; pass them explicitly rather than
      // relying on the adapter inferring them from the full schema object.
      schema: { user, session, account, verification },
    }),
    secret: resolveSecret(),
    // `baseURL` is left unset so the handler answers on whatever origin it is
    // reached through — the app is served on several (proxy domain, container
    // name, localhost) and pinning one breaks the others.
    emailAndPassword: {
      enabled: true,
      // No email delivery exists yet, so requiring verification would make
      // every account unusable the moment it is created. The seam is here when
      // it does.
      requireEmailVerification: false,
    },
    // `admin()` supplies the role/ban columns the first-run administrator
    // needs. `tanstackStartCookies()` is what makes Set-Cookie work under
    // TanStack Start.
    plugins: [admin(), tanstackStartCookies()],
  })
}

// Inferred from the builder rather than annotated: betterAuth's return type is
// narrowed by the options passed, and a `ReturnType<typeof betterAuth>`
// annotation widens it to the generic default, which the concrete instance is
// not assignable to.
let instance: ReturnType<typeof buildAuth> | null = null

export function ensureAuth(): ReturnType<typeof buildAuth> {
  instance ??= buildAuth()
  return instance
}

/** How many accounts exist. Zero is what puts the app in first-run setup. */
export async function countUsers(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(user)
  return row?.value ?? 0
}

export interface CreateFirstAdminInput {
  name: string
  email: string
  password: string
}

/**
 * Create the very first account and make it an administrator.
 *
 * Refuses once any account exists, so the route that calls it is safe to leave
 * reachable — the check is here rather than only in the caller, because this is
 * the thing that must not be re-runnable.
 */
export async function createFirstAdmin(input: CreateFirstAdminInput): Promise<void> {
  if ((await countUsers()) > 0) {
    throw new Error('Setup has already been completed')
  }
  await ensureAuth().api.signUpEmail({ body: input })
  await db.update(user).set({ role: 'admin' }).where(eq(user.email, input.email))
}

/**
 * The user behind a request, or null when there is no valid session.
 *
 * This is the seam the app asks "who is this request" through — route guards
 * and, later, anything that needs an actor. Returns null rather than throwing
 * so callers decide what an anonymous request means for them.
 */
export async function getSessionUser(request: Request) {
  const result = await ensureAuth().api.getSession({ headers: request.headers })
  return result?.user ?? null
}
