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
import { db, groupChat, groupChatMember, groupChatPin, groupChatThread, user } from '@opencroft/db'
import { and, asc, eq, inArray } from 'drizzle-orm'

import {
  ensureLocalSessionImpl,
  forgetLocalSessionImpl,
  hasActiveTurnImpl,
  promptLocalImpl,
  stopLocalSessionProcessImpl,
} from '@/app/_authed/(agent)/_server/acp-impl'
import { composeEnvelope } from '@/app/_authed/(agent)/_shared/message-envelope'
import type { CompactAck, CompactStatus, ThreadDeliveryOutcome } from '@/app/_authed/(extension-runtime)/_server/stream'
import {
  getCompactStatusOnGraph,
  requestCompactOnGraph,
  resolveOrCreateSession,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'
import { slug as slugify } from '@/app/_authed/(server)/_server/types'

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
  /** The readable, immutable half of this chat's session keys. */
  slug: string
  /** What people read. Presentation only — no agent is ever told it. */
  name: string
  /**
   * What agents read: composed into a thread's session-init context when the
   * thread is created. Editing it therefore reaches the next thread and no
   * session already open.
   */
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
  /** Unsent composer text for this thread, or null when there is none. */
  draft: string | null
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
      slug: groupChat.slug,
      name: groupChat.name,
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
      slug: groupChat.slug,
      name: groupChat.name,
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
      slug: groupChat.slug,
      name: groupChat.name,
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
      draft: groupChatThread.draft,
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
      draft: groupChatThread.draft,
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

/**
 * A new group chat, with its creator as the first (user) member.
 *
 * ONE FIELD AT CREATION, TWO AFTERWARDS. The caller gives a name; the topic
 * defaults to it unless one is supplied. Asking for both up front would demand
 * a statement of purpose at the moment the person knows least about the chat
 * they are opening, and the honest default for "what is this chat about" is
 * what they just called it. Editing either one afterwards is what splits them.
 */
export async function createGroupChat(request: Request, name: string, topic?: string): Promise<GroupChatSummary> {
  const sessionUser = await requireSignedInUser(request)
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new Error('A group chat needs a name')
  }
  const trimmedTopic = topic?.trim() || trimmedName
  // The slug comes from the name and is fixed from here: it goes into every
  // session key this chat's threads are opened under, and a key that moves is
  // a key that stops finding its session.
  const chatSlug = slugify(trimmedName)
  if (!chatSlug) {
    throw new GroupChatAccessError('slug-unusable', 'That name has no letters or numbers to build a name from')
  }
  const [taken] = await db.select({ id: groupChat.id }).from(groupChat).where(eq(groupChat.slug, chatSlug)).limit(1)
  if (taken) {
    // Checked before the insert so the refusal carries a code the form can
    // show. The unique index is still the thing that decides — two creates in
    // the same instant both pass this and one loses at the constraint, which
    // surfaces as a fault rather than this refusal. Rare, and honest: a fault
    // is what an unexpected loss is.
    throw new GroupChatAccessError('slug-taken', `A group chat named "${trimmedName}" already exists`)
  }
  return db.transaction(async (tx) => {
    const [chat] = await tx
      .insert(groupChat)
      .values({ slug: chatSlug, name: trimmedName, topic: trimmedTopic, createdByUserId: sessionUser.id })
      .returning()
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

/**
 * Rename a group chat. Membership-gated like every other write here.
 *
 * Presentation only, and that is the whole contract: no session is touched, no
 * agent is told, nothing is re-delivered. Every screen reads the new name on
 * its next load because every read goes through the same row.
 */
export async function renameGroupChat(request: Request, groupChatId: string, name: string): Promise<void> {
  await requireGroupChatMember(request, groupChatId)
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('A group chat needs a name')
  }
  await db.update(groupChat).set({ name: trimmed }).where(eq(groupChat.id, groupChatId))
}

/**
 * Change what agents are told this chat is for.
 *
 * REACHES NEW THREADS ONLY, and not by omission — `startThread` reads the
 * topic at the moment it opens a session, so a thread started after this call
 * carries the new text and one started before carries what it was opened with.
 * Re-delivering into a running session would mean interrupting a turn to
 * restate context nobody asked for; the pinned-notes mechanism is the place
 * that problem is solved deliberately, with per-thread delivery tracking.
 *
 * Worth saying plainly because it is the surprising half: editing the topic
 * does NOT correct an agent that is already working from the old one.
 */
export async function setGroupChatTopic(request: Request, groupChatId: string, topic: string): Promise<void> {
  await requireGroupChatMember(request, groupChatId)
  const trimmed = topic.trim()
  if (!trimmed) {
    throw new Error('A group chat needs a topic')
  }
  await db.update(groupChat).set({ topic: trimmed }).where(eq(groupChat.id, groupChatId))
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

/**
 * Remove a member. Mirrors `addMember`'s rule deliberately: any existing
 * member may remove another, because a group chat where anyone may add but
 * only some may remove needs a role system, and there is none. Removing
 * yourself is how you leave.
 *
 * ONE RULE IS NOT SYMMETRIC — the last remaining user member cannot be
 * removed. Visibility is derived from user membership (`listGroupChatsForUser`),
 * so a chat whose last person left would not be gone, it would be unreachable:
 * present in the database, absent from every list, with no member left who
 * could add anyone back. Agents carry no such risk and may all be removed.
 *
 * Threads are NOT deleted. A removed agent's conversations stay readable; what
 * they lose is the ability to be sent to, which `sendMessageInThread` enforces
 * rather than this function.
 */
export async function removeMember(request: Request, groupChatId: string, principal: MemberPrincipal): Promise<void> {
  await requireGroupChatMember(request, groupChatId)

  if (principal.kind === 'user') {
    const userMembers = await db
      .select({ id: groupChatMember.id })
      .from(groupChatMember)
      .where(and(eq(groupChatMember.groupChatId, groupChatId), eq(groupChatMember.principalType, 'user')))
    if (userMembers.length <= 1) {
      throw new GroupChatAccessError(
        'last-user-member',
        'The last person in a group chat cannot be removed — the chat would become unreachable',
      )
    }
    await db
      .delete(groupChatMember)
      .where(
        and(
          eq(groupChatMember.groupChatId, groupChatId),
          eq(groupChatMember.principalType, 'user'),
          eq(groupChatMember.userId, principal.userId),
        ),
      )
    return
  }

  // Stop the agent's live sessions BEFORE dropping the membership row, for the
  // same reason `deleteThread` tears down before deleting: while the row is
  // still there the removal is retryable, and a teardown that throws leaves a
  // member who is visibly still a member. Dropping the row first would leave a
  // running agent process behind a member nobody can see to remove again.
  //
  // The product decision is that removal may interrupt a turn in progress
  // rather than wait for it.
  //
  // `stopLocalSessionProcessImpl`, NOT `forgetLocalSessionImpl`. The threads
  // are kept so their conversations stay readable, and forgetting would delete
  // the durable tabKey->sessionId pointer they are read back through — the
  // thread would reopen on a brand-new empty session and the history it was
  // kept for would be gone. Stopping ends the process and leaves the pointer,
  // so opening the thread later resumes the same session read-only, which is
  // exactly the state "kept but not sendable" describes.
  const threads = await db
    .select({ sessionKey: groupChatThread.sessionKey })
    .from(groupChatThread)
    .where(and(eq(groupChatThread.groupChatId, groupChatId), eq(groupChatThread.agentNodeId, principal.agentNodeId)))
  for (const thread of threads) {
    await stopLocalSessionProcessImpl(thread.sessionKey)
  }
  await db
    .delete(groupChatMember)
    .where(
      and(
        eq(groupChatMember.groupChatId, groupChatId),
        eq(groupChatMember.principalType, 'agent'),
        eq(groupChatMember.agentNodeId, principal.agentNodeId),
      ),
    )
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

// ── Pinned notes ────────────────────────────────────────────────────────

/**
 * How many pins one chat may hold.
 *
 * The reason is delivery, not storage: every pin is injected into what an
 * agent is told, so an unbounded list is an unbounded prompt. Ten is small
 * enough that the whole set stays readable in one block and large enough that
 * nobody hits it while using the feature as intended.
 */
export const MAX_PINS_PER_GROUP_CHAT = 10

export interface GroupChatPinSummary {
  id: string
  groupChatId: string
  text: string
  position: number
  createdAt: Date
  updatedAt: Date
}

const pinColumns = {
  id: groupChatPin.id,
  groupChatId: groupChatPin.groupChatId,
  text: groupChatPin.text,
  position: groupChatPin.position,
  createdAt: groupChatPin.createdAt,
  updatedAt: groupChatPin.updatedAt,
}

/** A chat's pins in their pinned order. Membership-gated. */
export async function listPins(request: Request, groupChatId: string): Promise<GroupChatPinSummary[]> {
  await requireGroupChatMember(request, groupChatId)
  return db
    .select(pinColumns)
    .from(groupChatPin)
    .where(eq(groupChatPin.groupChatId, groupChatId))
    .orderBy(asc(groupChatPin.position))
}

/**
 * Pin a note. Any member may, mirroring membership and every other write here.
 *
 * The cap is a REFUSAL, not a fault: the person hit a limit that exists for a
 * reason and can act on it by unpinning something, so it crosses the wire with
 * a code the screen can turn into that sentence.
 */
export async function addPin(request: Request, groupChatId: string, text: string): Promise<GroupChatPinSummary> {
  const { userId } = await requireGroupChatMember(request, groupChatId)
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('A pin needs some text')
  }
  const existing = await db
    .select({ position: groupChatPin.position })
    .from(groupChatPin)
    .where(eq(groupChatPin.groupChatId, groupChatId))
  if (existing.length >= MAX_PINS_PER_GROUP_CHAT) {
    throw new GroupChatAccessError(
      'pin-limit',
      `A group chat can hold ${MAX_PINS_PER_GROUP_CHAT} pins. Unpin one to add another`,
    )
  }
  // max + 1 rather than count + 1: a removed pin leaves a gap, and reusing a
  // number that a surviving pin already holds would make the order ambiguous.
  const next = existing.reduce((highest, row) => Math.max(highest, row.position), -1) + 1
  const [pin] = await db
    .insert(groupChatPin)
    .values({ groupChatId, text: trimmed, position: next, createdByUserId: userId })
    .returning(pinColumns)
  if (!pin) {
    throw new Error('The pin could not be created')
  }
  return pin
}

/**
 * A pin's own row plus the gate for the chat it belongs to.
 *
 * Found first, then membership-checked, then the SAME single refusal for both
 * misses — identical to `getThread`, and for the same reason: a pin id must not
 * be a way to learn which pins exist.
 */
async function requirePin(request: Request, pinId: string): Promise<{ groupChatId: string }> {
  const sessionUser = await requireSignedInUser(request)
  const [row] = await db
    .select({ groupChatId: groupChatPin.groupChatId })
    .from(groupChatPin)
    .where(eq(groupChatPin.id, pinId))
    .limit(1)
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  return row
}

/** Edit a pin's text. Any member may edit any pin — who wrote it decides nothing. */
export async function editPin(request: Request, pinId: string, text: string): Promise<void> {
  await requirePin(request, pinId)
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('A pin needs some text')
  }
  await db.update(groupChatPin).set({ text: trimmed }).where(eq(groupChatPin.id, pinId))
}

/** Unpin a note. The gap it leaves in `position` is intentional — see `addPin`. */
export async function removePin(request: Request, pinId: string): Promise<void> {
  await requirePin(request, pinId)
  await db.delete(groupChatPin).where(eq(groupChatPin.id, pinId))
}

/**
 * The pin texts an agent should currently be told, in order. UNGATED, and
 * private: every caller is a delivery path that has already proved the caller
 * may reach the thread it is delivering into.
 */
async function pinTextsFor(groupChatId: string): Promise<string[]> {
  const rows = await db
    .select({ text: groupChatPin.text })
    .from(groupChatPin)
    .where(eq(groupChatPin.groupChatId, groupChatId))
    .orderBy(asc(groupChatPin.position))
  return rows.map((r) => r.text)
}

/**
 * STANDING CONTEXT: everything a thread's agent should be holding about the
 * group chat it is in — the topic it exists for, and the notes pinned to it.
 *
 * One assembler, three delivery points, and that is the point of it being one
 * function rather than three call sites that each remember to include pins:
 *
 *   1. session-init, when a thread opens;
 *   2. the restore after a compaction, which drops the messages that carried
 *      it — so re-delivering CURRENT context is what makes pins survive
 *      compaction by construction rather than by anyone remembering;
 *   3. the next send after it changes, once.
 *
 * Assembled from current state every time it is asked for. Nothing caches it,
 * because a cached standing context is exactly the bug this replaced: a thing
 * delivered once and silently stale ever after.
 */
export interface StandingContext {
  /** The task context line, in the envelope's `jobContext` slot. */
  jobContext: string
  /** Marked guidance blocks, in the envelope's `instructions` slot. */
  instructions: string[]
  /**
   * A fingerprint of the two above, so a thread can record what it was told
   * and a later change can be recognised as one.
   */
  signature: string
}

/**
 * ORDER- AND CONTENT-SENSITIVE, both deliberately: reordering pins changes
 * what the block reads like, and an edit changes it outright, so both count as
 * a change worth re-delivering. Length-prefixed so two different lists cannot
 * collide by concatenating to the same string ('ab' + 'c' versus 'a' + 'bc').
 *
 * The empty pin set still produces a signature rather than an empty string, so
 * "nothing pinned" is a state that can be recorded as delivered and told apart
 * from the NULL that means nothing has ever been delivered.
 */
export function standingSignature(topic: string, pinTexts: string[]): string {
  const parts = [topic, ...pinTexts]
  return `v1:${parts.length}:${parts.map((t) => `${t.length}:${t}`).join('|')}`
}

/**
 * The block a thread's agent reads pins as: one clearly-marked reminder, not a
 * message from a person. Empty when there is nothing pinned, so a caller can
 * drop it without deciding what emptiness means.
 */
export function composePinReminder(texts: string[]): string {
  if (texts.length === 0) {
    return ''
  }
  const lines = texts.map((t) => `- ${t}`).join('\n')
  return `Pinned notes for this group chat — standing guidance, not a new request:\n${lines}`
}

/** Assemble one group chat's standing context from its current row and pins. */
async function standingContextForChat(groupChatId: string): Promise<StandingContext | null> {
  const [chat] = await db
    .select({ topic: groupChat.topic })
    .from(groupChat)
    .where(eq(groupChat.id, groupChatId))
    .limit(1)
  if (!chat) {
    return null
  }
  const pins = await pinTextsFor(groupChatId)
  const reminder = composePinReminder(pins)
  return {
    jobContext: `Group chat topic: ${chat.topic}`,
    // Pins ride the envelope's existing instruction axis rather than a new
    // one: that axis already means standing guidance rather than a request,
    // which is what a pin is.
    instructions: reminder ? [reminder] : [],
    signature: standingSignature(chat.topic, pins),
  }
}

/**
 * The standing context for a session key, or null when the key is not a group
 * chat thread's.
 *
 * UNGATED, and that is correct rather than an oversight: the callers are
 * delivery paths acting on behalf of the session itself, not on behalf of a
 * request. Nothing here is returned to a browser. The membership rule governs
 * who may read and change a chat, which is enforced on every function that
 * does either.
 *
 * This is the shape the session layer asks for by session key.
 */
export async function groupChatStandingContext(sessionKey: string): Promise<StandingContext | null> {
  const [row] = await db
    .select({ groupChatId: groupChatThread.groupChatId })
    .from(groupChatThread)
    .where(eq(groupChatThread.sessionKey, sessionKey))
    .limit(1)
  return row ? standingContextForChat(row.groupChatId) : null
}

// A thread's session key is namespaced away from the 1:1 chat registry's
// `agent:<agent>:<job>[:<key>]` shape on purpose — the two must never collide
// even by coincidence, and a reader who sees this prefix knows immediately
// which registry a session belongs to without having to cross-reference
// either table.
function mintSessionKey(groupSlug: string, agentSlug: string, threadSlug: string): string {
  return `group-chat:${groupSlug}:${agentSlug}:${threadSlug}`
}

/**
 * A thread slug when the creator did not name the thread.
 *
 * A SHORT HASH RATHER THAN A NUMBER, because most threads are ad-hoc and a
 * number would imply an order that means nothing. Short enough to read back
 * over a key, random enough that two threads opened in the same second do not
 * race for it — and the (chat, agent, slug) unique index is what actually
 * decides, so a collision is refused rather than silently merged.
 */
function mintThreadSlug(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8)
}

/**
 * The slug a title turns into, or a refusal.
 *
 * A title that slugifies to nothing — punctuation, an emoji, a stray dash — is
 * refused rather than silently replaced by a hash. The person typed something
 * they meant to see in the key, and quietly ignoring it is worse than saying
 * it cannot be used.
 */
function threadSlugFromTitle(title: string): string {
  const candidate = slugify(title)
  if (!candidate) {
    throw new GroupChatAccessError(
      'slug-unusable',
      'That title has no letters or numbers to build a name from — try another',
    )
  }
  return candidate
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
  opts?: { title?: string },
): Promise<StartThreadResult> {
  const { userId } = await requireGroupChatMember(request, groupChatId)
  if (!(await isAgentMember(groupChatId, agentNodeId))) {
    throw new GroupChatAccessError('agent-not-a-member', 'That agent is not a member of this group chat')
  }
  const standing = await standingContextForChat(groupChatId)
  if (!standing) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }

  // A NAMED thread takes its slug from the title; an ad-hoc one gets a short
  // hash. Most threads are ad-hoc, so the hash is the default rather than a
  // fallback for a missing title.
  const title = opts?.title?.trim() || undefined
  const threadSlug = title ? threadSlugFromTitle(title) : mintThreadSlug()
  const [slugTaken] = await db
    .select({ id: groupChatThread.id })
    .from(groupChatThread)
    .where(
      and(
        eq(groupChatThread.groupChatId, groupChatId),
        eq(groupChatThread.agentNodeId, agentNodeId),
        eq(groupChatThread.slug, threadSlug),
      ),
    )
    .limit(1)
  if (slugTaken) {
    // Scoped to (chat, agent) because that is what the key path is. Only a
    // named thread can reach this in practice — two hashes colliding is not
    // something to write copy for, and it refuses identically if it happens.
    throw new GroupChatAccessError('slug-taken', `This agent already has a thread named "${threadSlug}" here`)
  }

  const [chatRow] = await db
    .select({ slug: groupChat.slug })
    .from(groupChat)
    .where(eq(groupChat.id, groupChatId))
    .limit(1)
  if (!chatRow) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  // The agent's slug comes from its NAME, so a key reads as a channel path.
  // Resolved once, at creation: an agent renamed later does not move a key
  // that already exists, and must not.
  const agentNodes = await listAgentNodesImpl()
  const agentName = agentNodes.find((n) => n.nodeId === agentNodeId)?.name ?? agentNodeId
  const sessionKey = mintSessionKey(chatRow.slug, slugify(agentName) || agentNodeId, threadSlug)
  const [thread] = await db
    .insert(groupChatThread)
    // `deliveredContextSignature` is deliberately left NULL here and written
    // only once the prompt below has been accepted -- same rule as
    // `sendMessageInThread`, and for the same reason. Recording it at insert
    // time would mark the context delivered even when the first prompt throws
    // (agent node down, gateway hiccup), leaving a thread whose agent was
    // never told its topic or pins and will not be told until something else
    // changes. Left NULL, a retry re-delivers through the once-on-change path
    // without needing a second mechanism.
    .values({ groupChatId, agentNodeId, sessionKey, slug: threadSlug, title, createdByUserId: userId })
    .returning({
      id: groupChatThread.id,
      groupChatId: groupChatThread.groupChatId,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
      title: groupChatThread.title,
      createdAt: groupChatThread.createdAt,
      draft: groupChatThread.draft,
    })
  if (!thread) {
    throw new Error('The thread could not be created')
  }

  const opened = await ensureLocalSessionImpl({ agentNodeId, jobNodeId: '', tabKey: sessionKey })
  const envelope = composeEnvelope(firstMessage, {
    sessionInit: { jobContext: standing.jobContext, instructions: standing.instructions },
    isNewSession: opened.created,
  })
  await promptLocalImpl({ sessionId: opened.sessionId, text: envelope })
  // Accepted, so what it carried is now on the record. A thread that starts
  // with nothing pinned still records a signature rather than NULL, so the
  // first pin added afterwards reads as a change.
  await db
    .update(groupChatThread)
    .set({ deliveredContextSignature: standing.signature })
    .where(eq(groupChatThread.id, thread.id))

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
    .select(threadDeliveryColumns)
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  await deliverIntoThread(row, text, opts)
}

