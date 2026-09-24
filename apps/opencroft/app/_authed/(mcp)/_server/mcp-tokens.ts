import { randomBytes } from 'node:crypto'

import { db, mcpToken } from '@opencroft/db'
import type { HostMcpTokenInfo, HostMcpTokensApi } from '@opencroft/server'
import { and, desc, eq } from 'drizzle-orm'

import { hashToken } from '@/app/_authed/(mcp)/_server/token-hash'
import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'

/**
 * Issuing and revoking the credentials the MCP endpoint accepts — one agent
 * node's tokens at a time. Resolution of a presented token is not here: that
 * is the endpoint's, in caller.ts, and it reads the same table.
 *
 * Nothing here checks who is asking. The only way in is the agent node's
 * settings, through the extension action surface, which requires a signed-in
 * person before anything is dispatched — and no MCP tool reaches these, so an
 * agent cannot issue itself a credential.
 */

// Distinct from a personal token's `oc_`, so the two kinds can be told apart
// wherever one turns up — a client's config, a leaked-secret scan, a support
// question — without anyone having to look it up.
const MCP_TOKEN_PREFIX = 'ocm_'

export async function listMcpTokens(agentNodeId: string): Promise<HostMcpTokenInfo[]> {
  const rows = await db
    .select({
      id: mcpToken.id,
      name: mcpToken.name,
      createdAt: mcpToken.createdAt,
      lastUsedAt: mcpToken.lastUsedAt,
      expiresAt: mcpToken.expiresAt,
    })
    .from(mcpToken)
    .where(eq(mcpToken.agentNodeId, agentNodeId))
    .orderBy(desc(mcpToken.createdAt))

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  }))
}

/** `null` is "never", chosen by whoever creates the token; anything else must be a date still ahead. */
function parseExpiry(expiresAt: string | null): Date | null {
  if (expiresAt === null) {
    return null
  }
  const date = new Date(expiresAt)
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid expiry date')
  }
  if (date.getTime() <= Date.now()) {
    throw new Error('Expiry must be in the future')
  }
  return date
}

/**
 * Issue a token for an agent node. The plaintext is in this return value and
 * nowhere else — only its hash is stored, and nothing lists it back.
 *
 * Refused for a node that is not an agent: a token naming nothing would resolve
 * to nobody at the endpoint anyway, and issuing one would leave a credential
 * that looks live in a list and can never work.
 */
export async function createMcpToken(
  agentNodeId: string,
  input: { name: string; expiresAt: string | null },
): Promise<{ id: string; token: string }> {
  const name = input.name.trim()
  if (!name) {
    throw new Error('Name is required')
  }
  const expiresAt = parseExpiry(input.expiresAt)
  if (!(await listAgentNodesImpl()).some((node) => node.nodeId === agentNodeId)) {
    throw new Error('Tokens can only be issued to an agent node')
  }

  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  const [row] = await db
    .insert(mcpToken)
    .values({ agentNodeId, name, expiresAt, tokenHash: hashToken(token) })
    .returning({ id: mcpToken.id })

  return { id: row.id, token }
}

/**
 * Delete one of a node's tokens. The row goes, so the next request presenting
 * it resolves to nothing — there is no cache in front of the lookup.
 *
 * Scoped by node as well as id in the WHERE clause, so a token id cannot be
 * deleted through another node's settings.
 */
export async function deleteMcpToken(agentNodeId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(mcpToken)
    .where(and(eq(mcpToken.id, id), eq(mcpToken.agentNodeId, agentNodeId)))
    .returning({ id: mcpToken.id })
  if (deleted.length === 0) {
    throw new Error('Token not found')
  }
}

export const mcpTokensApi: HostMcpTokensApi = {
  list: listMcpTokens,
  create: createMcpToken,
  delete: deleteMcpToken,
}
