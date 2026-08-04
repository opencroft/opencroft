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
    user: {
      // Same reasoning as `requireEmailVerification` above: this instance has
      // no email delivery, so a confirmation-mail flow would just fail. The
      // change is applied immediately instead of pretending a confirmation
      // step exists when nothing can send it. The seam is here for when it
      // does.
      changeEmail: { enabled: true, updateEmailWithoutVerification: true },
    },
    // Stamps `user.lastSeenAt` on every sign-in. Deliberately not derived from
    // the session table at read time (see the column's own comment in
    // auth-schema.ts): banning a user deletes its sessions, which would erase
    // a derived value right when an administrator most needs it.
    databaseHooks: {
      session: {
        create: {
          after: async (created) => {
            await db.update(user).set({ lastSeenAt: new Date() }).where(eq(user.id, created.userId))
          },
        },
      },
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

// ─────────────────────────────────────────────────────────────────────────
// Administration: role enforcement, admin-managed accounts, and the
// single-administrator lockout this area exists to close through a
// supported door instead of a console paste.
//
// `role` has been stored since the first-run administrator was created, but
// nothing before this read it. Every function below that acts on someone
// else's account is the enforcement — not the field, which already existed.
// ─────────────────────────────────────────────────────────────────────────

export const ADMIN_ROLE = 'admin'

// The only two roles `admin()` is configured with (its defaults: `defaultRole`
// 'user', `adminRoles` ['admin']). Typed explicitly here because Better
// Auth's admin endpoints infer this same union from that configuration and
// reject a bare `string`, which would otherwise make a typo in a role value
// a runtime failure instead of a compile-time one.
export type Role = 'admin' | 'user'

/**
 * The signed-in administrator behind a request, or null when there is none —
 * either nobody is signed in, or they are signed in as a non-admin.
 *
 * This is the one place that decides "is this request allowed to act as an
 * administrator". Every admin-only server function calls it directly, rather
 * than trusting a route guard: a `createServerFn` is a callable HTTP endpoint
 * in its own right, reachable without ever going through the page that
 * normally leads to it, so the route-level redirect in `__root.tsx` is UX,
 * not the boundary. This is the boundary, and it is the single source other
 * admin-only areas (e.g. API token management) are expected to call rather
 * than re-implement.
 */
export async function requireAdminUser(request: Request) {
  const sessionUser = await getSessionUser(request)
  return sessionUser?.role === ADMIN_ROLE ? sessionUser : null
}

/** How many accounts currently hold the administrator role. */
export async function countAdmins(): Promise<number> {
  const [row] = await db.select({ value: count() }).from(user).where(eq(user.role, ADMIN_ROLE))
  return row?.value ?? 0
}

/**
 * Whether the instance currently has exactly one administrator — the state
 * this check exists to make visible rather than silent. A warning
 * surface reads this; it does not gate anything by itself.
 */
export async function hasSingleAdmin(): Promise<boolean> {
  return (await countAdmins()) === 1
}

/**
 * Whether `userId` is the only administrator left. Deleting, disabling or
 * demoting this account would leave the instance with none.
 *
 * Checked fresh against the database on every call rather than cached — the
 * count changes underneath this as other admins are added or removed, and a
 * stale answer here is exactly the bug this whole area exists to prevent.
 */
async function isSoleAdmin(userId: string): Promise<boolean> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId))
  if (row?.role !== ADMIN_ROLE) {
    // Not an admin at all, so removing them cannot be the thing that zeroes
    // the count.
    return false
  }
  return (await countAdmins()) === 1
}

/** Why an admin-only action did not go through. */
export type AdminActionFailure =
  /** The caller is not signed in as an administrator. */
  | 'forbidden'
  /** The action would leave the instance with no administrator. */
  | 'last-admin'
  /** Better Auth or a validator refused the details themselves. */
  | 'rejected'

export class AdminActionError extends Error {
  constructor(
    readonly code: AdminActionFailure,
    message: string,
  ) {
    super(message)
    this.name = 'AdminActionError'
  }
}