/** The columns every delivery path needs off a thread row. */
export interface ThreadDeliveryTarget {
  id: string
  groupChatId: string
  agentNodeId: string
  sessionKey: string
  deliveredContextSignature: string | null
}

const threadDeliveryColumns = {
  id: groupChatThread.id,
  groupChatId: groupChatThread.groupChatId,
  agentNodeId: groupChatThread.agentNodeId,
  sessionKey: groupChatThread.sessionKey,
  deliveredContextSignature: groupChatThread.deliveredContextSignature,
}

/**
 * THE ONE DELIVERY PATH INTO A THREAD. Every caller — a person in the browser,
 * an agent through the tool surface, a send-message node's graph-driven send
 * (via deliverThreadFromNode) — reaches an agent through this function and
 * nothing else.
 *
 * It deliberately performs NO authorization: each entry point above answers a
 * different question ("is this user a member?", "is this agent a member?",
 * "is this thread's agent reachable from this send-message node?") and has
 * already answered it. What is shared is delivery, and duplicating that is
 * how one caller quietly stops carrying standing context, or stops respecting
 * the agent-membership rule, without any test noticing.
 *
 * The one rule that IS here rather than in a caller: the thread's agent must
 * still be a member. That is a property of the thread, not of who is asking.
 *
 * Returns whether the message queued behind a turn already running or was
 * dispatched immediately — read right after the session opens and before the
 * prompt below, the same point `deliverToSendMessageNode`'s own `force`
 * handling reads it at, for the same reason: once `promptLocalImpl` is called
 * activeTurns no longer reflects what was true when THIS message arrived.
 */
