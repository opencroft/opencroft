// Group chats: the model and the access rule (phase 1). No UI —
// the design kit is the source of truth for
// what phase 2/3 render, so nothing here should assume a shape for that.
//
// THE ACCESS RULE IS THE POINT OF THIS FILE. Every function that reads or
// writes a group chat's content calls a `require*` check itself, the same
// discipline `requireAdminUser` established (packages/auth/src/server.ts): a
// `createServerFn` is a callable endpoint in its own right, reachable without
// ever going through a page, so a route guard is UX and this is the boundary.
// A function here that returns data without calling one of these first is a
// bug, not a style choice.

import { getSessionUser } from '@opencroft/auth/server'
import { db, groupChat, groupChatMember, groupChatThread, user } from '@opencroft/db'
import { and, eq } from 'drizzle-orm'

import { ensureLocalSessionImpl, forgetLocalSessionImpl, promptLocalImpl } from '@/app/_authed/(agent)/_server/acp-impl'
import { composeEnvelope } from '@/app/_authed/(agent)/_shared/message-envelope'
import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'

// THE ONE MESSAGE every "you cannot have this" refusal carries.
//
// A non-member and a nonexistent id must be indistinguishable to the caller,
// and that means indistinguishable ON THE WIRE — same code, same text — not
// merely mapped to the same words by the screen. Testing caught the
// earlier version failing exactly there: the copy matched, the response did
// not, and the console showed which ids were real.
//
// Deliberately says nothing about existence or membership. Anything more
// specific is the leak coming back; if a future refusal needs detail for an
// operator, it belongs in a server-side log, never in what is returned.
const UNAVAILABLE = 'Not available'

import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'

export type { GroupChatAccessFailure } from '@/app/_authed/(group-chats)/_shared/access-error'
// The refusal type lives in _shared/access-error.ts — dependency-free, so the
// client can name it without importing this module's database tail. Re-exported
// here so every existing server-side caller and `model.test.ts` are unchanged.
export { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'

export interface GroupChatSummary {
  id: string
  topic: string
  createdAt: Date
  updatedAt: Date
}

export interface GroupChatThreadSummary {
  id: string
  groupChatId: string
  agentNodeId: string
  sessionKey: string
  title: string | null
  createdAt: Date
}

/**
 * The signed-in user behind this request, or throws.
 *
 * Deliberately distinct from `requireAdminUser` returning `null` on failure:
 * every membership check below needs a firm user to test membership FOR, so
 * "no user" and "user but not a member" both end in the caller never getting
 * data back, and collapsing them into one throw here means every function
 * below has exactly one failure path to handle, not two.
 */
async function requireSignedInUser(request: Request) {
  const sessionUser = await getSessionUser(request)
  if (!sessionUser) {
    throw new GroupChatAccessError('unauthenticated', 'Sign in to use group chats')
  }
  return sessionUser
}

async function isUserMember(groupChatId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: groupChatMember.id })
    .from(groupChatMember)
    .where(and(eq(groupChatMember.groupChatId, groupChatId), eq(groupChatMember.userId, userId)))
    .limit(1)
  return !!row
}

async function isAgentMember(groupChatId: string, agentNodeId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: groupChatMember.id })
    .from(groupChatMember)
    .where(and(eq(groupChatMember.groupChatId, groupChatId), eq(groupChatMember.agentNodeId, agentNodeId)))
    .limit(1)
  return !!row
}

/**
 * THE CHECK. Every function below that touches a specific group chat's
 * content calls this first and uses nothing it has not returned.
 *
 * Refuses a nonexistent group chat and a caller who is not a member with the
 * SAME code and the SAME message — see UNAVAILABLE above. Telling a
 * non-member "that id doesn't exist" versus "that exists but you cannot see
 * it" leaks which ids are real to someone not entitled to know, and doing it
 * only on screen while the wire still distinguishes them is the bug found
 * on phase 2.
 */