export interface AdminListedUser {
  id: string
  name: string
  email: string
  image: string | null
  role: string | null
  disabled: boolean
  createdAt: Date
  lastSeenAt: Date | null
}

/** Every account, for the administrator's users list. Admin-only. */
export async function listUsersAsAdmin(request: Request): Promise<AdminListedUser[]> {
  if (!(await requireAdminUser(request))) {
    throw new AdminActionError('forbidden', 'Only an administrator can list accounts')
  }
  const rows = await db.select().from(user)
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    role: row.role,
    disabled: row.banned ?? false,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  }))
}

/** One account, for the user-edit page. Admin-only; null if no such account. */
export async function getUserAsAdmin(request: Request, userId: string): Promise<AdminListedUser | null> {
  if (!(await requireAdminUser(request))) {
    throw new AdminActionError('forbidden', 'Only an administrator can view an account')
  }
  const [row] = await db.select().from(user).where(eq(user.id, userId))
  if (!row) {
    return null
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    role: row.role,
    disabled: row.banned ?? false,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  }
}

export interface CreateUserAsAdminInput {
  name: string
  email: string
  password: string
  role: Role
}

/** Create an account as an administrator. Admin-only. */
export async function createUserAsAdmin(request: Request, input: CreateUserAsAdminInput) {
  if (!(await requireAdminUser(request))) {
    throw new AdminActionError('forbidden', 'Only an administrator can create accounts')
  }
  try {
    const result = await ensureAuth().api.createUser({
      body: { name: input.name, email: input.email, password: input.password, role: input.role },
      headers: request.headers,
    })
    return result.user
  } catch (error) {
    throw new AdminActionError('rejected', error instanceof Error ? error.message : 'The account could not be created')
  }
}

export interface UpdateUserAsAdminInput {
  name: string
  email: string
  role: Role
}

/**
 * Change another account's name, email and role. Admin-only.
 *
 * Refuses to change the role away from administrator when this account is
 * the only one left — the same lockout as deleting it, arriving through the
 * role field instead of the delete button. `updateUserAsAdmin` and
 * `deleteUserAsAdmin` share this check for exactly that reason: from the
 * instance's point of view, losing its last administrator is the same
 * failure however it happens.
 */
export async function updateUserAsAdmin(request: Request, userId: string, input: UpdateUserAsAdminInput) {
  if (!(await requireAdminUser(request))) {
    throw new AdminActionError('forbidden', 'Only an administrator can edit accounts')
  }
  if (input.role !== ADMIN_ROLE && (await isSoleAdmin(userId))) {
    throw new AdminActionError(
      'last-admin',
      'This is the only administrator. Make someone else an administrator first.',
    )
  }
  try {
    await ensureAuth().api.adminUpdateUser({
      body: { userId, data: { name: input.name, email: input.email } },
      headers: request.headers,
    })
    await ensureAuth().api.setRole({ body: { userId, role: input.role }, headers: request.headers })
  } catch (error) {
    throw new AdminActionError('rejected', error instanceof Error ? error.message : 'The account could not be updated')
  }
}

/**
 * Flip whether an account may sign in. Admin-only, and reversible — unlike
 * delete, disabling is meant to be turned back on.
 *
 * Refuses to disable the only administrator: a disabled sole admin is
 * exactly as locked out as a deleted one, since nobody else can sign in to
 * re-enable them. Re-enabling is always allowed — that direction can only
 * repair the lockout, never cause it.
 */
export async function setUserDisabledAsAdmin(request: Request, userId: string, disabled: boolean) {
  if (!(await requireAdminUser(request))) {
    throw new AdminActionError('forbidden', 'Only an administrator can change sign-in access')
  }
  if (disabled && (await isSoleAdmin(userId))) {
    throw new AdminActionError(
      'last-admin',
      'This is the only administrator. Make someone else an administrator before disabling this account.',
    )
  }
  const auth = ensureAuth()
  try {
    if (disabled) {
      await auth.api.banUser({ body: { userId }, headers: request.headers })
    } else {
      await auth.api.unbanUser({ body: { userId }, headers: request.headers })
    }
  } catch (error) {
    throw new AdminActionError(
      'rejected',
      error instanceof Error ? error.message : 'Sign-in access could not be changed',
    )
  }
}