async function deliverIntoThread(
  row: ThreadDeliveryTarget,
  text: string,
  opts?: { front?: boolean },
): Promise<{ queued: boolean }> {
  // The agent has to still be a member, whoever is sending. Without this,
  // removing an agent is decoration: its threads survive by design, they carry
  // the sessionKey, and every send through them would keep reaching it. This
  // is the rule that makes removal mean something, and it is deliberately NOT
  // collapsed into a not-found refusal — reaching it requires having passed a
  // membership gate already, so it leaks nothing, and the caller needs to be
  // told why a thread it can plainly see will not accept a message.
  if (!(await isAgentMember(row.groupChatId, row.agentNodeId))) {
    throw new GroupChatAccessError('agent-not-a-member', 'That agent is no longer a member of this group chat')
  }
  // The same resolve-or-create the agent:job path uses,
  // not a second copy of it: until this converged on resolveOrCreateSession, a
  // thread's session-open here was ensureLocalSessionImpl called directly,
  // unguarded by the check-then-act lock the agent:job path already had.
  // ensureLocalSessionImpl's own in-flight dedup already coalesces two calls
  // that overlap in time, which is why a from-scratch concurrency test here
  // still passes even with that lock removed (checked directly) — so the
  // provable gain of this change is ONE delivery-serialization primitive
  // instead of two that could drift apart, not a newly-closed race with a
  // test that discriminates it from ensureInFlight's own protection.
  const opened = await resolveOrCreateSession(row.sessionKey, {
    agentNodeId: row.agentNodeId,
    jobNodeId: '',
    tabKey: row.sessionKey,
  })
  const queued = hasActiveTurnImpl(opened.sessionId)

  // ONCE ON CHANGE. If the chat's standing context has moved on since this
  // thread was last told about it, this message carries the new one; otherwise
  // it goes as it was typed.
  //
  // Not with every message, which would put the whole block in front of every
  // turn for no new information. Not force-pushed into an idle session either:
  // a note is not worth interrupting a turn for, so it waits for the person to
  // say something anyway.
  //
  // `isNewSession: true` against a session that is not new is deliberate and
  // has precedent — the compaction restore attaches standing context to an
  // ordinary message the same way. The flag decides whether the session-init
  // parts are attached to THIS message, which is exactly what is wanted here;
  // its name describes only the first of its two uses.
  const standing = await standingContextForChat(row.groupChatId)
  const changed = standing && standing.signature !== row.deliveredContextSignature
  const payload =
    changed && standing
      ? composeEnvelope(text, {
          sessionInit: { jobContext: standing.jobContext, instructions: standing.instructions },
          isNewSession: true,
        })
      : text
  // `front` is forwarded rather than dropped. It is set by the permission
  // "tell it what to do differently" flow, which cancels the run and needs its
  // guidance queued ahead of anything already held. A group-chat thread is an
  // ordinary agent session and reaches that flow too, so a send path that
  // silently ignored it would behave differently from a 1:1 chat in exactly
  // the situation the user is trying to correct the agent.
  await promptLocalImpl({ sessionId: opened.sessionId, text: payload, front: opts?.front })
  // Recorded only after the message carrying it has been accepted: a send that
  // threw would otherwise mark context delivered that never went anywhere, and
  // the next send would skip it.
  if (changed && standing) {
    await db
      .update(groupChatThread)
      .set({ deliveredContextSignature: standing.signature })
      .where(eq(groupChatThread.id, row.id))
  }
  return { queued }
}

