import { createHash, timingSafeEqual } from 'node:crypto'

import { apiToken, db, mcpCaller } from '@opencroft/db'
import { and, eq, isNull, sql } from 'drizzle-orm'

import { mcpAuthMode } from '@/app/(mcp)/_server/mcp-auth-mode'
import { hashToken } from '@/app/(mcp)/_server/token-hash'

/**
 * Who is calling the HTTP MCP surface.
 *
 * In Stage A this resolves and records and refuses nothing — the point is to
 * measure the caller population before anything depends on the answer. See
 * mcp-auth-mode.ts for why that staging exists.
 */

export type CredentialState = 'present' | 'absent' | 'unknown'

export interface Caller {
  credential: CredentialState
  agent: string | null
  tokenId: string | null
}

export const ANONYMOUS: Caller = { credential: 'absent', agent: null, tokenId: null }

// Re-exported so the request path has one obvious import, while the minting
// script takes it from token-hash.ts directly — see the note there.
export { hashToken }

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
  // `off` means off: no lookup, no database work, nothing to go wrong. The
  // kill switch has to be able to take this code out of the request path
  // entirely, not just stop it refusing things.
  if (mcpAuthMode() === 'off') {
    return ANONYMOUS
  }

  const presented = bearerFrom(request)
  if (!presented) {
    return ANONYMOUS
  }

  try {
    return await lookup(presented)
  } catch (e) {
    // A database that will not answer must not turn into a 500 on a surface
    // this stage is only watching. Report the caller as unresolved and let the
    // request through — the same outcome it would have had before any of this
    // existed. Stage B has to make the opposite choice here, and that
    // difference is the reason these two stages are separate deploys.
    console.error('[mcp-auth] token lookup failed, treating caller as unresolved', e)
    return { credential: 'unknown', agent: null, tokenId: null }
  }
}

async function lookup(presented: string): Promise<Caller> {
  const presentedHash = hashToken(presented)

  // Look up by hash rather than scanning: the unique index does the work, and
  // the comparison below is belt-and-braces against a future change that makes
  // this a scan.
  const rows = await db
    .select({ id: apiToken.id, agent: apiToken.agent, tokenHash: apiToken.tokenHash })
    .from(apiToken)
    .where(and(eq(apiToken.tokenHash, presentedHash), isNull(apiToken.revokedAt)))
    .limit(1)

  const row = rows[0]
  if (!row) {
    // Presented something, and it does not resolve. Deliberately not the same
    // as presenting nothing — this is a client that WAS configured and is now
    // wrong (revoked, rotated, typo), which needs a person, not a rollout.
    return { credential: 'unknown', agent: null, tokenId: null }
  }

  // Both sides are fixed-length hex of the same digest, so the lengths match
  // and timingSafeEqual cannot throw here.
  const a = Buffer.from(row.tokenHash, 'utf8')
  const b = Buffer.from(presentedHash, 'utf8')
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { credential: 'unknown', agent: null, tokenId: null }
  }

  return { credential: 'present', agent: row.agent, tokenId: row.id }
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
 * clients apart, and Stage A is counting distinct callers rather than deciding
 * anything. It must NOT be used for access control, in Stage B or anywhere
 * else.
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
 * Record that this caller was seen, aggregating onto one row per distinct
 * (caller, method, tool) combination rather than one per request — NOT one row
 * per caller. A caller invoking two different tools produces two rows.
 *
 * READING THIS FOR THE STAGE B DECISION. The gate is not "no unexpected
 * callers were seen" — that is a claim an empty result satisfies for the wrong
 * reason. It is "the set of agents observed MATCHES THE SET WE DELIBERATELY
 * ISSUED TO", and because the grain here is per-tool, that means the DISTINCT
 * agents across all rows — `SELECT DISTINCT agent FROM "McpCaller"` — not a
 * count of rows. Stated that way an empty observation fails closed, because an
 * empty set does not match a non-empty issued set.
 *
 * The case that still slips through is a SHORT BUT COMPLETE window: if every
 * issued agent happens to call within the first minutes of observing, the sets
 * match and the gate passes on far less data than intended — while the rare
 * caller this exists to find has not had time to appear. So require a minimum
 * elapsed window as well as a matching set, measured from the earliest
 * firstSeenAt rather than from when you started waiting.
 *
 * Never throws: Stage A must not be able to fail a request it is only
 * watching. A recording error is worth a log line and nothing more.
 */
export async function recordCaller({ caller, method, tool, request }: ObservationInput): Promise<void> {
  if (mcpAuthMode() === 'off') {
    return
  }

  const sourceIp = sourceOf(request)
  const userAgent = request.headers.get('user-agent')
  const fingerprint = fingerprintOf([caller.credential, caller.agent, method, tool, sourceIp, userAgent])

  // A fixed prefix so the per-request trace is one command:
  //
  //     docker logs <container> 2>&1 | grep '^\[mcp-caller\]'
  //
  // The log is the raw material; McpCaller is the answer. This line is what you
  // read when you want the sequence of individual calls — the table cannot give
  // you that, because it deliberately collapses them. See the note on McpCaller
  // in the schema for why the aggregate is the thing Stage A actually needs.
  //
  // `docker logs` also survives a restart in place but not a container recreate,
  // and editing the node's `command` or `env` IS a recreate, so this stream
  // resets on such a deploy change. The table does not.
  console.log(
    `[mcp-caller] credential=${caller.credential} agent=${caller.agent ?? '-'} method=${method} ` +
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
      await db.update(apiToken).set({ lastUsedAt: now }).where(eq(apiToken.id, caller.tokenId))
    }
  } catch (e) {
    console.error('[mcp-auth] failed to record caller', e)
  }
}