/**
 * Delete another account. Admin-only.
 *
 * Refuses when the target is the last administrator — whether that admin is
 * deleting someone else's account or their own, the failure being refused is
 * the same one: zero administrators left. This is the lockout the guard is
 * named after, arriving through the delete button instead of a lost
 * password.
 */
export async function deleteUserAsAdmin(request: Request, userId: string): Promise<void> {
  if (!(await requireAdminUser(request))) {
    throw new AdminActionError('forbidden', 'Only an administrator can delete accounts')
  }
  if (await isSoleAdmin(userId)) {
    throw new AdminActionError(
      'last-admin',
      'This is the only administrator. Make someone else an administrator before deleting this account.',
    )
  }
  try {
    await ensureAuth().api.removeUser({ body: { userId }, headers: request.headers })
  } catch (error) {
    // Better Auth's own admin plugin refuses self-removal unconditionally —
    // "You cannot remove yourself" — independent of and in addition to the
    // last-admin check above. An admin with peers still cannot delete their
    // own account through this path; someone else has to. That is stricter
    // than required, not looser, so it is left as-is
    // rather than routed around.
    throw new AdminActionError('rejected', error instanceof Error ? error.message : 'The account could not be deleted')
  }
}

// ── Self-service: a signed-in person acting on their own account ──────────

/** The signed-in person's own profile, for the account settings screen. */
export async function getOwnAccount(request: Request) {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) {
    return null
  }
  return { id: sessionUser.id, name: sessionUser.name, email: sessionUser.email, image: sessionUser.image ?? null }
}

export async function updateOwnProfile(request: Request, name: string): Promise<void> {
  await ensureAuth().api.updateUser({ body: { name }, headers: request.headers })
}

// An avatar is stored as a data URL in `user.image`, the same shape an agent
// node stores its own avatar in — no upload endpoint and no object store, a
// string in a column.
//
// The caller downscales before sending, but that is presentation: a server
// function is a callable endpoint regardless of which screen calls it, so the
// only bound that actually holds is this one. It matters more here than for an
// agent node because these rows are read back as a LIST — the administrator's
// user list carries every avatar at once, so one oversized row is paid for on
// every load of that page by everyone.
//
// Measured in characters rather than bytes: base64 is one character per byte
// to within a rounding error, and the point is a ceiling, not an audit.
const MAX_AVATAR_CHARS = 64 * 1024
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/

/**
 * Set or clear the signed-in person's own avatar. `null` clears it.
 *
 * Refuses anything that is not a small, self-contained image data URL —
 * notably an `http(s)` URL, which would turn every render of this person into
 * a request to somewhere else chosen by them.
 */
export async function updateOwnAvatar(request: Request, image: string | null): Promise<void> {
  if (image !== null) {
    if (!AVATAR_DATA_URL.test(image)) {
      throw new Error('An avatar must be a PNG, JPEG or WebP image.')
    }
    if (image.length > MAX_AVATAR_CHARS) {
      throw new Error('That image is too large to store. Choose a smaller one.')
    }
  }
  await ensureAuth().api.updateUser({ body: { image }, headers: request.headers })
}

/**
 * Change the signed-in person's own email. Applied immediately rather than
 * through a confirmation link — this instance has no email delivery to send
 * one with, so `changeEmail` is configured with `updateEmailWithoutVerification`
 * (see `buildAuth` above), and this is that decision's one caller.
 */
export async function changeOwnEmail(request: Request, newEmail: string): Promise<void> {
  await ensureAuth().api.changeEmail({ body: { newEmail }, headers: request.headers })
}

export async function changeOwnPassword(
  request: Request,
  input: { currentPassword: string; newPassword: string },
): Promise<void> {
  await ensureAuth().api.changePassword({
    body: { currentPassword: input.currentPassword, newPassword: input.newPassword },
    headers: request.headers,
  })
}