/**
 * Compact a thread's session and, on success, re-deliver its CURRENT standing
 * context (topic + pins) rather than whatever was true when the thread last
 * heard from it — see `groupChatStandingContext`'s header for why that is the
 * whole point.
 *
 * `requestCompactOnGraph` resolves standing context two ways: a real graph
 * node/edge presence, or a registered `StandingContextResolver` — a group-chat
 * thread has no graph presence at all, so `[]`/`[]` here is correct rather
 * than a stand-in for "not implemented yet": the resolver registered at
 * server boot (see server/startup.ts) is the only thing that can claim this
 * sessionKey, exactly as it is the only thing that can claim it at restore
 * time inside performCompact.
 *
 * Membership-gated the same way `sendMessageInThread` is, including the
 * agent-still-a-member check: compaction sends `/compact` and a restore
 * prompt into the live session same as an ordinary send does, so a removed
 * agent's threads are refused here for the same reason they are refused a
 * send.
 */
export async function compactThread(request: Request, threadId: string): Promise<CompactAck> {
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
  if (!(await isAgentMember(row.groupChatId, row.agentNodeId))) {
    throw new GroupChatAccessError('agent-not-a-member', 'That agent is no longer a member of this group chat')
  }
  return requestCompactOnGraph([], [], row.sessionKey)
}

