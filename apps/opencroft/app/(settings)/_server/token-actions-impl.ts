// The pure token-mutation logic: takes userId as a plain argument and does no
// session work at all.
//
// Deliberately NOT in the same file as the createServerFn wrappers
// (token-actions.ts). That file is reached from the client — token-settings.tsx
// imports it — and the TanStack Start client build only replaces
// createServerFn-wrapped exports with RPC stubs, dropping their imports. A
// plain function sitting in that same file has no stub, and would ship
// @opencroft/db (and everything behind it) straight to the browser: the exact
// class of leak where a plain helper beside server functions reaches the client bundle,
// which has broken a production build before.
//
// The split is also what makes these testable directly, without standing up a
// request — see token-actions.test.ts.

import { apiToken, db } from '@opencroft/db'
import { and, desc, eq } from 'drizzle-orm'

import { hashToken } from '@/app/(mcp)/_server/token-hash'

const DEFAULT_EXPIRY_MS = 90 * 24 * 60 * 60 * 1000

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
