import { db, user } from '@opencroft/db'
import { inArray } from 'drizzle-orm'

import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'
import { resolveUsernames } from '@/app/_server/usernames'

/**
 * What a stamped handle looks like to a reader, now.
 *
 * The other direction from `message-author.ts`: that decides what identifier
 * goes into a message, this decides what a reader is shown for one. The two
 * are deliberately separate acts. A message is stamped ONCE, with something
 * durable; it is resolved EVERY TIME it is drawn, so a rename or a new picture
 * reaches every message that account ever sent, including the ones already in
 * a transcript. Storing the name alongside the handle would freeze the face at
 * the moment of sending and quietly make old messages wrong.
 *
 * SERVER-ONLY, and never a `createServerFn`. It reads the database and the
 * space graph; the surfaces that need it attach the result to what they are
 * already sending, so no client ever asks "who is this?" and no rendering
 * depends on what a browser happened to have cached.
 *
 * An identifier no account holds is ABSENT from the result rather than given a
 * placeholder. That is a state the header already draws — the author as
 * written, with no avatar — and it is what every message stamped before
 * accounts had handles falls into. A placeholder would turn "we do not know
 * who this is" into a picture of somebody.
 */

/** One account as a message header draws it. */
export interface ResolvedAuthor {
  name: string
  avatarUrl: string | null
}

/**
 * Resolve stamped handles to the accounts holding them, in one pass.
 *
 * Both kinds of account, because a reader does not care which one a message
 * came from and the header renders them identically. People come from the
 * database; agents live in space-graph JSON and come from the node registry,
 * which is why they cannot be a join.
 *
 * The agent registry walk happens at most once per call and only when an
 * agent handle is actually present — it reads every space's graph, so doing it
 * for a turn of purely human messages would be a whole-registry read for
 * nothing.
 */
export async function authorsByIdentifier(identifiers: string[]): Promise<Record<string, ResolvedAuthor>> {
  const principals = await resolveUsernames(identifiers)
  if (principals.size === 0) {
    return {}
  }

  const userIds: string[] = []
  let wantsAgents = false
  for (const principal of principals.values()) {
    if (principal.kind === 'agent') {
      wantsAgents = true
    } else {
      userIds.push(principal.id)
    }
  }

  const [people, agents] = await Promise.all([peopleById(userIds), wantsAgents ? agentsByNodeId() : new Map()])

  const authors: Record<string, ResolvedAuthor> = {}
  for (const [identifier, principal] of principals) {
    const account = principal.kind === 'agent' ? agents.get(principal.id) : people.get(principal.id)
    if (account) {
      authors[identifier] = account
    }
    // No else. A handle whose account has since been deleted resolves to
    // nobody, and saying so is the honest rendering -- the message keeps the
    // text it holds and loses only the face.
  }
  return authors
}

async function peopleById(userIds: string[]): Promise<Map<string, ResolvedAuthor>> {
  if (userIds.length === 0) {
    return new Map()
  }
  const rows = await db
    .select({ id: user.id, name: user.name, image: user.image })
    .from(user)
    .where(inArray(user.id, userIds))
  return new Map(rows.map((row) => [row.id, { name: row.name, avatarUrl: row.image ?? null }] as const))
}

async function agentsByNodeId(): Promise<Map<string, ResolvedAuthor>> {
  const nodes = await listAgentNodesImpl()
  return new Map(nodes.map((node) => [node.nodeId, { name: node.name, avatarUrl: node.avatar ?? null }] as const))
}