/** The compact job's status for a thread — same membership gate as `compactThread`. */
export async function threadCompactStatus(request: Request, threadId: string): Promise<CompactStatus> {
  const sessionUser = await requireSignedInUser(request)
  const [row] = await db
    .select({ groupChatId: groupChatThread.groupChatId, sessionKey: groupChatThread.sessionKey })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  return getCompactStatusOnGraph(row.sessionKey)
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

/**
 * Save (or clear, with an empty string) a thread's unsent composer draft --
 * the same mechanism SessionEntry.draft gives the 1:1 chat, kept per-thread
 * on the thread's own row rather than in that settings-row list, since a
 * thread is not a chat tab and does not belong in that registry.
 *
 * Membership-gated like getThread/deleteThread -- same single refusal for a
 * missing thread and a non-member.
 */
export async function setThreadDraft(request: Request, threadId: string, draft: string): Promise<void> {
  const sessionUser = await requireSignedInUser(request)
  const [row] = await db
    .select({ groupChatId: groupChatThread.groupChatId })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  await db.update(groupChatThread).set({ draft }).where(eq(groupChatThread.id, threadId))
}

// ── The agent-facing surface ─────────────────────────────────────────────
//
// Everything below is reached by an AGENT through the tool surface rather than
// by a person through a browser. Two things are different here and both are
// deliberate:
//
//   - The gate is the CALLING AGENT's membership, not a user's. A person's
//     session says nothing about which agent is asking.
//   - The caller is identified by NAME, resolved to an agent node. Names are
//     taken to be unique, which is the design decision recorded on
//     `listGroupChatsForAgent` and not an assumption made here.
//
// THE ANTI-LOOP BOUNDARY, stated once, here, because it is the thing a reader
// will want to check and it is easy to get wrong later:
//
// An agent may send into a thread whose agent is ITSELF. That is not an
// oversight to be closed — it is the point. An agent cannot dispatch to itself
// across `agent:*` sessions (that IS an anti-loop rule), so a group-chat thread
// is the sanctioned way to hand work to a fresh-context instance of the same
// agent, which is exactly what delegating a review needs.
//
// What makes that safe is the direction of travel, and it must stay true:
// **a reply never comes back.** The thread's agent answers into the thread's
// own session, and that transcript reaches a person on a screen. Nothing in
// this file, and nothing in the delivery path it calls, routes a reply into the
// sending agent's session. A future change that gives a thread reply a way to
// wake its sender is not a feature addition — it closes the loop this design
// leaves open on purpose, and it needs the anti-loop question reopened first.
//
// What is NOT prevented, and cannot be from here: two agents that both choose
// to send into each other's threads will keep each other awake. That requires
// both of them to act, every hop, so it is a behaviour to notice rather than a
// hole to plug — but nothing here would stop it.

/** One thread as an agent sees it. No session key: an agent never needs one. */
export interface AgentThreadRef {
  /**
   * How to address this thread in a send. Readable where the thread has a slug
   * (`<group-slug>:<agent-slug>:<thread-slug>`), and the thread's id for one
   * created before slugs existed. Either way, passed back unchanged.
   */
  ref: string
  title: string | null
  /** The agent this thread talks to — which may be the caller itself. */
  agentNodeId: string
  createdAt: Date
}

export interface AgentGroupChatRef {
  ref: string
  name: string
  topic: string
  threads: AgentThreadRef[]
}

/**
 * Resolve an agent name to its node id, or refuse the way every other lookup
 * here does.
 *
 * A NAME THAT MATCHES NOTHING IS A REFUSAL, not an empty result: a tool caller
 * who is not a recognised agent must be told so rather than handed a plausible
 * "you are in no group chats", which reads as an answer and is not one.
 */
async function requireAgentNode(agentName: string): Promise<string> {
  const trimmed = agentName.trim()
  const nodes = await listAgentNodesImpl()
  const match = nodes.find((n) => n.name === trimmed)
  if (!match) {
    throw new GroupChatAccessError('not-found', `No agent named "${trimmed}" was found`)
  }
  return match.nodeId
}

/**
 * A readable thread address: `<group-slug>:<agent-slug>:<thread-slug>` — the
 * part of a session key a person or an agent can read off a screen. A whole
 * key works too, prefix included, so one pasted back is a valid address.
 *
 * MATCHED AGAINST THE STORED KEY EXACTLY, on that column's own unique index.
 * Matching the (group slug, thread slug) pair instead — dropping the agent
 * segment — is ambiguous: thread-slug uniqueness is scoped to (chat, agent),
 * so two threads with the same slug and different agents in one chat are
 * legal, and an address naming one of them could deliver to the other. That is
 * the one wrong-recipient failure a membership gate cannot catch, because a
 * sender able to write the address is a member of both.
 *
 * A stored key never changes, so exact matching is also immune to an agent
 * rename: the key keeps the agent segment it was minted with, and every
 * reference the list surface hands out IS that stored key's readable part, so
 * a reference passed back always matches itself. What it does not accept is a
 * hand-written address using an agent's CURRENT name after a rename — and an
 * unambiguous address is worth more than that convenience.
 *
 * Returns null rather than refusing when nothing matches, so the caller falls
 * through to an id: the forms are alternatives, and an agent that stored an id
 * before slugs existed keeps working.
 */
async function resolveByKey(ref: string): Promise<ThreadDeliveryTarget | null> {
  const key = ref.startsWith('group-chat:') ? ref : `group-chat:${ref}`
  const [row] = await db
    .select(threadDeliveryColumns)
    .from(groupChatThread)
    .where(eq(groupChatThread.sessionKey, key))
    .limit(1)
  return row ?? null
}

async function resolveById(ref: string): Promise<ThreadDeliveryTarget | null> {
  const [row] = await db.select(threadDeliveryColumns).from(groupChatThread).where(eq(groupChatThread.id, ref)).limit(1)
  return row ?? null
}

/**
 * A THREAD REFERENCE IS OPAQUE TO THE CALLER, and resolved here.
 *
 * It is a readable address, a whole session key, or a thread id — resolved
 * here and nowhere else. No tool schema names any of those forms: the moment a
 * contract promises one, every caller that stored a reference is bound to it.
 * That is what let the readable form arrive as a second branch rather than a
 * breaking change, and it is why the id branch can stay for callers that
 * stored one before readable keys existed.
 *
 * Membership is checked against the resolved thread's own chat, so an
 * unresolvable reference and a thread in someone else's chat are the same
 * refusal — a reference must not be a way to learn which threads exist.
 */
async function resolveThreadForAgent(agentNodeId: string, threadRef: string): Promise<ThreadDeliveryTarget> {
  const trimmed = threadRef.trim()
  if (!trimmed) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  const row = (await resolveByKey(trimmed)) ?? (await resolveById(trimmed))
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  if (!(await isAgentMember(row.groupChatId, agentNodeId))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  return row
}

/**
 * Every group chat this agent is a member of, with its threads.
 *
 * The membership gate is the query itself — chats are selected by this agent's
 * own membership row — so nothing here can return a chat the agent is not in.
 */
export async function listGroupChatsForAgentView(agentName: string): Promise<AgentGroupChatRef[]> {
  const agentNodeId = await requireAgentNode(agentName)
  const chats = await db
    .select({ id: groupChat.id, name: groupChat.name, topic: groupChat.topic })
    .from(groupChat)
    .innerJoin(groupChatMember, eq(groupChatMember.groupChatId, groupChat.id))
    .where(eq(groupChatMember.agentNodeId, agentNodeId))
  if (chats.length === 0) {
    return []
  }
  const threads = await db
    .select({
      id: groupChatThread.id,
      groupChatId: groupChatThread.groupChatId,
      title: groupChatThread.title,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
      slug: groupChatThread.slug,
      createdAt: groupChatThread.createdAt,
    })
    .from(groupChatThread)
    .where(
      inArray(
        groupChatThread.groupChatId,
        chats.map((c) => c.id),
      ),
    )
  return chats.map((chat) => ({
    ref: chat.id,
    name: chat.name,
    topic: chat.topic,
    threads: threads
      .filter((t) => t.groupChatId === chat.id)
      .map((t) => ({
        ref: t.slug && t.sessionKey.startsWith('group-chat:') ? t.sessionKey.slice('group-chat:'.length) : t.id,
        title: t.title,
        agentNodeId: t.agentNodeId,
        createdAt: t.createdAt,
      })),
  }))
}

/**
 * Send into a thread as an agent.
 *
 * Gated on the CALLING agent's membership in that thread's chat, then handed to
 * the same `deliverIntoThread` a person's send goes through — so standing
 * context, the once-on-change rule and the agent-membership check are the same
 * code, not a second copy that drifts.
 *
 * No `front`: that flag exists for the permission flow's corrective guidance,
 * where a person is interrupting a run they are watching. An agent writing to a
 * thread-mate is an ordinary message and queues like one.
 */
export async function sendMessageInThreadAsAgent(agentName: string, threadRef: string, text: string): Promise<void> {
  const agentNodeId = await requireAgentNode(agentName)
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('A message needs some text')
  }
  const row = await resolveThreadForAgent(agentNodeId, threadRef)
  await deliverIntoThread(row, trimmed)
}

/**
 * Send into a thread from a send-message node's graph-driven envelope — the
 * third caller of the shared delivery path, distinct from both the ones
 * above. Neither a user session nor a calling agent's own membership is the
 * right gate here: a scheduled pipeline is asking on behalf of nobody in
 * particular, so what stands in for authorization is the send-message node's
 * OWN graph wiring — the same authority `reachablePairs` already grants the
 * agent:job routing path.
 *
 * `isReachable` is that check, handed in by the caller rather than read here:
 * the graph belongs to the node doing the sending, and this module has no
 * business holding a copy of it. This function only resolves WHICH agent a
 * thread belongs to and asks; it does not decide the answer.
 *
 * Registered with stream.ts's thread-delivery registry at server startup
 * (registerThreadDeliveryResolver) rather than imported there directly — see
 * that registry's own header for why stream.ts must not import group-chat
 * code.
 */
export async function deliverThreadFromNode(
  threadRef: string,
  text: string,
  isReachable: (agentNodeId: string) => boolean,
): Promise<ThreadDeliveryOutcome> {
  const trimmed = threadRef.trim()
  if (!trimmed) {
    return { status: 'not-found' }
  }
  const row = (await resolveByKey(trimmed)) ?? (await resolveById(trimmed))
  if (!row) {
    return { status: 'not-found' }
  }
  if (!isReachable(row.agentNodeId)) {
    return { status: 'not-reachable' }
  }
  const { queued } = await deliverIntoThread(row, text)
  return { status: queued ? 'queued' : 'delivered' }
}