async function requireGroupChatMember(request: Request, groupChatId: string): Promise<{ userId: string }> {
  const sessionUser = await requireSignedInUser(request)
  const [chat] = await db.select({ id: groupChat.id }).from(groupChat).where(eq(groupChat.id, groupChatId)).limit(1)
  if (!chat) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  if (!(await isUserMember(groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  return { userId: sessionUser.id }
}

// ── Reading ─────────────────────────────────────────────────────────────

/** The group chats the signed-in user is a member of — never any others. */
export async function listGroupChatsForUser(request: Request): Promise<GroupChatSummary[]> {
  const sessionUser = await requireSignedInUser(request)
  return db
    .select({
      id: groupChat.id,
      topic: groupChat.topic,
      createdAt: groupChat.createdAt,
      updatedAt: groupChat.updatedAt,
    })
    .from(groupChat)
    .innerJoin(groupChatMember, eq(groupChatMember.groupChatId, groupChat.id))
    .where(eq(groupChatMember.userId, sessionUser.id))
}

/**
 * The group chats a given agent is a member of, resolved by NAME rather than
 * a checked identity.
 *
 * THIS IS A LOOKUP, NOT AN AUTHORIZATION CHECK — an explicit product
 * decision, not an oversight (the reason: an
 * agent's tool call carries no server-verifiable identity today, and
 * threading one through `agent-client` was decided against). The server
 * takes the caller's stated name at face value and returns whichever agent
 * node that name resolves to's memberships. Nothing user-facing may rely on
 * this to keep anything private — any caller that can say a name gets that
 * agent's group chat list, whether or not it truly is that agent.
 *
 * Agent names are taken to be unique — also a deliberate decision,
 * not an assumption made here. This resolves the first match and does not
 * detect or refuse a collision; a name matching nothing is an ordinary
 * `not-found`, the same code every other lookup in this file uses.
 */
export async function listGroupChatsForAgent(agentName: string): Promise<GroupChatSummary[]> {
  const trimmed = agentName.trim()
  const nodes = await listAgentNodesImpl()
  const match = nodes.find((n) => n.name === trimmed)
  if (!match) {
    throw new GroupChatAccessError('not-found', `No agent named "${trimmed}" was found`)
  }
  return db
    .select({
      id: groupChat.id,
      topic: groupChat.topic,
      createdAt: groupChat.createdAt,
      updatedAt: groupChat.updatedAt,
    })
    .from(groupChat)
    .innerJoin(groupChatMember, eq(groupChatMember.groupChatId, groupChat.id))
    .where(eq(groupChatMember.agentNodeId, match.nodeId))
}

/** One group chat's own fields. Refuses exactly as `requireGroupChatMember`. */
export async function getGroupChat(request: Request, groupChatId: string): Promise<GroupChatSummary> {
  await requireGroupChatMember(request, groupChatId)
  const [row] = await db
    .select({
      id: groupChat.id,
      topic: groupChat.topic,
      createdAt: groupChat.createdAt,
      updatedAt: groupChat.updatedAt,
    })
    .from(groupChat)
    .where(eq(groupChat.id, groupChatId))
    .limit(1)
  // requireGroupChatMember already proved this row exists; a miss here would
  // mean it was deleted in the gap between the two queries.
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  return row
}

/** Every thread in a group chat. Membership-gated, not filtered after the fact. */
export async function listThreadsInGroupChat(request: Request, groupChatId: string): Promise<GroupChatThreadSummary[]> {
  await requireGroupChatMember(request, groupChatId)
  return db
    .select({
      id: groupChatThread.id,
      groupChatId: groupChatThread.groupChatId,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
      title: groupChatThread.title,
      createdAt: groupChatThread.createdAt,
    })
    .from(groupChatThread)
    .where(eq(groupChatThread.groupChatId, groupChatId))
}

/**
 * THE PROOF FUNCTION. One thread's own row, by id — the thing the design's
 * own verification section asks to be provably refused for a non-member,
 * called directly rather than through a list.
 *
 * KNOWN LIMITATION, named rather than left implicit: this gates the durable
 * binding (which group chat, which agent, which session key), not the ACP
 * session's own history. Once a member legitimately learns a thread's
 * sessionKey, the agent-client session API behind it has no per-conversation
 * ownership check of its own — the same property today's 1:1 agent chats
 * already have (a session id is bearer-equivalent there too). Closing that
 * is a pre-existing, system-wide gap this phase does not create and is not
 * scoped to fix.
 */
export async function getThread(request: Request, threadId: string): Promise<GroupChatThreadSummary> {
  const sessionUser = await requireSignedInUser(request)
  const [row] = await db
    .select({
      id: groupChatThread.id,
      groupChatId: groupChatThread.groupChatId,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
      title: groupChatThread.title,
      createdAt: groupChatThread.createdAt,
    })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  // Same single refusal as requireGroupChatMember, for the same reason — and
  // reached directly here rather than by delegating, because the group chat
  // to check membership against is this row's own, so the row has to be found
  // first. "Found it but you are not a member" and "no such thread" are the
  // same answer to this caller.
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  return row
}

// ── Writing ─────────────────────────────────────────────────────────────

/** A new group chat, with its creator as the first (user) member. */
export async function createGroupChat(request: Request, topic: string): Promise<GroupChatSummary> {
  const sessionUser = await requireSignedInUser(request)
  const trimmed = topic.trim()
  if (!trimmed) {
    throw new Error('A group chat needs a topic')
  }
  return db.transaction(async (tx) => {
    const [chat] = await tx.insert(groupChat).values({ topic: trimmed, createdByUserId: sessionUser.id }).returning()
    if (!chat) {
      throw new Error('The group chat could not be created')
    }
    await tx.insert(groupChatMember).values({
      groupChatId: chat.id,
      principalType: 'user',
      userId: sessionUser.id,
    })
    return chat
  })
}

export type MemberPrincipal = { kind: 'user'; userId: string } | { kind: 'agent'; agentNodeId: string }

/**
 * Add a member. Any existing member may add another — phase 1's answer to
 * "who may manage membership", not otherwise specified and not
 * worth a role system nobody asked for; a narrower rule is a later, additive
 * change if one is ever needed.
 *
 * An agent principal is validated against `listAgentNodesImpl()` — the plain
 * implementation in agents-impl.ts, the same source `ai-panel.tsx` populates
 * its agent picker from — so a group chat cannot be given a member that is
 * not, in fact, an agent node that exists. Imported from agents-impl.ts
 * rather than agents.ts for two separate reasons: it avoids nesting one
 * `createServerFn` inside another's handler, and agents.ts must keep no
 * plain exports at all or its native-dependent import tail reaches the
 * client bundle (see that file's header). A user principal is validated
 * against the `user` table for the same reason: existence, not just shape.
 */
export async function addMember(request: Request, groupChatId: string, principal: MemberPrincipal): Promise<void> {
  await requireGroupChatMember(request, groupChatId)

  if (principal.kind === 'agent') {
    const nodes = await listAgentNodesImpl()
    if (!nodes.some((n) => n.nodeId === principal.agentNodeId)) {
      throw new Error('No such agent node')
    }
    await db
      .insert(groupChatMember)
      .values({ groupChatId, principalType: 'agent', agentNodeId: principal.agentNodeId })
      .onConflictDoNothing()
    return
  }

  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.id, principal.userId)).limit(1)
  if (!row) {
    throw new Error('No such user')
  }
  await db
    .insert(groupChatMember)
    .values({ groupChatId, principalType: 'user', userId: principal.userId })
    .onConflictDoNothing()
}

/** Members of a group chat, agents and users together. Membership-gated. */
export async function listMembers(
  request: Request,
  groupChatId: string,
): Promise<Array<{ id: string; principalType: string; userId: string | null; agentNodeId: string | null }>> {
  await requireGroupChatMember(request, groupChatId)
  return db
    .select({
      id: groupChatMember.id,
      principalType: groupChatMember.principalType,
      userId: groupChatMember.userId,
      agentNodeId: groupChatMember.agentNodeId,
    })
    .from(groupChatMember)
    .where(eq(groupChatMember.groupChatId, groupChatId))
}

// A thread's session key is namespaced away from the 1:1 chat registry's
// `agent:<agent>:<job>[:<key>]` shape on purpose — the two must never collide
// even by coincidence, and a reader who sees this prefix knows immediately
// which registry a session belongs to without having to cross-reference
// either table.
function mintSessionKey(groupChatId: string, agentNodeId: string): string {
  return `group-chat:${groupChatId}:${agentNodeId}:${crypto.randomUUID()}`
}

export interface StartThreadResult {
  thread: GroupChatThreadSummary
  sessionId: string
}

/**
 * Start a thread and send its first message in one call — this system has no
 * notion of an empty, unaddressed thread (the existing 1:1 chat does not
 * either: opening a session and sending into it are two steps, but nothing
 * ever leaves a session open with nothing said). Both the calling user and
 * the named agent must be members; either failing refuses the whole call
 * rather than creating a thread that then cannot be used.
 *
 * The topic enters the agent's context exactly the way a job's context does
 * today (see message-envelope.ts) — `composeEnvelope` with `isNewSession:
 * true`, which a brand-new sessionKey guarantees here, so the topic is
 * attached to this first message and never repeated on later ones.
 */
export async function startThread(
  request: Request,
  groupChatId: string,
  agentNodeId: string,
  firstMessage: string,
): Promise<StartThreadResult> {
  const { userId } = await requireGroupChatMember(request, groupChatId)
  if (!(await isAgentMember(groupChatId, agentNodeId))) {
    throw new GroupChatAccessError('agent-not-a-member', 'That agent is not a member of this group chat')
  }
  const [chat] = await db
    .select({ topic: groupChat.topic })
    .from(groupChat)
    .where(eq(groupChat.id, groupChatId))
    .limit(1)
  if (!chat) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }

  const sessionKey = mintSessionKey(groupChatId, agentNodeId)
  const [thread] = await db
    .insert(groupChatThread)
    .values({ groupChatId, agentNodeId, sessionKey, createdByUserId: userId })
    .returning({
      id: groupChatThread.id,
      groupChatId: groupChatThread.groupChatId,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
      title: groupChatThread.title,
      createdAt: groupChatThread.createdAt,
    })
  if (!thread) {
    throw new Error('The thread could not be created')
  }

  const opened = await ensureLocalSessionImpl({ agentNodeId, jobNodeId: '', tabKey: sessionKey })
  const envelope = composeEnvelope(firstMessage, {
    sessionInit: { jobContext: `Group chat topic: ${chat.topic}` },
    isNewSession: opened.created,
  })
  await promptLocalImpl({ sessionId: opened.sessionId, text: envelope })

  return { thread, sessionId: opened.sessionId }
}

