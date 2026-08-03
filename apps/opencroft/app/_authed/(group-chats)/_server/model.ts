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

import { ensureLocalSessionImpl, promptLocalImpl } from '@/app/_authed/(agent)/_server/acp-impl'
import { composeEnvelope } from '@/app/_authed/(agent)/_shared/message-envelope'
import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'

export type GroupChatAccessFailure =
  /** Not signed in, or signed in as nobody this system recognises. */
  | 'unauthenticated'
  /** Signed in, but not a member of the group chat this request names. */
  | 'not-a-member'
  /** The request names a group chat, thread or agent that does not exist —
   *  refused the same way as `not-a-member` (see the note on `getThread`). */
  | 'not-found'
  /** The request names an agent that is not a member of the group chat. */
  | 'agent-not-a-member'

/**
 * PHASE 2 CONTRACT, verified against the actual wire format rather than
 * assumed: `createServerFn` sends a thrown error through seroval's
 * `toCrossJSONAsync` / `fromCrossJSON`, which reconstructs it as a plain
 * `Error` — a custom subclass is not in seroval's fixed constructor list, so
 * **`instanceof GroupChatAccessError` is false on the client even for one of
 * these.** `name` and every other own-enumerable property (so `code`) DO
 * survive, copied onto that plain `Error`. Confirmed by round-tripping an
 * instance through `toCrossJSONAsync`/`fromCrossJSON` directly.
 *
 * So: client code must branch on `error.name === 'GroupChatAccessError'` and
 * then read `.code` — never on `instanceof`. `model.test.ts`'s `instanceof`
 * checks are still correct as written; they call this module directly, never
 * crossing the RPC boundary this note describes.
 */
export class GroupChatAccessError extends Error {
  constructor(
    readonly code: GroupChatAccessFailure,
    message: string,
  ) {
    super(message)
    this.name = 'GroupChatAccessError'
  }
}

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
 * Refuses with `not-found` rather than `not-a-member` when the group chat
 * does not exist at all — indistinguishable from the outside (a non-member
 * gets the same refusal either way), and deliberately so: telling a
 * non-member "that id doesn't exist" vs "that id exists but you can't see
 * it" leaks which ids are real to someone who is not entitled to know.
 */
async function requireGroupChatMember(request: Request, groupChatId: string): Promise<{ userId: string }> {
  const sessionUser = await requireSignedInUser(request)
  const [chat] = await db.select({ id: groupChat.id }).from(groupChat).where(eq(groupChat.id, groupChatId)).limit(1)
  if (!chat) {
    throw new GroupChatAccessError('not-found', 'No such group chat')
  }
  if (!(await isUserMember(groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-a-member', 'You are not a member of this group chat')
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
    throw new GroupChatAccessError('not-found', 'No such group chat')
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
  // Same not-found/not-a-member indistinguishability as requireGroupChatMember,
  // and for the same reason — reached directly here (rather than delegating)
  // because the group chat id to check membership against is the row's own,
  // not the caller's, so there is a row to find first.
  if (!row) {
    throw new GroupChatAccessError('not-found', 'No such thread')
  }
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-a-member', 'You are not a member of this group chat')
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
    throw new GroupChatAccessError('not-found', 'No such group chat')
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
export async function sendMessageInThread(request: Request, threadId: string, text: string): Promise<void> {
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
    throw new GroupChatAccessError('not-found', 'No such thread')
  }
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-a-member', 'You are not a member of this group chat')
  }
  const opened = await ensureLocalSessionImpl({
    agentNodeId: row.agentNodeId,
    jobNodeId: '',
    tabKey: row.sessionKey,
  })
  await promptLocalImpl({ sessionId: opened.sessionId, text })
}
