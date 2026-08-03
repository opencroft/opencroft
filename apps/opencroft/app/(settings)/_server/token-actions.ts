// A signed-in person's OWN API tokens: create, list, revoke. Self-service
// only — this never touches an agent token (subjectType 'agent'), and never
// another person's (every query is scoped to the caller's own userId).
//
// The page that calls these already sits behind the root session gate, but
// that guards NAVIGATION, not this RPC endpoint directly — a request could
// reach these handlers without ever rendering the page. So each createServerFn
// re-checks the session itself rather than trusting the page to have done it.
//
// The pure `*ForUser` functions below take userId as a plain argument and do
// no session work at all. That split is what makes them testable without
// standing up a request — a node:test file can call createTokenForUser
// directly against a throwaway database, which is how the two properties that
// stay non-negotiable (shown once, hash-only storage) are actually verified
// rather than asserted in a comment.

import { getSessionUser } from '@opencroft/auth/server'
import { apiToken, db } from '@opencroft/db'
import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import { and, desc, eq } from 'drizzle-orm'

import { hashToken } from '@/app/(mcp)/_server/token-hash'

const DEFAULT_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000

async function requireUserId(): Promise<string> {
  const user = await getSessionUser(getRequest())
  if (!user) {
    // The page cannot reach this state — root beforeLoad redirects first —
    // so this only fires against a direct request. A plain throw is enough:
    // there is no form on screen to show a nicer message to.
    throw new Error('Not signed in')
  }
  return user.id
}

export interface MyToken {
  id: string
  name: string
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
}

/**
 * Every token this person has ever created, live or not — a revoked or
 * expired one still needs to be visible, or "did I actually revoke that"
 * has no answer.
 */
export async function listTokensForUser(userId: string): Promise<MyToken[]> {
  const rows = await db
    .select({
      id: apiToken.id,
      name: apiToken.name,
      createdAt: apiToken.createdAt,
      lastUsedAt: apiToken.lastUsedAt,
      expiresAt: apiToken.expiresAt,
      revokedAt: apiToken.revokedAt,
    })
    .from(apiToken)
    .where(and(eq(apiToken.subjectType, 'user'), eq(apiToken.userId, userId)))
    .orderBy(desc(apiToken.createdAt))

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.createdAt.toISOString(),
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
  }))
}

export const listMyTokens = createServerFn({ method: 'GET' }).handler(
  async (): Promise<MyToken[]> => listTokensForUser(await requireUserId()),
)

export interface CreateTokenInput {
  name: string
  /** ISO date string. Omitted means the 90-day default below, NOT "never". */
  expiresAt?: string
}

export interface CreatedToken {
  id: string
  /**
   * Present exactly once, in this return value and nowhere else — not stored,
   * not logged, not returned by any other function. `listTokensForUser`'s
   * `MyToken` type has no field that could carry it back.
   */
  token: string
}

/**
 * Create a personal token for the given user. Expiry is required in
 * substance, not merely in the UI: a personal credential that never expires
 * is a decision nobody gets to make by simply leaving a field blank, so a
 * missing expiresAt gets the default rather than becoming "forever".
 */
export async function createTokenForUser(userId: string, input: CreateTokenInput): Promise<CreatedToken> {
  const name = input.name.trim()
  if (!name) {
    throw new Error('Name is required')
  }

  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + DEFAULT_EXPIRY_MS)
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error('Invalid expiry date')
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw new Error('Expiry must be in the future')
  }

  // Same shape as the agent-token minting script: oc_ prefix, 32 bytes of
  // CSPRNG, base64url. One format for every bearer credential in the app, so
  // a reader never has to ask which kind of token they are looking at.
  const { randomBytes } = await import('node:crypto')
  const token = `oc_${randomBytes(32).toString('base64url')}`

  const [row] = await db
    .insert(apiToken)
    .values({ subjectType: 'user', userId, name, expiresAt, tokenHash: hashToken(token) })
    .returning({ id: apiToken.id })

  return { id: row.id, token }
}

export const createMyToken = createServerFn({ method: 'POST' })
  .inputValidator((input: CreateTokenInput) => input)
  .handler(async ({ data }): Promise<CreatedToken> => createTokenForUser(await requireUserId(), data))

/**
 * Revoke one of a user's own tokens. Immediate — there is no cache in front
 * of token verification, so this takes effect on the very next request that
 * presents it.
 *
 * The WHERE clause is the ownership check, not an if-statement after a read:
 * an id that exists but belongs to someone else updates zero rows and looks
 * identical to an id that does not exist at all. Deliberate — the same
 * "do not tell a prober which guess was closer" reasoning as the bare 401 on
 * token verification.
 */
export async function revokeTokenForUser(userId: string, id: string): Promise<{ revokedAt: string }> {
  const [row] = await db
    .update(apiToken)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiToken.id, id), eq(apiToken.subjectType, 'user'), eq(apiToken.userId, userId)))
    .returning({ revokedAt: apiToken.revokedAt })

  if (!row?.revokedAt) {
    throw new Error('Token not found')
  }

  return { revokedAt: row.revokedAt.toISOString() }
}

export const revokeMyToken = createServerFn({ method: 'POST' })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<{ revokedAt: string }> => revokeTokenForUser(await requireUserId(), data.id))