/**
 * Send a later message into an existing thread. Membership-gated on the
 * thread's own group chat, same as `getThread` — no context re-attached,
 * since `isNewSession` only ever applies to the first prompt of a session.
 */
export async function sendMessageInThread(
  request: Request,
  threadId: string,
  text: string,
  opts?: { front?: boolean },
): Promise<void> {
  const sessionUser = await requireSignedInUser(request)
  const [row] = await db
    .select({
      groupChatId: groupChatThread.groupChatId,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
    })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  const opened = await ensureLocalSessionImpl({
    agentNodeId: row.agentNodeId,
    jobNodeId: '',
    tabKey: row.sessionKey,
  })
  // `front` is forwarded rather than dropped. It is set by the permission
  // "tell it what to do differently" flow, which cancels the run and needs its
  // guidance queued ahead of anything already held. A group-chat thread is an
  // ordinary agent session and reaches that flow too, so a send path that
  // silently ignored it would behave differently from a 1:1 chat in exactly
  // the situation the user is trying to correct the agent.
  await promptLocalImpl({ sessionId: opened.sessionId, text, front: opts?.front })
}

/**
 * Delete a thread: the session + process underneath it, then its durable row.
 *
 * Membership-gated like getThread -- found first, then the same single refusal
 * for a missing thread and a non-member, so the two stay indistinguishable. The
 * session teardown reuses forgetLocalSessionImpl, the same path the sidebar's
 * chat delete takes, because a thread is an ordinary agent session keyed on its
 * sessionKey. Nothing here is special to group chats beyond dropping the row.
 */
export async function deleteThread(request: Request, threadId: string): Promise<void> {
  const sessionUser = await requireSignedInUser(request)
  const [row] = await db
    .select({
      groupChatId: groupChatThread.groupChatId,
      sessionKey: groupChatThread.sessionKey,
    })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  // Tear down the session + its process via the shared path the sidebar uses,
  // and do it BEFORE dropping the row. The row is the only handle anything has
  // on this sessionKey, so deleting it first turns a failed teardown into a
  // live session and agent subprocess that no screen lists and no retry can
  // reach. This way round, a failed teardown leaves the thread intact and the
  // delete retryable, and a failed row delete leaves only a torn-down thread
  // that reopens onto a fresh session via `ensureLocalSessionImpl`.
  await forgetLocalSessionImpl(row.sessionKey)
  await db.delete(groupChatThread).where(eq(groupChatThread.id, threadId))
}
