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

// Social sign-in is configuration, not code: a provider is offered when both
// halves of its credential are present and is simply absent otherwise. Nothing
// here needs changing to turn one on — set the pair and it appears.
const SOCIAL_PROVIDER_ENV = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
  apple: ['APPLE_CLIENT_ID', 'APPLE_CLIENT_SECRET'],
} as const

export type SocialProviderId = keyof typeof SOCIAL_PROVIDER_ENV

/**
 * The providers this deployment can actually sign a person in with.
 *
 * The screens render from this rather than from a hard-coded list, so a button
 * exists only when pressing it can work — an offer that cannot be honoured is
 * worse than no offer.
 */
export function configuredSocialProviders(): SocialProviderId[] {
  return (Object.keys(SOCIAL_PROVIDER_ENV) as SocialProviderId[]).filter((id) => {
    const [idVar, secretVar] = SOCIAL_PROVIDER_ENV[id]
    return Boolean(process.env[idVar]) && Boolean(process.env[secretVar])
  })
}

function socialProviders() {
  const entries = configuredSocialProviders().map((id) => {
    const [idVar, secretVar] = SOCIAL_PROVIDER_ENV[id]
    return [id, { clientId: process.env[idVar] as string, clientSecret: process.env[secretVar] as string }] as const
  })
  return Object.fromEntries(entries)
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
    // Read here rather than at import, so an unconfigured deployment still
    // starts and the provider list reflects the environment at first use.
    socialProviders: socialProviders(),
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

// Better Auth mounts registration under this prefix. Matched as a path segment
// so any future variant it adds under /sign-up is covered too, rather than only
// the one endpoint that exists today.
const SIGN_UP_PATH = /\/sign-up(\/|$)/

/** Whether a request is asking to register a new account over HTTP. */
export function isSignUpRequest(request: Request): boolean {
  return SIGN_UP_PATH.test(new URL(request.url).pathname)
}

/**
 * The app's auth endpoint.
 *
 * Registration over HTTP is refused, always. This app has no public sign-up:
 * the first account is created by the setup screen, which calls
 * `createFirstAdmin` in-process rather than over HTTP, and every later account
 * is an administrator's doing.
 *
 * The refusal is ours rather than Better Auth's `disableSignUp` for two
 * reasons. That option also blocks the in-process call, so first-run setup
 * would stop working. And a refusal we own cannot be undone by a library
 * default changing under a version bump, which is how this would otherwise
 * quietly reopen.
 *
 * It also does not depend on origin checking, which is what made the hole hard
 * to see: a request with no Origin header behaves differently from a browser's,
 * and differently again between development and production. This refuses the
 * path regardless of headers, environment or library configuration.
 */
export function handleAuthRequest(request: Request): Promise<Response> | Response {
  if (isSignUpRequest(request)) {
    return Response.json({ message: 'Registration is closed. Ask an administrator for an account.' }, { status: 403 })
  }
  return ensureAuth().handler(request)
}

/** How many accounts exist. Zero is what puts the app in first-run setup. */
export async function countUsers(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(user)
  return row?.value ?? 0
}

/**
 * Why setup could not complete. Callers render their own copy from this — the
 * messages on SetupError are for operators reading logs, and some of them name
 * things (an address to delete by hand) that must not travel to whoever posted
 * the form.
 */
export type SetupFailure =
  /** An account already exists; setup is over. */
  | 'already-completed'
  /** The details were refused — e.g. the password is too weak for the policy. */
  | 'rejected'
  /** Anything else. The real cause is in the server log. */
  | 'failed'

export class SetupError extends Error {
  constructor(
    readonly code: SetupFailure,
    message: string,
  ) {
    super(message)
    this.name = 'SetupError'
  }
}

export interface CreateFirstAdminInput {
  name: string
  email: string
  password: string
}

// An arbitrary but fixed key identifying the setup critical section. Postgres
// advisory locks are just an int64 agreed between callers; this one is only
// ever taken here.
const SETUP_ADVISORY_LOCK = '4872301996113004'

// Serialises setup within this process. This is the half that does the real
// work: both submissions of a form on one instance arrive at the same Node
// process, and it is also the only mechanism available under the embedded
// PGlite driver, which has a single connection and therefore cannot express a
// lock one caller holds against another.
let setupQueue: Promise<unknown> = Promise.resolve()

interface PoolLike {
  connect: () => Promise<{ query: (sql: string, values?: unknown[]) => Promise<unknown>; release: () => void }>
}

function poolOrNull(): PoolLike | null {
  // `$client` is the driver handle drizzle wraps — a pg Pool for a remote
  // Postgres, a PGlite instance for the embedded one. It is not on the shared
  // `DB` type, which deliberately hides which driver is behind it, so this is
  // the one place that looks.
  const client = (db as { $client?: Partial<PoolLike> }).$client
  return typeof client?.connect === 'function' ? (client as PoolLike) : null
}

/**
 * Take the setup lock. Returns the release, which callers must run in a
 * `finally` — a lock left held would make the instance permanently
 * un-set-up-able, which is the failure this is meant to prevent.
 */
async function acquireSetupLock(): Promise<() => Promise<void>> {
  let releaseLocal!: () => void
  const mine = new Promise<void>((resolve) => {
    releaseLocal = resolve
  })
  const ahead = setupQueue
  setupQueue = ahead.then(() => mine)
  await ahead

  // Past this point `mine` is already in the queue, so EVERY exit has to
  // resolve it. Anything that escapes without doing so leaves every later
  // caller waiting on a promise that will never settle — setup bricked until
  // the process restarts, which is the class of failure this whole function
  // exists to prevent.
  let connection: Awaited<ReturnType<PoolLike['connect']>> | null = null
  try {
    // Cross-process serialisation, for a remote Postgres shared by more than
    // one app instance. Session-scoped, so it has to be taken and released on
    // one pinned connection: released via the pool it could land on a
    // different connection and free nothing. Absent under PGlite, where there
    // is only ever one process anyway.
    const pool = poolOrNull()
    if (!pool) {
      return async () => releaseLocal()
    }
    // Inside the try on purpose: a pool that cannot hand out a connection
    // throws here, and that used to escape before anything released the queue.
    connection = await pool.connect()
    await connection.query('select pg_advisory_lock($1)', [SETUP_ADVISORY_LOCK])
    const held = connection
    return async () => {
      try {
        await held.query('select pg_advisory_unlock($1)', [SETUP_ADVISORY_LOCK])
      } finally {
        held.release()
        releaseLocal()
      }
    }
  } catch (error) {
    connection?.release()
    releaseLocal()
    throw error
  }
}

/**
 * Create the very first account and make it an administrator.
 *
 * Refuses once any account exists, so the route that calls it is safe to leave
 * reachable — the check is here rather than only in the caller, because this is
 * the thing that must not be re-runnable.
 *
 * Both hazards below end the same way: an instance nobody can administer, and
 * no route left that would fix it. That is why this is careful out of
 * proportion to how often it runs.
 *
 * 1. CHECK-AND-CREATE IS ONE CRITICAL SECTION. Two submissions arriving
 *    together would both see an empty table and both create an account. A
 *    session-level advisory lock serialises them, so the second waits and then
 *    sees the first one's user. It is taken on a dedicated connection because
 *    `pg_advisory_lock` is scoped to a session, and the pool would otherwise
 *    hand the unlock to a different connection than the lock.
 *
 * 2. THE TWO WRITES MUST NOT PART COMPANY. If the account is created and the
 *    role update then fails, an account exists, so setup refuses forever — and
 *    it is not an admin. The account is removed before rethrowing, which
 *    leaves the table empty and setup runnable, which is the only recoverable
 *    state.
 */
export async function createFirstAdmin(input: CreateFirstAdminInput): Promise<void> {
  const unlock = await acquireSetupLock()
  try {
    if ((await countUsers()) > 0) {
      throw new SetupError('already-completed', 'Setup has already been completed')
    }

    let created: { id: string }
    try {
      const signedUp = await ensureAuth().api.signUpEmail({ body: input })
      created = signedUp.user
    } catch (error) {
      // Better Auth rejected the details themselves — a password below its
      // policy, an address it will not accept. Nothing was created, so there
      // is nothing to undo.
      throw new SetupError('rejected', error instanceof Error ? error.message : 'Sign-up was refused')
    }

    // Both statements below address the row by the id sign-up returned, never
    // by the address as it was typed. Better Auth may store a normalised form
    // — lowercasing is usual — and then `Admin@Example.com` would match no row:
    // the promotion would find nothing, the check below would throw, the
    // rollback would delete nothing, and the instance would be left with an
    // account that is not an administrator and setup refusing to run again.
    // Addressing by id means the question of how the address was normalised
    // never arises.
    try {
      const promoted = await db
        .update(user)
        .set({ role: 'admin' })
        .where(eq(user.id, created.id))
        .returning({ id: user.id })
      // An update that matched nothing is as bad as one that threw: it leaves a
      // non-admin account behind and setup refusing to run again.
      if (promoted.length === 0) {
        throw new SetupError('failed', 'The account was created but could not be made an administrator')
      }
    } catch (error) {
      // Undo the account so the instance stays set-up-able. If this cleanup
      // itself fails there is nothing further to try, so say plainly what is
      // wrong and how to recover rather than surfacing the cleanup error.
      try {
        await db.delete(user).where(eq(user.id, created.id))
      } catch {
        throw new SetupError(
          'failed',
          'Setup failed after creating the account, and the account could not be removed. ' +
            `Delete the user with id "${created.id}" from the database before running setup again.`,
        )
      }
      throw error
    }
  } finally {
    await unlock()
  }
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
