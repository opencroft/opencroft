import { createHash, timingSafeEqual } from 'node:crypto'

import { db, mcpCaller, mcpToken } from '@opencroft/db'
import { and, eq, isNull, or, sql } from 'drizzle-orm'

import { hashToken } from '@/app/_authed/(mcp)/_server/token-hash'
import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'

/**
 * Who is calling the MCP endpoint.
 *
 * The endpoint accepts exactly one credential: an MCP token, issued to one
 * agent node. A caller resolves to that node — or to nobody, and the endpoint
 * refuses nobody. A personal access token is not an MCP token and resolves to
 * nobody here, because this reads the McpToken table and nothing else.
 */

export type CredentialState = 'present' | 'absent' | 'unknown'

export interface Caller {
  credential: CredentialState
  /** The node's name as it read when the token resolved — for display. */
  agent: string | null
  /** The identity: the agent node the token was issued to. */
  agentNodeId: string | null
  tokenId: string | null
}

export const ANONYMOUS: Caller = { credential: 'absent', agent: null, agentNodeId: null, tokenId: null }

const UNRESOLVED: Caller = { credential: 'unknown', agent: null, agentNodeId: null, tokenId: null }

/**
 * `Authorization: Bearer <token>` — the standard place, so an external MCP
 * client can carry a credential using configuration it already has rather than
 * a bespoke header. (A bespoke header is also what the `x-opencroft-internal`
 * mistake looked like, and that one turned out to be a free privilege
 * escalation for anyone who guessed the name.)
 */
function bearerFrom(request: Request): string | null {
  const header = request.headers.get('authorization')
  if (!header) {
    return null
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match?.[1]?.trim() || null
}

export async function resolveCaller(request: Request): Promise<Caller> {
  const presented = bearerFrom(request)
  if (!presented) {
    return ANONYMOUS
  }

  try {
    return await lookup(presented)
  } catch (e) {
    // Fails closed: a caller whose token could not be checked is a caller
    // without an accepted token, and the endpoint refuses it like any other.
    console.error('[mcp-auth] token lookup failed, treating caller as unresolved', e)
    return UNRESOLVED
  }
}

async function lookup(presented: string): Promise<Caller> {
  const presentedHash = hashToken(presented)

  // Look up by hash rather than scanning: the unique index does the work, and
  // the comparison below is belt-and-braces against a future change that makes
  // this a scan.
  //
  // Expiry is enforced HERE, not by a background sweep — a token past its
  // expiresAt must stop working the instant it is presented, not whenever a
  // cleanup job next runs. A deleted token has no row, so it fails the same
  // lookup an unknown one does.
  const rows = await db
    .select({ id: mcpToken.id, agentNodeId: mcpToken.agentNodeId, tokenHash: mcpToken.tokenHash })
    .from(mcpToken)
    .where(
      and(eq(mcpToken.tokenHash, presentedHash), or(isNull(mcpToken.expiresAt), sql`${mcpToken.expiresAt} > now()`)),
    )
    .limit(1)

  const row = rows[0]
  if (!row) {
    // Presented something, and it does not resolve. Deliberately not the same
    // as presenting nothing — this is a client that WAS configured and is now
    // wrong (deleted, expired, a personal token, a typo), which needs a
    // person, not a rollout.
    return UNRESOLVED
  }

  // Both sides are fixed-length hex of the same digest, so the lengths match
  // and timingSafeEqual cannot throw here.
  const a = Buffer.from(row.tokenHash, 'utf8')
  const b = Buffer.from(presentedHash, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return UNRESOLVED
  }

  // The node has no relational row to cascade from, so a token can outlive
  // the agent it was issued to. It resolves to nobody then, rather than to an
  // identity no agent holds.
  const node = (await listAgentNodesImpl()).find((candidate) => candidate.nodeId === row.agentNodeId)
  if (!node) {
    return UNRESOLVED
  }

  return { credential: 'present', agent: node.name || null, agentNodeId: row.agentNodeId, tokenId: row.id }
}

function fingerprintOf(parts: (string | null)[]): string {
  // Newline-joined with a null marker so ['a', null] and ['a', ''] differ, and
  // so a value containing the separator cannot forge a different tuple.
  return createHash('sha256')
    .update(parts.map((p) => (p === null ? '\0' : p)).join('\n'), 'utf8')
    .digest('hex')
}

/**
 * The source address, as far as it can be trusted.
 *
 * `x-forwarded-for` is caller-controlled — anyone can claim any address. It is
 * recorded because behind the reverse proxy it is the only way to tell two
 * clients apart when counting them. It must NOT be used for access control.
 */
function sourceOf(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() || null
  }
  return request.headers.get('x-real-ip')
}

export interface ObservationInput {
  caller: Caller
  method: string
  tool: string | null
  request: Request
}

/**
 * Record that this caller was seen — refused ones included — aggregating onto
 * one row per distinct (caller, method, tool) combination rather than one per
 * request. NOT one row per caller: a caller invoking two different tools
 * produces two rows. See McpCaller in the schema for why the grain is that.
 *
 * Also stamps the token's lastUsedAt, which is what tells a person looking at
 * an agent's tokens which one a client is actually using.
 *
 * Never throws: bookkeeping must not be able to fail a request. A recording
 * error is worth a log line and nothing more.
 */
export async function recordCaller({ caller, method, tool, request }: ObservationInput): Promise<void> {
  const sourceIp = sourceOf(request)
  const userAgent = request.headers.get('user-agent')
  const fingerprint = fingerprintOf([caller.credential, caller.agentNodeId, method, tool, sourceIp, userAgent])

  // A fixed prefix so the per-request trace is one grep over the application
  // log for lines starting `[mcp-caller]`. The log gives the sequence of
  // individual calls; McpCaller gives the population, which the table cannot
  // give you the other way round because it deliberately collapses them.
  console.log(
    `[mcp-caller] credential=${caller.credential} agent=${caller.agentNodeId ?? '-'} method=${method} ` +
      `tool=${tool ?? '-'} ip=${sourceIp ?? '-'} ua=${JSON.stringify(userAgent ?? '-')}`,
  )

  try {
    const now = new Date()
    await db
      .insert(mcpCaller)
      .values({
        fingerprint,
        credential: caller.credential,
        agent: caller.agent,
        agentNodeId: caller.agentNodeId,
        method,
        tool,
        sourceIp,
        userAgent,
        firstSeenAt: now,
        lastSeenAt: now,
        seenCount: 1,
      })
      .onConflictDoUpdate({
        target: mcpCaller.fingerprint,
        set: { lastSeenAt: now, seenCount: sql`${mcpCaller.seenCount} + 1` },
      })

    if (caller.tokenId) {
      await db.update(mcpToken).set({ lastUsedAt: now }).where(eq(mcpToken.id, caller.tokenId))
    }
  } catch (e) {
    console.error('[mcp-auth] failed to record caller', e)
  }
}
