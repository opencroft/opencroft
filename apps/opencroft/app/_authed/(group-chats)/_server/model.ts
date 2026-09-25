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
import {
  agentQueueEntry,
  db,
  groupChat,
  groupChatMember,
  groupChatPin,
  groupChatSlugAlias,
  groupChatThread,
  groupChatThreadAlias,
  space,
  spaceSlugAlias,
  user,
} from '@opencroft/db'
import type { QueueMode } from 'agent-client/types'
import { and, asc, eq, inArray, like, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'

import type { OpenedSession } from '@/app/_authed/(agent)/_server/acp-impl'
import {
  agentConfiguredWindowByNodeId,
  ensureLocalSessionImpl,
  forgetLocalSessionImpl,
  forkTurnLocalImpl,
  hasActiveTurnForKeyImpl,
  hasActiveTurnImpl,
  promptLocalImpl,
  stopLocalSessionProcessImpl,
} from '@/app/_authed/(agent)/_server/acp-impl'
import { readLastKnownUsage, readPersistedSession } from '@/app/_authed/(agent)/_server/acp-session-store'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import {
  settleSessionKeyMoves,
  stageSessionKeyMoves,
  type TabKeyMove,
} from '@/app/_authed/(agent)/_server/session-key-move'
import { composeEnvelope } from '@/app/_authed/(agent)/_shared/message-envelope'
import { type TurnsPage, turnsPageForSessionKey } from '@/app/_authed/(extension-runtime)/_server/host'
import { type ContextUsage, toContextUsage } from '@/app/_authed/(extension-runtime)/_server/session-context-usage'
import type {
  CompactAck,
  CompactResult,
  CompactStatus,
  ThreadDeliveryOutcome,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import {
  getCompactStatus,
  requestCompact,
  resolveOrCreateSession,
  withSessionKeyLock,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import { storedGroupChatKeys } from '@/app/_authed/(group-chats)/_server/orphaned-session-keys'
import {
  folderNameByThreadId,
  readThreadLayout,
  updateThreadLayout,
  withThreadInFolder,
} from '@/app/_authed/(group-chats)/_server/thread-layout-store'
import { GroupChatAccessError, type GroupChatAccessFailure } from '@/app/_authed/(group-chats)/_shared/access-error'
import {
  isGroupChatSessionKey,
  mintSessionKey,
  partsOfSessionKey,
  SESSION_KEY_PREFIX,
  type SessionKeyParts,
} from '@/app/_authed/(group-chats)/_shared/session-key'
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

import {
  type AgentRef,
  agentNodesNamed,
  agentRefName,
  listAgentNodesImpl,
} from '@/app/_authed/(space)/_server/agents-impl'
import {
  authorForAgentNode,
  authorForPerson,
  isKnownSystemSender,
  type SendPrincipal,
} from '@/app/_server/message-author'

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

// ONE membership question for every kind of principal: does a row exist. The
// kind selects which id column identifies the member — representation, not a
// different rule — so a system sender is checked by exactly the mechanism a
// person or an agent is, and there is no branch anywhere that waves a kind
// through without its row.
async function isPrincipalMember(groupChatId: string, principal: MemberPrincipal): Promise<boolean> {
  const byId =
    principal.kind === 'user'
      ? eq(groupChatMember.userId, principal.userId)
      : principal.kind === 'agent'
        ? eq(groupChatMember.agentNodeId, principal.agentNodeId)
        : eq(groupChatMember.systemId, principal.systemId)
  const [row] = await db
    .select({ id: groupChatMember.id })
    .from(groupChatMember)
    .where(and(eq(groupChatMember.groupChatId, groupChatId), byId))
    .limit(1)
  return !!row
}

async function isUserMember(groupChatId: string, userId: string): Promise<boolean> {
  return isPrincipalMember(groupChatId, { kind: 'user', userId })
}

async function isAgentMember(groupChatId: string, agentNodeId: string): Promise<boolean> {
  return isPrincipalMember(groupChatId, { kind: 'agent', agentNodeId })
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
export async function requireGroupChatMember(request: Request, groupChatId: string): Promise<{ userId: string }> {
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

/**
 * The same check, for a request that names an agent session by its key rather
 * than a group chat by its id: the caller must be a member of the group chat
 * whose thread owns that key. A retired key of a renamed thread still names it.
 *
 * A key no thread owns, no key at all (a session id that resolved to none) and
 * a thread in a chat the caller is not in are one refusal, as above — telling
 * them apart would tell an outsider which sessions exist. The sign-in check
 * comes first for the same reason: an anonymous caller is refused before
 * anything about the key is looked at.
 */
export async function requireSessionKeyMember(
  request: Request,
  sessionKey: string | null,
): Promise<{ sessionKey: string; agentNodeId: string }> {
  const sessionUser = await requireSignedInUser(request)
  const threadId = sessionKey ? await threadIdForSessionKey(sessionKey) : null
  const [row] = threadId
    ? await db
        .select({ groupChatId: groupChatThread.groupChatId, agentNodeId: groupChatThread.agentNodeId })
        .from(groupChatThread)
        .where(eq(groupChatThread.id, threadId))
        .limit(1)
    : []
  if (!sessionKey || !row || !(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  return { sessionKey, agentNodeId: row.agentNodeId }
}

/** The session keys of every thread in every group chat the caller is a member of. */
export async function listMemberSessionKeys(request: Request): Promise<Set<string>> {
  const sessionUser = await requireSignedInUser(request)
  const rows = await db
    .select({ sessionKey: groupChatThread.sessionKey })
    .from(groupChatThread)
    .innerJoin(groupChatMember, eq(groupChatMember.groupChatId, groupChatThread.groupChatId))
    .where(eq(groupChatMember.userId, sessionUser.id))
  return new Set(rows.map((row) => row.sessionKey))
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
  // First match, because agent names are a decided-unique namespace — the
  // paragraph above, not a judgement made here. `agentNodesNamed` owns only
  // how a name is compared, so this policy stays visible at the site that
  // holds it.
  const match = agentNodesNamed(await listAgentNodesImpl(), agentName)[0]
  if (!match) {
    throw new GroupChatAccessError('not-found', `No agent named "${agentName.trim()}" was found`)
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

/** The columns a `GroupChatSummary` is made of, named once so the live and
 *  alias lookups below cannot select different shapes for the same type. */
const chatColumns = {
  id: groupChat.id,
  slug: groupChat.slug,
  name: groupChat.name,
  topic: groupChat.topic,
  createdAt: groupChat.createdAt,
  updatedAt: groupChat.updatedAt,
}

/** The columns a `GroupChatThreadSummary` is made of, named once so the live
 *  and alias lookups below cannot select different shapes for the same type. */
const threadSummaryColumns = {
  id: groupChatThread.id,
  groupChatId: groupChatThread.groupChatId,
  agentNodeId: groupChatThread.agentNodeId,
  sessionKey: groupChatThread.sessionKey,
  title: groupChatThread.title,
  createdAt: groupChatThread.createdAt,
  draft: groupChatThread.draft,
}

export type GroupChatSlugResolution =
  | { state: 'missing' }
  | { state: 'not-a-member'; joinable: boolean }
  | { state: 'member'; chat: GroupChatSummary }

/**
 * The chat a slug addresses: live first, alias second.
 *
 * A SLUG A RENAME FREED STILL RESOLVES, through `groupChatSlugAlias`, because
 * an extension's configured `space` is written down somewhere nobody edits when
 * a chat is renamed -- without this a rename drops every embed into its "this
 * chat does not exist" create flow, and reports nothing wrong while doing it.
 *
 * The ordering is load-bearing rather than cosmetic: if a later chat has taken
 * this slug for real, the chat holding it NOW is the answer. Every path that
 * binds a slug live deletes the alias on it, so the two should never both match
 * -- reading live first is what makes that a guarantee instead of a likelihood.
 *
 * Shared by the resolution below and by `joinSpaceGroupChat`, so one address
 * cannot mean two different chats depending on which of them asked.
 */
async function chatRowBySlug(chatSlug: string): Promise<GroupChatSummary | null> {
  const [live] = await db.select(chatColumns).from(groupChat).where(eq(groupChat.slug, chatSlug)).limit(1)
  if (live) {
    return live
  }
  const [aliased] = await db
    .select(chatColumns)
    .from(groupChat)
    .innerJoin(groupChatSlugAlias, eq(groupChatSlugAlias.groupChatId, groupChat.id))
    .where(eq(groupChatSlugAlias.slug, chatSlug))
    .limit(1)
  return aliased ?? null
}

/**
 * Whether a slug addresses a SPACE — live slug first, then one a rename freed,
 * the same ordering and for the same reason as `chatRowBySlug` above. Asked of
 * the tables rather than through the spaces registry, which would put the graph
 * runtime behind every membership question this file answers.
 *
 * A chat at a space's own address IS that space's chat by construction: the
 * embed looks its chat up by the space's slug, and the create flow mints one
 * at that slug precisely so the two agree.
 *
 * This is also the whole of "is the caller in the space" today. Spaces carry
 * no membership of their own, so every signed-in user is in every one of them;
 * when space-level restrictions arrive they replace this function's body and
 * nothing else here has to move.
 */
async function slugAddressesASpace(spaceSlug: string): Promise<boolean> {
  const [live] = await db.select({ id: space.id }).from(space).where(eq(space.slug, spaceSlug)).limit(1)
  if (live) {
    return true
  }
  const [aliased] = await db
    .select({ spaceId: spaceSlugAlias.spaceId })
    .from(spaceSlugAlias)
    .where(eq(spaceSlugAlias.slug, spaceSlug))
    .limit(1)
  return !!aliased
}

/**
 * How an embedded surface's `space` slug resolves for the signed-in caller.
 * The input is slugified first — the surface passes whatever string its host
 * configured, and the slug column only ever holds `slugify` output.
 *
 * `missing` and `not-a-member` are DELIBERATELY distinguishable here, unlike
 * everywhere else in this file (see requireGroupChatMember's collapse). The
 * embedding surface offers to CREATE a chat whose slug does not exist, so it
 * has to know which case it is in — and the distinction discloses nothing the
 * caller could not already learn: `createGroupChat` refuses `slug-taken` for
 * any existing slug, member or not, so slug existence is observable to every
 * signed-in user through the creation path this same surface offers.
 *
 * WHAT `not-a-member` SHOWS IS NO LONGER THE COLLAPSED REFUSAL, where the slug
 * addresses a space. This comment used to say it must be; that was this file's
 * own choice and it was reversed — a person who is in the space
 * has the right to enter that space's chat, so the surface offers to JOIN.
 * Space-level restrictions do not exist yet, which is why `slugAddressesASpace`
 * above is the whole of "is the caller in the space" today, and is where a real
 * gate goes when there is one.
 *
 * `joinable` carries that scope, and it is decided HERE rather than left to the
 * caller: the same embedded component is handed to extensions through the host
 * API and may be mounted against any slug at all. Whether Join belongs on an
 * arbitrary group chat — one with no space-membership argument behind it — is a
 * question the rule does not answer, so a slug naming no space keeps exactly
 * the refusal it had.
 */
export async function resolveGroupChatBySlug(request: Request, slug: string): Promise<GroupChatSlugResolution> {
  const sessionUser = await requireSignedInUser(request)
  const chatSlug = slugify(slug)
  if (!chatSlug) {
    return { state: 'missing' }
  }
  const row = await chatRowBySlug(chatSlug)
  if (!row) {
    return { state: 'missing' }
  }
  if (!(await isUserMember(row.id, sessionUser.id))) {
    return { state: 'not-a-member', joinable: await slugAddressesASpace(chatSlug) }
  }
  return { state: 'member', chat: row }
}

/**
 * One agent's thread with a given slug inside a group chat, or null.
 *
 * Membership-gated exactly as every other read here. Null is an answer, not a
 * refusal: for the embedded surface a missing thread means "the first send
 * will create it" (through `startThread`, which re-checks everything), so the
 * caller needs the absence as data. Scoped to (chat, agent, slug) because
 * that is the unique index — the same slug under another agent is a different
 * thread by design.
 */
export async function findThreadBySlug(
  request: Request,
  groupChatId: string,
  agentNodeId: string,
  threadSlug: string,
): Promise<GroupChatThreadSummary | null> {
  await requireGroupChatMember(request, groupChatId)
  const [live] = await db
    .select(threadSummaryColumns)
    .from(groupChatThread)
    .where(
      and(
        eq(groupChatThread.groupChatId, groupChatId),
        eq(groupChatThread.agentNodeId, agentNodeId),
        eq(groupChatThread.slug, threadSlug),
      ),
    )
    .limit(1)
  if (live) {
    return live
  }
  // A slug a rename freed, scoped exactly as the live lookup is, and reached
  // in the same live-first order for the same reason as `resolveGroupChatBySlug`
  // above. Without it a renamed thread makes an embedded surface silently start
  // a SECOND, empty thread beside the conversation it meant to open.
  const [aliased] = await db
    .select(threadSummaryColumns)
    .from(groupChatThread)
    .innerJoin(groupChatThreadAlias, eq(groupChatThreadAlias.threadId, groupChatThread.id))
    .where(
      and(
        eq(groupChatThreadAlias.groupChatId, groupChatId),
        eq(groupChatThreadAlias.agentNodeId, agentNodeId),
        eq(groupChatThreadAlias.slug, threadSlug),
      ),
    )
    .limit(1)
  return aliased ?? null
}

/** Every thread in a group chat. Membership-gated, not filtered after the fact. */
export async function listThreadsInGroupChat(request: Request, groupChatId: string): Promise<GroupChatThreadSummary[]> {
  await requireGroupChatMember(request, groupChatId)
  return db.select(threadSummaryColumns).from(groupChatThread).where(eq(groupChatThread.groupChatId, groupChatId))
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
    .select(threadSummaryColumns)
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
/** Options for `createGroupChat`. */
export interface CreateGroupChatOptions {
  /**
   * The chat's slug, when the caller owns the address rather than deriving it
   * from the name.
   *
   * A space's own chat is the case this exists for: the space finds its chat by
   * looking up its OWN slug, so the two have to be the same string. Letting the
   * name decide breaks that the moment a display name and a space slug differ,
   * which they routinely do.
   *
   * A slug given here is CHECKED, never repaired. Slugifying it for the caller
   * would be the one failure this seam must not have: the caller looks the chat
   * up again by the address it passed in, so a slug quietly minted as something
   * else surfaces much later as "no such chat" rather than as the bad argument
   * it was, at a point where nothing connects the two.
   */
  slug?: string
}

// A caller-supplied slug is checked rather than repaired -- see
// `CreateGroupChatOptions.slug` for why. A fault, not a refusal: the name path's
// refusals are shown in a form, and this argument comes from code.
function checkedSlug(slug: string): string {
  if (!slug || slugify(slug) !== slug) {
    throw new Error(`Not a usable group chat slug: ${JSON.stringify(slug)}`)
  }
  return slug
}

export async function createGroupChat(
  request: Request,
  name: string,
  topic?: string,
  options?: CreateGroupChatOptions,
): Promise<GroupChatSummary> {
  const sessionUser = await requireSignedInUser(request)
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new Error('A group chat needs a name')
  }
  const trimmedTopic = topic?.trim() || trimmedName
  // The slug is fixed from here: it goes into every session key this chat's
  // threads are opened under, and a key that moves is a key that stops finding
  // its session. It comes from the name unless the caller owns the address.
  const chatSlug = options?.slug === undefined ? slugify(trimmedName) : checkedSlug(options.slug)
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
    // Two different sentences because there are two different callers. Someone
    // naming a chat needs to hear about the name; something minting a chat at
    // an address it already holds needs to hear about the address, which is the
    // only part it chose.
    throw new GroupChatAccessError(
      'slug-taken',
      options?.slug === undefined
        ? `A group chat named "${trimmedName}" already exists`
        : `A group chat already answers to "${chatSlug}"`,
    )
  }
  return db.transaction(async (tx) => {
    // A LIVE CHAT OUTRANKS AN ALIAS, so taking this slug takes it outright: any
    // alias still freeing it is dropped in the same transaction that binds it.
    // Leaving both would give one address two answers, and the one that is not
    // the chat just created is a wrong-recipient bug waiting to happen.
    await tx.delete(groupChatSlugAlias).where(eq(groupChatSlugAlias.slug, chatSlug))
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
 * Rename a group chat: the name people read AND the slug everything addresses
 * it by, which means every thread in it is re-keyed. Membership-gated like
 * every other write here.
 *
 * THE SLUG IS THE IDENTITY OF EVERY LIVE SESSION UNDERNEATH, not a label. It is
 * a segment of each thread's session key, and that key is what the durable
 * session pointer, the in-process registries and agent-client all file the
 * conversation under. So this is a migration rather than an update, and the
 * order it happens in is what keeps a half-finished one harmless:
 *
 *   1. Work out every key that moves, and refuse before touching anything if
 *      the new slug is taken.
 *   2. `stageSessionKeyMoves` -- make the new keys resolve to the sessions the
 *      old keys resolve to. Nothing addresses them yet, so this is inert.
 *   3. One transaction: the chat's slug and name, every thread's key, and the
 *      aliases that keep the freed addresses working. All of it or none.
 *   4. `settleSessionKeyMoves` -- retire the old keys and repoint what is held
 *      in memory. Past the commit, so it never reports failure upward.
 *
 * Interrupted anywhere, no thread is left naming a session that cannot be
 * found: step 2 guarantees the new key already works before step 3 makes it the
 * address, and step 4 only tidies up after it is.
 *
 * NOTHING IS RE-DELIVERED TO ANY AGENT, deliberately -- the same contract
 * `setGroupChatTopic` documents. A rename is not a new task and must not
 * interrupt a turn to announce itself; the aliases, not a notification, are
 * what keep an agent's stored thread address working.
 *
 * The AGENT segment of a key is untouched. It was frozen at thread creation
 * (see `startThread`) and stays frozen: whether renaming an agent should move
 * it too is a separate question, deliberately not answered here.
 */
export async function renameGroupChat(request: Request, groupChatId: string, name: string): Promise<void> {
  await requireGroupChatMember(request, groupChatId)
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('A group chat needs a name')
  }
  const [chat] = await db.select({ slug: groupChat.slug }).from(groupChat).where(eq(groupChat.id, groupChatId)).limit(1)
  if (!chat) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  const nextSlug = slugify(trimmed)
  if (!nextSlug) {
    throw new GroupChatAccessError('slug-unusable', 'That name has no letters or numbers to build a name from')
  }
  // Capitalisation, punctuation, a trailing space: a name that slugifies to
  // what this chat already answers to is a display change and nothing more.
  // Migrating for it would re-mint every key to its own value and write aliases
  // for addresses that never moved.
  if (nextSlug === chat.slug) {
    await db.update(groupChat).set({ name: trimmed }).where(eq(groupChat.id, groupChatId))
    return
  }
  const [taken] = await db.select({ id: groupChat.id }).from(groupChat).where(eq(groupChat.slug, nextSlug)).limit(1)
  if (taken) {
    // The refusal creation already gives, with the same code, because a taken
    // name is something the person can act on. Silently suffixing it would hand
    // them an address they did not choose and cannot predict.
    throw new GroupChatAccessError('slug-taken', `A group chat named "${trimmed}" already exists`)
  }

  const threads = await db
    .select({
      id: groupChatThread.id,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
    })
    .from(groupChatThread)
    .where(eq(groupChatThread.groupChatId, groupChatId))
  const moves = threads.flatMap((thread) => {
    const parts = partsOfSessionKey(thread.sessionKey)
    // Only a key this chat's CURRENT slug is genuinely a segment of moves. A
    // thread from before slugs existed carries ids where these carry slugs, so
    // no rename can stale it, and re-minting one would break an address that
    // was working. This check is what tells the two apart.
    if (!parts || parts.chatSlug !== chat.slug) {
      return []
    }
    return [
      {
        threadId: thread.id,
        agentNodeId: thread.agentNodeId,
        from: thread.sessionKey,
        to: mintSessionKey(nextSlug, parts.agentSlug, parts.threadSlug),
      },
    ]
  })

  await requireSessionKeysFree(
    moves.map((move) => move.to),
    moves.map((move) => move.threadId),
  )
  await stageSessionKeyMoves(moves)
  await db.transaction(async (tx) => {
    await tx.delete(groupChatSlugAlias).where(inArray(groupChatSlugAlias.slug, [chat.slug, nextSlug]))
    await tx.insert(groupChatSlugAlias).values({ slug: chat.slug, groupChatId })
    await tx.update(groupChat).set({ name: trimmed, slug: nextSlug }).where(eq(groupChat.id, groupChatId))
    for (const move of moves) {
      await tx.delete(groupChatThreadAlias).where(eq(groupChatThreadAlias.sessionKey, move.to))
      // `slug: null` -- a chat rename frees the whole address, not the thread's
      // own slug, which has not moved. See the alias table's own comment.
      await tx.insert(groupChatThreadAlias).values({
        threadId: move.threadId,
        groupChatId,
        agentNodeId: move.agentNodeId,
        sessionKey: move.from,
        slug: null,
      })
      await tx.update(groupChatThread).set({ sessionKey: move.to }).where(eq(groupChatThread.id, move.threadId))
    }
  })
  await settleSessionKeyMoves(moves)
}

export interface ThreadKeyMigrationReport {
  /** Every colon-form thread key and the dot key it moved to. */
  moves: Array<{ from: string; to: string; pointerMoved: boolean }>
  /** Keys left as found, each with the reason. */
  skipped: Array<{ sessionKey: string; reason: string }>
  /** Colon-form alias rows deleted: addresses nothing resolves any more. */
  aliasesRetired: number
  /** Per-store spelling census, taken after the run. */
  stores: {
    threads: { colon: number; dot: number }
    queue: { colon: number; dot: number }
    aliases: { colon: number; dot: number }
  }
}

/**
 * One log line for a run that changed something, or null for a run that did not.
 *
 * Keyed on writes alone: a pre-slug key is colon-prefixed forever, so every
 * later run finds and skips it again, and counting skips as work would make an
 * already-migrated store report on every start.
 */
export function describeThreadKeyMigration(report: ThreadKeyMigrationReport): string | null {
  if (report.moves.length === 0 && report.aliasesRetired === 0) {
    return null
  }
  const withoutPointer = report.moves.filter((move) => !move.pointerMoved).length
  const { threads, queue, aliases } = report.stores
  return (
    `moved ${report.moves.length} thread key(s) to the dot form ` +
    `(${withoutPointer} without a durable session pointer), ` +
    `left ${report.skipped.length} pre-slug key(s) as found, ` +
    `retired ${report.aliasesRetired} colon alias(es); ` +
    `stores now colon/dot -- threads ${threads.colon}/${threads.dot}, ` +
    `queue ${queue.colon}/${queue.dot}, aliases ${aliases.colon}/${aliases.dot}`
  )
}

async function countKeySpellings(table: typeof groupChatThread | typeof agentQueueEntry | typeof groupChatThreadAlias): Promise<{ colon: number; dot: number }> {
  const [row] = await db
    .select({
      colon: sql<number>`count(*) filter (where ${table.sessionKey} like ${'group-chat:%'})`,
      dot: sql<number>`count(*) filter (where ${table.sessionKey} like ${'group-chat.%'})`,
    })
    .from(table)
  return { colon: Number(row?.colon ?? 0), dot: Number(row?.dot ?? 0) }
}

/**
 * The colon storage form from before the dot migration, taken apart.
 *
 * The ONLY reader of that form left. Resolution, parsing and every emitted
 * reference know the dot form alone; this exists so a database that was never
 * migrated -- above all a restored backup from before the move -- is migrated
 * at start instead of stranding every thread it holds.
 */
function partsOfColonSessionKey(sessionKey: string): SessionKeyParts | null {
  const match = /^group-chat:([^.:]+):([^.:]+):([^.:]+)$/.exec(sessionKey)
  if (!match?.[1] || !match[2] || !match[3]) {
    return null
  }
  return { chatSlug: match[1], agentSlug: match[2], threadSlug: match[3] }
}

/**
 * Delete the colon aliases no store holds any state under, and count them.
 * One that still holds something is marking an incomplete move and stays --
 * see `migrateThreadSessionKeys`.
 */
async function retireEmptyColonAliases(): Promise<number> {
  const colonAliases = await db
    .select({ id: groupChatThreadAlias.id, sessionKey: groupChatThreadAlias.sessionKey })
    .from(groupChatThreadAlias)
    .where(like(groupChatThreadAlias.sessionKey, 'group-chat:%'))
  if (colonAliases.length === 0) {
    return 0
  }
  const stored = await storedGroupChatKeys()
  const empty = colonAliases.filter((alias) => alias.sessionKey && !stored.has(alias.sessionKey))
  if (empty.length > 0) {
    await db.delete(groupChatThreadAlias).where(inArray(groupChatThreadAlias.id, empty.map((alias) => alias.id)))
  }
  return empty.length
}

/**
 * Move every stored colon-form thread key to its dot spelling — the same
 * key-move a chat rename drives, where the new key differs in FORMAT rather
 * than slug. Nothing here is a new mechanism: staging, the transaction shape
 * and the settle are the rename's own, so every intermediate state is the same
 * designed-harmless state a rename can leave.
 *
 * Per DATABASE, not per instance — two instances sharing a database share
 * these rows, so the second one finds them already moved and this no-ops.
 * Idempotent by selection: only colon-prefixed keys are candidates, so a
 * second run finds none. Safe against a concurrent rename for the same
 * reason renames are safe against each other: `requireSessionKeysFree`
 * refuses a destination that sprang into existence, and a thread whose key a
 * rename already re-minted no longer matches the colon selection.
 *
 * The freed colon key gets an alias in the same transaction that moves the
 * row, and it is not for resolving -- nothing resolves the colon spelling any
 * more. It is what marks state still filed under that key as the thread's
 * while the move is incomplete: a settle step that failed, or a process that
 * died between the transaction and the settle, leaves the queue or transcript
 * there, and the orphaned-key sweep keeps state under a live alias rather than
 * forgetting it. So a colon alias is retired only once no store holds anything
 * under it -- which, after a settle that completed, is the same run.
 *
 * Run by the server at start, before anything can look a thread up. A run
 * with nothing to move or retire writes nothing. It can be deleted once no
 * backup taken before the move is still a rollback point -- restoring one
 * under code without this strands every thread in it.
 */
export async function migrateThreadSessionKeys(): Promise<ThreadKeyMigrationReport> {
  const rows = await db
    .select({
      id: groupChatThread.id,
      groupChatId: groupChatThread.groupChatId,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
    })
    .from(groupChatThread)
    .where(like(groupChatThread.sessionKey, 'group-chat:%'))

  const moves: Array<{ threadId: string; groupChatId: string; agentNodeId: string; from: string; to: string }> = []
  const skipped: Array<{ sessionKey: string; reason: string }> = []
  for (const row of rows) {
    const parts = partsOfColonSessionKey(row.sessionKey)
    if (!parts) {
      // A colon-prefixed key that does not split into four slug segments is
      // from before slugs existed. Left exactly as found — it resolves as the
      // exact stored key, no rename can stale it, and rewriting it would break
      // a working address to tidy a spelling.
      skipped.push({ sessionKey: row.sessionKey, reason: 'not a four-segment slug key; left as found' })
      continue
    }
    moves.push({
      threadId: row.id,
      groupChatId: row.groupChatId,
      agentNodeId: row.agentNodeId,
      from: row.sessionKey,
      to: mintSessionKey(parts.chatSlug, parts.agentSlug, parts.threadSlug),
    })
  }

  if (moves.length > 0) {
    await requireSessionKeysFree(
      moves.map((move) => move.to),
      moves.map((move) => move.threadId),
    )
    await stageSessionKeyMoves(moves)
    await db.transaction(async (tx) => {
      for (const move of moves) {
        await tx.delete(groupChatThreadAlias).where(eq(groupChatThreadAlias.sessionKey, move.to))
        await tx.insert(groupChatThreadAlias).values({
          threadId: move.threadId,
          groupChatId: move.groupChatId,
          agentNodeId: move.agentNodeId,
          sessionKey: move.from,
          slug: null,
        })
        await tx.update(groupChatThread).set({ sessionKey: move.to }).where(eq(groupChatThread.id, move.threadId))
      }
    })
    await settleSessionKeyMoves(moves)
  }
  const aliasesRetired = await retireEmptyColonAliases()

  // The census is taken after the move so acceptance is a reading of the
  // stores, not an inference from the loop having finished. The per-move
  // pointer check answers for the fourth store the same way.
  return {
    moves: await Promise.all(
      moves.map(async (move) => ({
        from: move.from,
        to: move.to,
        pointerMoved: (await readPersistedSession(move.to)) !== null,
      })),
    ),
    skipped,
    aliasesRetired,
    stores: {
      threads: await countKeySpellings(groupChatThread),
      queue: await countKeySpellings(agentQueueEntry),
      aliases: await countKeySpellings(groupChatThreadAlias),
    },
  }
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

// How many times `deleteGroupChat` will re-read a chat's threads looking for
// ones started while it was tearing the previous batch down. Not a retry count
// -- every pass does real work -- and reached only if threads keep arriving
// faster than they can be drained, which no ordinary use produces.
const DELETE_DRAIN_PASSES = 5

/**
 * Delete a group chat: every thread's session + process first, then the chat
 * row, whose cascade takes the rest of it.
 *
 * Membership-gated through `requireGroupChatMember`, so any member may delete
 * and a missing chat and a non-member get the same single refusal -- the rule
 * every other mutation on this surface already follows. There is no owner or
 * creator concept on a group chat, so there is nothing narrower to gate on.
 *
 * THE ORDER IS `deleteThread`'S RULE, ONE LEVEL UP. A thread row is the only
 * handle anything has on its `sessionKey`, so the session and its agent
 * subprocess come down BEFORE the row does; dropping rows first turns a failed
 * teardown into a live session and a running process that no screen lists and
 * no retry can reach. Deleting the chat would drop every thread row at once by
 * cascade, so that failure mode is the same one multiplied by the thread count
 * -- which is exactly why the teardown loop runs first and completes before
 * the row delete is issued. A teardown that throws leaves the whole chat
 * intact and the delete retryable.
 *
 * `forgetLocalSessionImpl`, the same call `deleteThread` makes, NOT
 * `stopLocalSessionProcessImpl` as `removeMember` makes. The distinction is
 * whether the conversation is meant to survive: a removed agent's threads stay
 * readable, so its sessions are stopped and the durable tabKey->sessionId
 * pointer is kept. Here the chat and everything in it is going away, so
 * forgetting is right and leaving pointers behind would be the bug.
 *
 * IT DRAINS RATHER THAN SNAPSHOTTING, and that is not fussiness. Tearing down
 * a session is an unbounded await -- it reaches a subprocess -- so a thread
 * started while the loop is running (another member on the chat screen, or any
 * path that mints one) lands in a chat that is about to be deleted. Against a
 * list read once at the top, that thread's session is never torn down and its
 * row is removed by the cascade a moment later: the stranded process this
 * whole ordering exists to prevent, arrived at from the other side. So the
 * thread list is re-read after every pass and anything new is torn down too,
 * until a pass finds nothing left. `forgetLocalSessionImpl` is safe to call for
 * a key it has no entry for, so a re-read that returns a thread already handled
 * costs a map lookup.
 *
 * A chat being written to faster than it can be drained refuses rather than
 * deleting: `DELETE_DRAIN_PASSES` is generous enough that ordinary concurrency
 * never reaches it, and the alternative at the bound is to delete rows whose
 * sessions are still up, which is the one outcome this function exists to
 * avoid. A refusal is retryable; a stranded agent process is not.
 *
 * DRAINING ALONE IS NOT ENOUGH, and the gap is the reason for the sweep after
 * the cascade below. It covers a thread that did not exist when the loop
 * started; it cannot cover an existing thread whose session is re-created
 * after that thread was already torn down, because `tornDown` deliberately
 * filters that key out of every later pass. Read the sweep for the rest.
 *
 * WHAT A FAILED TEARDOWN COSTS, stated plainly because the rows and the
 * conversations do not fare the same. If a teardown throws mid-loop the chat
 * and every row in it survive and the delete can be retried -- but the threads
 * already processed have had their durable tabKey->sessionId pointers dropped,
 * so those conversations are gone and their threads reopen empty. That is
 * acceptable only because the caller asked to destroy all of it; it is NOT a
 * clean rollback, and reading it as one would be wrong.
 *
 * Two ways this differs from calling `deleteThread` in a loop, both deliberate:
 * it re-checks membership once rather than once per thread, and it lets the
 * cascade drop the thread rows instead of deleting them one at a time. The
 * second is the one that matters -- rows going with the chat in a single
 * statement means there is no window where some threads are gone and the chat
 * they belonged to is still listed.
 *
 * Nothing else needs cleaning up by hand. Members, pins, threads, slug aliases
 * and thread aliases are all `onDelete: 'cascade'` on the chat, and a thread's
 * artifacts and aliases cascade on the thread -- verified in schema.ts and in
 * the migrations, not assumed. Artifact content is an inline `text()` column
 * with no file or object storage behind it, so the cascade is the whole of it.
 */
export async function deleteGroupChat(request: Request, groupChatId: string): Promise<void> {
  await requireGroupChatMember(request, groupChatId)
  const tornDown = new Set<string>()
  for (let pass = 0; ; pass++) {
    const threads = await db
      .select({ sessionKey: groupChatThread.sessionKey })
      .from(groupChatThread)
      .where(eq(groupChatThread.groupChatId, groupChatId))
    const pending = threads.filter((thread) => !tornDown.has(thread.sessionKey))
    if (pending.length === 0) {
      break
    }
    if (pass >= DELETE_DRAIN_PASSES) {
      throw new Error('Threads kept being started in this group chat while it was being deleted — try again')
    }
    for (const thread of pending) {
      await forgetLocalSessionImpl(thread.sessionKey)
      tornDown.add(thread.sessionKey)
    }
  }
  await db.delete(groupChat).where(eq(groupChat.id, groupChatId))
  // The sweep. Draining handles a thread that did not exist yet; this handles
  // an EXISTING thread whose session was re-created after its teardown -- the
  // likelier of the two, since a chat worth deleting may still have agents
  // posting into it. Every delivery path resolves the thread row first and the
  // rows live until the cascade above, so between a key's teardown and that
  // cascade a delivery re-opens its session through resolveOrCreateSession's
  // create branch. The drain cannot catch it: `tornDown` filters that key out
  // of every later pass by design.
  //
  // Post-cascade is what makes this final rather than another racing pass --
  // the row is gone, so no delivery path can resolve the thread and re-create
  // anything after it. Each call is a map lookup that finds nothing unless the
  // race actually fired.
  //
  // Under the same per-key lock deliveries take, so a delivery already inside
  // its critical section finishes before the key is swept rather than being
  // interleaved with it.
  //
  // ONE WINDOW REMAINS, and it is not closed here: a delivery that read its
  // row before the cascade and enters the lock after the sweep will re-create
  // a session for a thread that no longer exists. That is the same single
  // await `deleteThread` has had all along, it needs a change to the delivery
  // paths rather than to this one, and it is left open deliberately rather
  // than papered over -- this comment is the record that it is known.
  for (const sessionKey of tornDown) {
    await withSessionKeyLock(sessionKey, () => forgetLocalSessionImpl(sessionKey))
  }
}

export type MemberPrincipal =
  | { kind: 'user'; userId: string }
  | { kind: 'agent'; agentNodeId: string }
  | { kind: 'system'; systemId: string }

/**
 * Add a member. Any existing member may add another — phase 1's answer to
 * "who may manage membership", not otherwise specified and not
 * worth a role system nobody asked for; a narrower rule is a later, additive
 * change if one is ever needed.
 *
 * An agent principal is validated against `listAgentNodesImpl()` — the plain
 * implementation in agents-impl.ts, the same source the agent pickers are
 * populated from — so a group chat cannot be given a member that is
 * not, in fact, an agent node that exists. Imported from agents-impl.ts
 * rather than agents.ts for two separate reasons: it avoids nesting one
 * `createServerFn` inside another's handler, and agents.ts must keep no
 * plain exports at all or its native-dependent import tail reaches the
 * client bundle (see that file's header). A user principal is validated
 * against the `user` table for the same reason: existence, not just shape.
 *
 * A system principal is the explicit grant that lets an automated pipeline —
 * a schedule's script, the forge webhook — deliver into this chat's threads.
 * Validated against the identities this application can actually stamp a
 * message with (`SYSTEM_SENDER_IDS`, derived from the author map itself), on
 * the same principle as the two above: existence, not shape. Checking the
 * `system.` namespace instead would accept `system.scripts` — a row that
 * authorizes nothing, reads as granted in the members list, and leaves the
 * pipeline failing with the message that asked for it. The row IS the
 * authorization: per-chat, listable, revocable, and checked by the same
 * membership lookup as everyone else.
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

  if (principal.kind === 'system') {
    if (!isKnownSystemSender(principal.systemId)) {
      throw new Error(`No such system sender: "${principal.systemId}"`)
    }
    await db
      .insert(groupChatMember)
      .values({ groupChatId, principalType: 'system', systemId: principal.systemId })
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

/** Joined, or refused — and every refusal here carries the one collapsed code. */
export type JoinGroupChatResult = { ok: true } | { ok: false; code: GroupChatAccessFailure }

/**
 * Add YOURSELF to the chat a space addresses by its own slug.
 *
 * The rule: being in the space is what confers the
 * right to enter that space's chat, so a non-member opening the space's
 * embedded chat gets a Join control instead of a refusal. See
 * `resolveGroupChatBySlug` above for why the scope is "the slug names a
 * space" and what is still open beyond it.
 *
 * NOT A BRANCH INSIDE `addMember`. That one requires the caller to be a member
 * already — any member may add another — which is exactly what this caller is
 * not. Two different rules, two functions, so neither can be widened by an
 * edit meant for the other.
 *
 * The scope gate is re-asked here rather than trusted from the screen: a
 * `createServerFn` is a callable endpoint in its own right, so a slug arriving
 * with the request proves nothing about which surface sent it.
 */
export async function joinSpaceGroupChat(request: Request, slug: string): Promise<JoinGroupChatResult> {
  const sessionUser = await requireSignedInUser(request)
  const chatSlug = slugify(slug)
  if (!chatSlug) {
    return { ok: false, code: 'not-found' }
  }
  const row = await chatRowBySlug(chatSlug)
  if (!row) {
    // Nothing to join. A slug carrying no chat is the create flow's case, and
    // minting one here would take the address on the caller's behalf.
    return { ok: false, code: 'not-found' }
  }
  if (await isUserMember(row.id, sessionUser.id)) {
    // Already in. This reports a state rather than an event, so a second click
    // — or a Join raced against being added — answers the same as the first.
    return { ok: true }
  }
  if (!(await slugAddressesASpace(chatSlug))) {
    return { ok: false, code: 'not-found' }
  }
  await db
    .insert(groupChatMember)
    .values({ groupChatId: row.id, principalType: 'user', userId: sessionUser.id })
    .onConflictDoNothing()
  return { ok: true }
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

  if (principal.kind === 'system') {
    // Revoking the grant. Nothing to tear down: a system sender holds no
    // sessions and owns no threads — the row was only ever its permission to
    // deliver, and deleting the row ends exactly that.
    await db
      .delete(groupChatMember)
      .where(
        and(
          eq(groupChatMember.groupChatId, groupChatId),
          eq(groupChatMember.principalType, 'system'),
          eq(groupChatMember.systemId, principal.systemId),
        ),
      )
    return
  }

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

/** Members of a group chat — users, agents and system senders together. Membership-gated. */
export async function listMembers(
  request: Request,
  groupChatId: string,
): Promise<
  Array<{
    id: string
    principalType: string
    userId: string | null
    agentNodeId: string | null
    systemId: string | null
  }>
> {
  await requireGroupChatMember(request, groupChatId)
  return db
    .select({
      id: groupChatMember.id,
      principalType: groupChatMember.principalType,
      userId: groupChatMember.userId,
      agentNodeId: groupChatMember.agentNodeId,
      systemId: groupChatMember.systemId,
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
 * STANDING CONTEXT: everything a thread's agent should be holding — the
 * agent's own instruction nodes, plus the group chat it is in: the topic it
 * exists for, and the notes pinned to it.
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
export function standingSignature(topic: string, pinTexts: string[], instructionTexts: string[] = []): string {
  const parts = [topic, ...pinTexts, ...instructionTexts]
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

/**
 * The agent's OWN standing instructions — the `agent-instruction` nodes wired
 * into its `instructions-in` handle, the same ones a send-message node
 * delivers (send-message-helpers.ts).
 *
 * A thread is an ordinary session with that agent, so it gets them too. Until
 * this existed, a group-chat thread was the ONE surface that dropped them:
 * standing context here was assembled from the chat alone, so an agent whose
 * whole identity is configured on instruction nodes woke up in a thread
 * without any of it, and the more work moved into threads the more often that
 * happened.
 *
 * Read from the same `listAgentNodesImpl()` the callers around here already
 * use to validate and name an agent — `AgentNodeRef` has carried
 * `.instructions` all along; nothing here reaches for anything new.
 */
async function agentInstructionsFor(agentNodeId: string): Promise<string[]> {
  const nodes = await listAgentNodesImpl()
  const agent = nodes.find((n) => n.nodeId === agentNodeId)
  return (agent?.instructions ?? []).map((i) => i.instruction.trim()).filter((text) => text.length > 0)
}

/**
 * Assemble one THREAD's standing context: the chat's topic and pins, plus the
 * thread agent's own instruction nodes.
 *
 * Thread-scoped rather than chat-scoped, because the agent is a property of
 * the thread — two threads in one chat with different agents hold different
 * standing context, and assembling it per chat is what made that impossible
 * to express.
 *
 * The agent's instructions lead and the pins follow: the agent's own standing
 * guidance is what it is, and the chat's pins are the narrower thing layered
 * on top of it.
 */
async function standingContextForThread(groupChatId: string, agentNodeId: string): Promise<StandingContext | null> {
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
  const agentInstructions = await agentInstructionsFor(agentNodeId)
  return {
    jobContext: `Group chat topic: ${chat.topic}`,
    // Pins ride the envelope's existing instruction axis rather than a new
    // one: that axis already means standing guidance rather than a request,
    // which is what a pin is. The agent's own instructions ride the same axis
    // for the same reason, and are the same blocks a 1:1 chat sends.
    instructions: [...agentInstructions, ...(reminder ? [reminder] : [])],
    // The agent's instructions are IN the signature, so editing an
    // instruction node re-delivers on this thread's next message exactly as
    // editing a pin does. That also means every existing thread's recorded
    // signature no longer matches, which is correct: none of them were ever
    // told the instructions, and one re-delivery is how they find out.
    signature: standingSignature(chat.topic, pins, agentInstructions),
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
/**
 * THE ONE PLACE a session key is turned into a thread. Live first, then an
 * address a rename freed -- the rule every lookup here obeys, written once so a
 * caller cannot accidentally get the live half of it and not the other.
 *
 * Every site that resolves a key needs the alias half, not just the ones a
 * person reaches. A key can be captured in a closure and resolved a whole turn
 * later (see `requestCompact`), by which time a rename may have retired
 * it; a lookup without the fallback finds nothing and its caller carries on
 * with whatever "not a group-chat thread" means to it -- which, for the
 * compaction path, is dropping the history and then not restoring the topic,
 * pins and instructions that were the point of compacting.
 *
 * The alias row carries `threadId` directly, so this is one indexed read per
 * half and no join.
 */
async function threadIdForSessionKey(sessionKey: string): Promise<string | null> {
  const [live] = await db
    .select({ id: groupChatThread.id })
    .from(groupChatThread)
    .where(eq(groupChatThread.sessionKey, sessionKey))
    .limit(1)
  if (live) {
    return live.id
  }
  const [aliased] = await db
    .select({ threadId: groupChatThreadAlias.threadId })
    .from(groupChatThreadAlias)
    .where(eq(groupChatThreadAlias.sessionKey, sessionKey))
    .limit(1)
  return aliased?.threadId ?? null
}

export async function groupChatStandingContext(sessionKey: string): Promise<StandingContext | null> {
  const threadId = await threadIdForSessionKey(sessionKey)
  if (!threadId) {
    return null
  }
  const [row] = await db
    .select({ groupChatId: groupChatThread.groupChatId, agentNodeId: groupChatThread.agentNodeId })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  return row ? standingContextForThread(row.groupChatId, row.agentNodeId) : null
}

/**
 * Wakes an offline thread's session from its stored state, or null when the
 * key is not a group-chat thread's — the offline-compaction counterpart to
 * `groupChatStandingContext` above, registered the same way (see
 * server/startup.ts) so `requestCompact` can resume a thread
 * without stream.ts importing group-chat code.
 *
 * The same `resolveOrCreateSession` call `deliverIntoThread` makes for an
 * ordinary message — a thread that has gone offline still has its durable
 * session pointer, so this resumes it rather than creating a fresh one.
 */
export async function groupChatWakeSession(sessionKey: string): Promise<{ sessionId: string } | null> {
  const threadId = await threadIdForSessionKey(sessionKey)
  if (!threadId) {
    return null
  }
  const [row] = await db
    .select({ agentNodeId: groupChatThread.agentNodeId, sessionKey: groupChatThread.sessionKey })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!row) {
    return null
  }
  // The thread's CURRENT key, not the one asked with. Reached through an alias,
  // those differ -- and opening under a retired address would create exactly the
  // second session this whole change exists to prevent.
  const opened = await resolveOrCreateSession(row.sessionKey, {
    agentNodeId: row.agentNodeId,
    tabKey: row.sessionKey,
  })
  return { sessionId: opened.sessionId }
}

// The key's shape — prefixes, mint and parse — lives in _shared/session-key.ts,
// dependency-free (the same reason access-error.ts is there), so a caller that
// only needs to READ a key, like the idle-session reaper, does not import this
// module's database tail. Minting and moving keys stays in here.

/**
 * The readable address handed out for a stored key: no prefix, dots between
 * the segments.
 *
 * DOTS ARE WHAT WE STORE AND WHAT WE EMIT.
 *
 * Switching the emitted form was safe because no tool schema promises one:
 * they all declare a thread reference opaque, so a caller that stores what it
 * is given and hands it back keeps working whichever form it received.
 *
 * A key without the prefix is returned whole -- a pre-slug key, whose segments
 * are ids rather than slugs and mean nothing taken apart. Handed back, it
 * resolves as the exact stored key.
 */
export function threadRefFromSessionKey(sessionKey: string): string {
  return sessionKey.startsWith(SESSION_KEY_PREFIX) ? sessionKey.slice(SESSION_KEY_PREFIX.length) : sessionKey
}

// The compaction machinery addresses a session by its STORED key, and its ack
// and status carry that key back. Every surface of this module emits the
// public dot-form reference instead — a raw stored sessionKey must never
// leave through a response a person or an agent reads, which is exactly how
// the storage spelling once leaked onto a screen. These re-shapes replace the
// key with the ref at the boundary, so the callers below cannot forget to.

export type ThreadCompactAck = Omit<CompactAck, 'sessionKey'> & { thread: string }
export type ThreadCompactStatus = Omit<CompactStatus, 'sessionKey' | 'result'> & {
  thread: string
  result?: Omit<CompactResult, 'sessionKey'> & { thread: string }
}

function toThreadCompactAck(ack: CompactAck): ThreadCompactAck {
  const { sessionKey, ...rest } = ack
  return { ...rest, thread: threadRefFromSessionKey(sessionKey) }
}

function toThreadCompactStatus(status: CompactStatus): ThreadCompactStatus {
  const { sessionKey, result, ...rest } = status
  const view: ThreadCompactStatus = { ...rest, thread: threadRefFromSessionKey(sessionKey) }
  if (result) {
    const { sessionKey: resultKey, ...resultRest } = result
    view.result = { ...resultRest, thread: threadRefFromSessionKey(resultKey) }
  }
  return view
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

/**
 * Refuse if any key about to be written is already some other thread's.
 *
 * THE SCOPED SLUG CHECKS ARE NOT THIS CHECK. `(chat, agent, slug)` is scoped;
 * `GroupChatThread_sessionKey_key` is global, and the two can disagree: a key's
 * agent segment is `slugify(agent node name)`, and nothing makes node names
 * unique, so two agent nodes sharing a name mint the same segment and a rename
 * whose scoped check passed can still target a key another thread holds.
 *
 * IT HAS TO RUN BEFORE STAGING, not merely before the write. Staging copies the
 * durable session pointer and the config options onto the destination key
 * unconditionally; if the transaction then loses at the unique index and rolls
 * back, nothing undoes that copy, and the thread that held the key is left
 * resolving to somebody else's ACP session with every gate passed and nothing
 * logged. The transaction protects the rows, not the settings store, so this is
 * what keeps the staging step's "the destination is unoccupied" premise true.
 */
async function requireSessionKeysFree(keys: string[], exceptThreadIds: string[]): Promise<void> {
  if (keys.length === 0) {
    return
  }
  const rows = await db
    .select({ id: groupChatThread.id, sessionKey: groupChatThread.sessionKey })
    .from(groupChatThread)
    .where(inArray(groupChatThread.sessionKey, keys))
  const clash = rows.find((row) => !exceptThreadIds.includes(row.id))
  if (clash) {
    throw new GroupChatAccessError('slug-taken', `Another thread already answers to "${clash.sessionKey}"`)
  }
}

export interface StartThreadResult {
  thread: GroupChatThreadSummary
  sessionId: string
}

/**
 * The address a new thread will answer to: its slug within (chat, agent), and
 * the session key built from it.
 *
 * ONE MINT FOR EVERY NEW THREAD, whoever is asking — a person starting one, an
 * agent starting one for a colleague, a fork branching an existing
 * conversation. They differ in what they then DO with the address; they must
 * not differ in how it is chosen, because the key is the durable address of a
 * conversation and two ways of picking it is two ways of picking it wrong.
 *
 * A NAMED thread takes its slug from the title; an ad-hoc one gets a short
 * hash. Most threads are ad-hoc, so the hash is the default rather than a
 * fallback for a missing title.
 *
 * The collision check comes BEFORE the key is minted, so a refused thread
 * never resolves an agent or reads a chat it is not going to use. Scoped to
 * (chat, agent) because that is what the key path is — only a named thread can
 * reach it in practice, since two hashes colliding is not something to write
 * copy for, and it refuses identically if it happens.
 */
async function mintThreadAddress(
  groupChatId: string,
  agentNodeId: string,
  title?: string,
): Promise<{ threadSlug: string; sessionKey: string }> {
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
  return { threadSlug, sessionKey: mintSessionKey(chatRow.slug, slugify(agentName) || agentNodeId, threadSlug) }
}

/**
 * Start a thread, and send its first message in the same call when there is
 * one. Both the calling user and the named agent must be members; either
 * failing refuses the whole call rather than creating a thread that then
 * cannot be used.
 *
 * AN EMPTY `firstMessage` MINTS THE THREAD AND SENDS NOTHING. This note used
 * to say the opposite — that the system had no notion of an empty thread,
 * because a thread WAS its opening message and nothing ever left a session
 * open with nothing said. One thing changed it: a harness advertises the
 * settings a session can be configured with — its models, its reasoning
 * efforts, its permission modes — only for a session that EXISTS, so there was
 * nowhere to choose any of them before the first message. Minting the thread
 * is what makes them reachable, and the composer offering that press says so
 * on the button. See `createThread` for what is skipped and what is not.
 *
 * The topic enters the agent's context exactly the way a job's context does
 * (see message-envelope.ts), and by the same once-on-change rule every later
 * message answers to: a thread minted here has been told nothing yet, so its
 * standing context rides its first message — this call's, or a later one's if
 * this call carried none — and is never repeated after it. That rule lives in
 * `deliverIntoThread`, which is also what stamps the message with who sent it
 * and when.
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
  return createThread(groupChatId, agentNodeId, firstMessage, {
    title: opts?.title,
    createdByUserId: userId,
    // A person, not an agent. The composer is the only way here.
    createdByAgentNodeId: null,
    // The reader's own handle, resolved from the session already required
    // above — the same stamp `sendMessageInThread` makes for every message
    // after this one, from the same source. Resolved BEFORE anything is
    // minted: an account with no handle cannot be stamped on a message, and a
    // thread whose opening message cannot be attributed is not one to create
    // half of.
    sender: await authorForPerson(userId),
  })
}

/**
 * Mint a thread and deliver its first message, where it has one. THE ONLY
 * PLACE A THREAD IS CREATED — `startThread` and `startThreadAsAgent` are gates
 * in front of this, not two implementations of it.
 *
 * It has NO gate of its own, which is the point and the hazard: every caller
 * must have already established that whoever is asking may create a thread
 * here, and that `agentNodeId` is a member. Both existing callers do so
 * immediately above their call, and a third must too. Kept private for that
 * reason — an ungated creation path is not something to export.
 *
 * `createdByUserId` is provenance, not ownership (see the column's own note in
 * schema.ts), so null is a legitimate value and means "no user did this" —
 * which is exactly true of a thread an agent started.
 */
async function createThread(
  groupChatId: string,
  agentNodeId: string,
  firstMessage: string,
  // Who started it, recorded as EXACTLY ONE of the two. Both are required
  // rather than optional so a new call site has to say which it is: the agent
  // one is a permission input for thread deletion, and a caller that forgot to
  // pass it would silently create a thread its own creator cannot delete.
  opts: {
    title?: string
    createdByUserId: string | null
    createdByAgentNodeId: string | null
    sender: string
  },
): Promise<StartThreadResult> {
  // A GATE, not the copy that gets delivered. This refuses a thread for a chat
  // that is not there before anything is minted; what the first message
  // actually carries is read again at delivery, from the one place that reads
  // it for every message (see deliverIntoThread).
  const standing = await standingContextForThread(groupChatId, agentNodeId)
  if (!standing) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }

  const title = opts.title?.trim() || undefined
  const { threadSlug, sessionKey } = await mintThreadAddress(groupChatId, agentNodeId, title)
  // A LIVE THREAD OUTRANKS AN ALIAS. Either address this thread is about to
  // answer to may still be freeing itself for a thread renamed away from it,
  // and a real binding takes it outright. Leaving both would give one address
  // two answers -- the one wrong-recipient failure a membership gate cannot
  // catch, since a sender able to write the address is a member of both.
  //
  // Evicting and binding in ONE transaction, because the eviction is only
  // justified by the binding that replaces it: a failed insert -- the unique
  // index on `sessionKey` is one way to lose -- would otherwise leave two
  // addresses freed with nothing live in their place, resolving nowhere.
  const [thread] = await db.transaction(async (tx) => {
    await tx
      .delete(groupChatThreadAlias)
      .where(
        and(
          eq(groupChatThreadAlias.groupChatId, groupChatId),
          eq(groupChatThreadAlias.agentNodeId, agentNodeId),
          eq(groupChatThreadAlias.slug, threadSlug),
        ),
      )
    await tx.delete(groupChatThreadAlias).where(eq(groupChatThreadAlias.sessionKey, sessionKey))
    // `deliveredContextSignature` is deliberately left NULL here and written
    // only once the prompt below has been accepted -- now literally the same
    // code as `sendMessageInThread` runs, not merely the same rule, since the
    // opening message goes out through `deliverIntoThread` too. Recording it
    // at insert time would mark the context delivered even when the first
    // prompt throws (agent node down, gateway hiccup), leaving a thread whose
    // agent was never told its topic or pins and will not be told until
    // something else changes. Left NULL, a retry re-delivers through the
    // once-on-change path without needing a second mechanism.
    return tx
      .insert(groupChatThread)
      .values({
        groupChatId,
        agentNodeId,
        sessionKey,
        slug: threadSlug,
        title,
        createdByUserId: opts.createdByUserId,
        createdByAgentNodeId: opts.createdByAgentNodeId,
      })
      .returning(threadSummaryColumns)
  })
  if (!thread) {
    throw new Error('The thread could not be created')
  }

  // A THREAD MINTED WITH NOTHING TO SAY YET.
  //
  // The session is opened and left waiting. That is the whole point of the
  // press: a harness advertises what a session can be configured with -- which
  // models, which reasoning efforts, which permission modes -- only for a
  // session that exists, so a person who wants to choose before writing has
  // nowhere to choose until one does.
  //
  // The SAME open `deliverIntoThread` makes below, not a second way to start a
  // session for a thread. What is skipped is the prompt, and only the prompt.
  //
  // The standing context needs no handling here: the row went in with a NULL
  // signature, so the once-on-change rule reads it as undelivered and the
  // first real message carries it -- exactly as it would have carried it here.
  //
  // Reachable from `startThread` alone. `startThreadAsAgent` refuses an empty
  // message before it ever gets here, and deliberately: an agent starting a
  // thread for a colleague has something to say, and a thread nobody was told
  // about is not a delegation.
  if (!firstMessage.trim()) {
    const opened = await resolveOrCreateSession(sessionKey, { agentNodeId, tabKey: sessionKey })
    return { thread, sessionId: opened.sessionId }
  }

  // THE FIRST MESSAGE LEAVES BY THE SAME DOOR AS EVERY LATER ONE.
  //
  // It used to be delivered here by hand, with `origin: { kind: 'system' }` —
  // the origin an application uses for prompts it issues on its own behalf, so
  // the message travelled with no author and no send time. But a thread's
  // opening message is somebody's words, and the tag those two facts live in is
  // written at delivery from the origin (see agent-client's queue-tags): stating
  // the wrong one loses them for good, because that tag is the only place a
  // sender and a send time exist once a transcript is replayed. Every thread's
  // first bubble was anonymous and undated, on screen and permanently.
  //
  // Handing the message to `deliverIntoThread` fixes that by construction
  // rather than by restating the origin here, and keeps the rest of what this
  // used to do: the standing context still rides this message, because the row
  // was inserted with a NULL signature and the once-on-change rule therefore
  // reads it as undelivered, and the signature is still recorded only once the
  // prompt has been accepted.
  const { sessionId } = await deliverIntoThread(
    {
      id: thread.id,
      groupChatId,
      agentNodeId,
      sessionKey,
      // Just inserted, deliberately NULL — see the transaction above.
      deliveredContextSignature: null,
      // Carried through as it went in, so this literal stays a faithful copy of
      // the row rather than a partial one that happens to satisfy delivery.
      createdByAgentNodeId: opts.createdByAgentNodeId,
    },
    firstMessage,
    { queue: 'wait', sender: opts.sender },
  )

  return { thread, sessionId }
}

/**
 * Fork a thread at one of its messages into a NEW thread of the same chat and
 * agent, whose session carries the conversation UP TO that message and whose
 * composer opens with the forked message waiting as a draft. Nothing is sent:
 * the reader edits the prefill and sends it themselves, which is the whole
 * difference from an edit commit (that rewinds THIS conversation in place and
 * re-runs it immediately).
 *
 * The session is the engine's `session/fork` — the agent's own word about
 * whether it can fork at all decides, the same `canFork` gate the edit flow
 * answers to. The new thread inherits the source's standing-context signature
 * rather than re-delivering topic and pins: the forked session already carries
 * the conversation they were once attached to.
 *
 * The draft arrives from the browser because a draft is composer content — the
 * one thing a browser may state. Everything else about the fork is resolved
 * here from the delivered turn.
 */
export async function forkThreadAt(
  request: Request,
  threadId: string,
  eventIndex: number,
  draft: string,
): Promise<GroupChatThreadSummary> {
  const [source] = await db
    .select({
      groupChatId: groupChatThread.groupChatId,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
      deliveredContextSignature: groupChatThread.deliveredContextSignature,
    })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!source) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  const { userId } = await requireGroupChatMember(request, source.groupChatId)

  // The minting createThread does, because it IS that function — a fork is a
  // thread of the same chat and agent, and it has to be addressable on the
  // same terms. It was a second copy of these four steps; the copy had already
  // drifted (it checked the collision after minting the key rather than
  // before), and the next divergence would have been silent.
  const { threadSlug, sessionKey } = await mintThreadAddress(source.groupChatId, source.agentNodeId)

  // The source session must be live before anything can fork it: opening is
  // reattach-or-create, and a thread whose session carries no such turn (never
  // opened, or a stale client) refuses below through the missing turn.
  const opened = await ensureLocalSessionImpl({ agentNodeId: source.agentNodeId, tabKey: source.sessionKey })
  const forked = await forkTurnLocalImpl({
    sessionId: opened.sessionId,
    eventIndex,
    sessionKey,
  })
  if (!forked) {
    // NOT the collapsed refusal. The thread is right there on the reader's
    // screen and they are plainly entitled to it; what could not be found is
    // the message, at the position this page named it by. Answering "this
    // group chat is not available" described the one thing that was not the
    // problem. See the code's own comment in _shared/access-error.ts.
    throw new GroupChatAccessError(
      'turn-not-found',
      'That message is no longer where this page thinks it is — reload the chat and try again.',
    )
  }

  // Row last, on purpose: a failure above leaves nothing behind, while a
  // failure here leaves a forked session no row addresses — the same shape of
  // orphan an edit fork nobody keeps becomes, unreachable and harmless. The
  // trim the fork performed is in the engine either way.
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: source.groupChatId,
      agentNodeId: source.agentNodeId,
      sessionKey,
      slug: threadSlug,
      title: null,
      createdByUserId: userId,
      draft: draft.trim() || null,
      deliveredContextSignature: source.deliveredContextSignature,
    })
    .returning(threadSummaryColumns)
  if (!thread) {
    throw new Error('The forked thread could not be created')
  }
  return thread
}

/**
 * Open (or reattach to) a thread's live session, addressed by THREAD ID.
 *
 * A THREAD'S ID NEVER MOVES; ITS SESSION KEY DOES. A reader's screen holds the
 * key its last load handed it, and a rename between then and now retires it --
 * so a surface opening by key would not fail, it would MINT a fresh, empty
 * session under an address nothing resolves, and show an empty chat where the
 * conversation was. Renaming the same thread in another tab is enough: the
 * renamer's own screen reloads, a second reader's does not.
 *
 * So the key is read HERE, from the row, at the moment the session is opened,
 * and no stale key ever reaches the session layer -- which keeps taking a plain
 * tab key and knowing nothing about any of this.
 *
 * Membership-gated exactly like `getThread`, with the same single refusal for a
 * missing thread and for a non-member: opening a session is reaching into the
 * conversation, not reading a row.
 */
export async function openThreadSession(request: Request, threadId: string): Promise<OpenedSession> {
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
  return ensureLocalSessionImpl({ agentNodeId: row.agentNodeId, tabKey: row.sessionKey })
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
  opts: { front?: boolean; queue: QueueMode; attachments?: readonly string[] },
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
  // The reader's own handle, resolved from the session that is already required
  // above — the surface knows who is speaking, so it says so rather than
  // pushing the question up to its caller. The HANDLE and not the display name:
  // the tag survives a session reload and a rename, so it has to carry the part
  // that does not move.
  await deliverIntoThread(row, text, { ...opts, sender: await authorForPerson(sessionUser.id) })
}

/** The columns every delivery path needs off a thread row. */
export interface ThreadDeliveryTarget {
  id: string
  groupChatId: string
  agentNodeId: string
  sessionKey: string
  deliveredContextSignature: string | null
  createdByAgentNodeId: string | null
}

const threadDeliveryColumns = {
  id: groupChatThread.id,
  groupChatId: groupChatThread.groupChatId,
  agentNodeId: groupChatThread.agentNodeId,
  sessionKey: groupChatThread.sessionKey,
  deliveredContextSignature: groupChatThread.deliveredContextSignature,
  createdByAgentNodeId: groupChatThread.createdByAgentNodeId,
}

/**
 * THE ONE DELIVERY PATH INTO A THREAD. Every caller — a person in the browser,
 * an agent through the tool surface, a send-message node's graph-driven send
 * (via deliverThreadFromNode), and the thread's own opening message (via
 * createThread) — reaches an agent through this function and nothing else.
 *
 * The opening message was the last one that did not, and the cost of the
 * exception is what the rest of this comment warns about: it delivered as a
 * `system` prompt, so it arrived with no author and no send time, and no test
 * noticed because the path it diverged from was a copy rather than this one.
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
 *
 * The session it delivered into comes back with it, because a creating caller
 * has to hand that id to the screen that will open the conversation. It is the
 * session this thread's key resolves to, not a new one.
 */
async function deliverIntoThread(
  row: ThreadDeliveryTarget,
  text: string,
  opts: { front?: boolean; queue: QueueMode; sender: string; attachments?: readonly string[] },
): Promise<{ queued: boolean; sessionId: string }> {
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
    tabKey: row.sessionKey,
  })
  // Deliberately blind to whether the instance is draining its queues at all.
  // That is a property of the instance, not of this message, and a result that
  // moved with it would let any sender infer the instance's delivery state
  // from an ordinary send — which is precisely what a silently held queue must
  // not announce. So this reports what it would report with delivery flowing:
  // whether a turn was already running when the message arrived.
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
  const standing = await standingContextForThread(row.groupChatId, row.agentNodeId)
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
  await promptLocalImpl({
    sessionId: opened.sessionId,
    text: payload,
    front: opts.front,
    queue: opts.queue,
    origin: { kind: 'message', sender: opts.sender },
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
  })
  // Recorded only after the message carrying it has been accepted: a send that
  // threw would otherwise mark context delivered that never went anywhere, and
  // the next send would skip it.
  if (changed && standing) {
    await db
      .update(groupChatThread)
      .set({ deliveredContextSignature: standing.signature })
      .where(eq(groupChatThread.id, row.id))
  }
  return { queued, sessionId: opened.sessionId }
}

/**
 * Compact a thread's session and, on success, re-deliver its CURRENT standing
 * context (topic + pins) rather than whatever was true when the thread last
 * heard from it — see `groupChatStandingContext`'s header for why that is the
 * whole point.
 *
 * `requestCompact` resolves standing context through the registered
 * `StandingContextResolver`s: the resolver registered at server boot (see
 * server/startup.ts) is the only thing that can claim this sessionKey,
 * exactly as it is the only thing that can claim it at restore time inside
 * performCompact.
 *
 * Membership-gated the same way `sendMessageInThread` is, including the
 * agent-still-a-member check: compaction sends `/compact` and a restore
 * prompt into the live session same as an ordinary send does, so a removed
 * agent's threads are refused here for the same reason they are refused a
 * send.
 */
export async function compactThread(request: Request, threadId: string): Promise<ThreadCompactAck> {
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
  return toThreadCompactAck(await requestCompact(row.sessionKey))
}

/** The compact job's status for a thread — same membership gate as `compactThread`. */
export async function threadCompactStatus(request: Request, threadId: string): Promise<ThreadCompactStatus> {
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
  return toThreadCompactStatus(getCompactStatus(row.sessionKey))
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
  await tearDownAndDeleteThread(threadId, row.sessionKey)
}

/**
 * THE deletion, shared by every gate above it.
 *
 * Extracted so the agent-facing `deleteThreadAsAgent` performs the same one
 * rather than a second copy of it: the ORDER below is a correctness rule, and a
 * rule that exists twice is a rule that will exist in two versions. The gates
 * differ — a signed-in member, or an agent that owns the thread — and nothing
 * else may.
 *
 * Tear down the session + its process via the shared path the sidebar uses,
 * and do it BEFORE dropping the row. The row is the only handle anything has
 * on this sessionKey, so deleting it first turns a failed teardown into a
 * live session and agent subprocess that no screen lists and no retry can
 * reach. This way round, a failed teardown leaves the thread intact and the
 * delete retryable, and a failed row delete leaves only a torn-down thread
 * that reopens onto a fresh session via `ensureLocalSessionImpl`.
 */
async function tearDownAndDeleteThread(threadId: string, sessionKey: string): Promise<void> {
  await forgetLocalSessionImpl(sessionKey)
  await db.delete(groupChatThread).where(eq(groupChatThread.id, threadId))
}

/** Why a thread this agent can see was not deleted. */
export type DeleteThreadRefusal = 'not-owned' | 'turn-in-progress'

export type DeleteThreadAsAgentResult = { deleted: true } | { deleted: false; refused: DeleteThreadRefusal }

/**
 * Delete a thread as an agent — the tool-surface counterpart to `deleteThread`.
 * Same deletion (literally, see `tearDownAndDeleteThread`), two extra gates.
 *
 * **Membership first, and it refuses exactly as its siblings do.** A thread in
 * a chat this agent is not in, and a reference that resolves to nothing, both
 * come back as the same `not-found` — so the tool cannot be used to discover
 * that a thread exists somewhere the caller cannot see.
 *
 * **Then ownership, which is where this differs from every other thread tool.**
 * The others act on any thread of a chat the agent is in, because sending,
 * compacting and reading are recoverable. Deletion is not: it ends a session
 * and kills a process, and the transcript goes with it. So being a member of
 * the chat is not enough — the caller must be the agent the thread is
 * ADDRESSED TO, or the agent that STARTED it. That is the worktree rule ("you
 * remove your own"), and it is what keeps a mistyped reference from taking a
 * colleague's live work instead of failing.
 *
 * A refusal here is deliberately DISTINGUISHABLE from the not-found above, and
 * that is not a leak: the caller has already been shown this thread by
 * `group_chat_list`, so naming it back tells them nothing they did not have.
 *
 * **Then a running turn, which is refused rather than killed.** Deleting
 * mid-turn would destroy work an agent is in the middle of, and the caller
 * cannot see that from a listing. Refusing is recoverable — wait and retry —
 * where deleting is not.
 *
 * Returns rather than throws for those two, because they are ordinary answers
 * the caller can act on, and because a result the tests can assert on beats a
 * thrown message they would have to match by string.
 */
export async function deleteThreadAsAgent(agent: AgentRef, threadRef: string): Promise<DeleteThreadAsAgentResult> {
  const agentNodeId = await requireAgentNode(agent)
  const row = await resolveThreadForAgent(agentNodeId, threadRef)
  const addressedToCaller = row.agentNodeId === agentNodeId
  const startedByCaller = row.createdByAgentNodeId === agentNodeId
  if (!addressedToCaller && !startedByCaller) {
    return { deleted: false, refused: 'not-owned' }
  }
  // Asked of the key, because the key is what a thread has; a session id is an
  // internal handle the caller never sees. A key with no live session answers
  // false, which is the right answer and not a missing one — a turn runs
  // inside a session, so no session is no turn.
  if (hasActiveTurnForKeyImpl(row.sessionKey)) {
    return { deleted: false, refused: 'turn-in-progress' }
  }
  await tearDownAndDeleteThread(row.id, row.sessionKey)
  return { deleted: true }
}

/**
 * Discard a thread's session and open a fresh one in its place -- same
 * thread, same row, empty history. Membership-gated exactly like
 * `deleteThread` (found first, then the same single refusal for a missing
 * thread and a non-member) -- the one difference from `deleteThread` is that
 * the `groupChatThread` row survives, so the thread reopens onto a fresh
 * session via `ensureLocalSessionImpl` the next time it's read, instead of
 * disappearing from the list. `session.clearSession` (use-acp-session.ts)
 * calls the SAME forgetLocalSessionImpl with no check of any kind -- correct
 * there, since a 1:1 chat has no membership concept, but wrong here, where
 * every other mutation on this surface (send, compact, delete) is
 * membership-gated. This is the gate that path was missing.
 */
export async function clearThread(request: Request, threadId: string): Promise<void> {
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
  await forgetLocalSessionImpl(row.sessionKey)
}

/**
 * Rename a thread: its title AND the slug that is the last segment of its
 * session key. Membership-gated like `getThread` -- the same single refusal for
 * a missing thread and for a non-member.
 *
 * Same migration, same four steps, same reasoning as `renameGroupChat` -- read
 * its header for why the order is what it is. What differs is only which
 * addresses move: a thread rename frees BOTH the thread's slug (which an
 * embedded surface names) and its whole session key (which a send names), where
 * a chat rename frees only the key.
 *
 * A THREAD WITH NO SLUG IS GIVEN ONE AND NOTHING IS FREED. Threads created
 * before slugs existed carry ids in their keys, so there is no old slug a
 * reference could have been written against and no key segment to move: title
 * and slug are set, the key stays exactly as it was, and no alias is recorded
 * because no address stopped working.
 */
export async function renameThread(request: Request, threadId: string, title: string): Promise<void> {
  const sessionUser = await requireSignedInUser(request)
  const row = await threadRowForRename(threadId)
  if (!(await isUserMember(row.groupChatId, sessionUser.id))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  await applyThreadRename(row, title)
}

type ThreadRenameRow = Pick<
  typeof groupChatThread.$inferSelect,
  'id' | 'groupChatId' | 'agentNodeId' | 'sessionKey' | 'slug'
>

async function threadRowForRename(threadId: string): Promise<ThreadRenameRow> {
  const [row] = await db
    .select({
      id: groupChatThread.id,
      groupChatId: groupChatThread.groupChatId,
      agentNodeId: groupChatThread.agentNodeId,
      sessionKey: groupChatThread.sessionKey,
      slug: groupChatThread.slug,
    })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
    .limit(1)
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  return row
}

/**
 * The rename itself, with NO gate: `renameThread` and `renameThreadAsAgent`
 * are the gates in front of it, the same split `createThread` has.
 */
async function applyThreadRename(row: ThreadRenameRow, title: string): Promise<void> {
  const threadId = row.id
  const trimmed = title.trim()
  if (!trimmed) {
    throw new Error('A thread needs a title')
  }
  // Refuses a title with nothing to build a slug from, rather than falling back
  // to a hash the way an UNNAMED thread does at creation: someone typing a
  // title means to see it in the address, and quietly replacing it is worse
  // than saying it cannot be used.
  const nextSlug = threadSlugFromTitle(trimmed)
  if (nextSlug === row.slug) {
    await db.update(groupChatThread).set({ title: trimmed }).where(eq(groupChatThread.id, threadId))
    return
  }
  const [taken] = await db
    .select({ id: groupChatThread.id })
    .from(groupChatThread)
    .where(
      and(
        eq(groupChatThread.groupChatId, row.groupChatId),
        eq(groupChatThread.agentNodeId, row.agentNodeId),
        eq(groupChatThread.slug, nextSlug),
      ),
    )
    .limit(1)
  if (taken) {
    // Scoped to (chat, agent) because that is what the key path is -- the same
    // scope, code and wording `startThread` refuses with.
    throw new GroupChatAccessError('slug-taken', `This agent already has a thread named "${nextSlug}" here`)
  }

  const parts = partsOfSessionKey(row.sessionKey)
  const moves: TabKeyMove[] =
    parts && row.slug && parts.threadSlug === row.slug
      ? [{ from: row.sessionKey, to: mintSessionKey(parts.chatSlug, parts.agentSlug, nextSlug) }]
      : []
  const move = moves[0]

  await requireSessionKeysFree(move ? [move.to] : [], [row.id])
  await stageSessionKeyMoves(moves)
  await db.transaction(async (tx) => {
    // The live binding this rename creates takes both of its addresses
    // outright -- see `startThread` for why an alias may never outrank one.
    await tx
      .delete(groupChatThreadAlias)
      .where(
        and(
          eq(groupChatThreadAlias.groupChatId, row.groupChatId),
          eq(groupChatThreadAlias.agentNodeId, row.agentNodeId),
          eq(groupChatThreadAlias.slug, nextSlug),
        ),
      )
    if (move) {
      await tx.delete(groupChatThreadAlias).where(eq(groupChatThreadAlias.sessionKey, move.to))
    }
    // One row records everything this rename freed. Nothing freed, no row.
    if (row.slug || move) {
      await tx.insert(groupChatThreadAlias).values({
        threadId: row.id,
        groupChatId: row.groupChatId,
        agentNodeId: row.agentNodeId,
        sessionKey: move?.from ?? null,
        slug: row.slug,
      })
    }
    await tx
      .update(groupChatThread)
      .set({
        title: trimmed,
        slug: nextSlug,
        // A key that is not a column is dropped when the SET clause is built --
        // it walks the table's columns, not this object -- so a typo here costs
        // the write rather than raising anything. Naming the argument's own type
        // is what makes it fail, since a spread is not checked against `.set()`.
        ...(move
          ? ({ sessionKey: move.to } satisfies Pick<PgUpdateSetSource<typeof groupChatThread>, 'sessionKey'>)
          : {}),
      })
      .where(eq(groupChatThread.id, threadId))
  })
  await settleSessionKeyMoves(moves)
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
  /**
   * The thread-list folder this thread is filed in, by the name a person sees
   * on the list; null for a thread at the top level.
   */
  folder: string | null
  /** The agent this thread talks to — which may be the caller itself. */
  agentNodeId: string
  createdAt: Date
  /**
   * How much context this thread's session is holding — the exact same
   * `listSessions` mechanism ordinary sessions use (agent-client's last
   * `usage` reading, seeded from the persisted per-session usage on cold
   * start), looked up by this thread's own session key. An offline thread
   * with prior activity reports its last-known reading here too, with `asOf`
   * (see ContextUsage) set. Null only when genuinely unknown (never reported
   * usage at all) — never zero-for-unknown.
   */
  contextUsage: ContextUsage | null
  /**
   * Server-held prompts waiting behind this thread's current turn — the same
   * live queue the 'queue' event publishes, via `listSessions`. 0 is a fact
   * (an unloaded session holds nothing), unlike `contextUsage`'s null.
   */
  queuedMessages: number
}

export interface AgentGroupChatRef {
  ref: string
  name: string
  topic: string
  /**
   * The agent members of this chat, by the name `group_chat_start_thread`
   * takes as its target. A chat's roster is not a secret from someone already
   * in it, and this is what makes the required target name readable rather
   * than remembered.
   */
  members: string[]
  threads: AgentThreadRef[]
}

/**
 * Resolve the calling agent to its node id, or refuse the way every other
 * lookup here does.
 *
 * An agent identified by its node is already resolved: the surface that
 * identified it found the node when the credential resolved, in the same
 * request, and looking it up again by name could only land on a different node
 * that shares the name.
 *
 * A NAME THAT MATCHES NOTHING IS A REFUSAL, not an empty result: a tool caller
 * who is not a recognised agent must be told so rather than handed a plausible
 * "you are in no group chats", which reads as an answer and is not one.
 */
export async function requireAgentNode(agent: AgentRef): Promise<string> {
  if (typeof agent !== 'string') {
    return agent.nodeId
  }
  // First match, for the same recorded reason `listGroupChatsForAgent` states:
  // agent names are a decided-unique namespace. An attribution path refuses on
  // a collision instead — a different policy over the same comparison, which is
  // why `agentNodesNamed` supplies only the comparison.
  const match = agentNodesNamed(await listAgentNodesImpl(), agent)[0]
  if (!match) {
    throw new GroupChatAccessError('not-found', `No agent named "${agent.trim()}" was found`)
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
 * The agent segment is immune to an agent rename: a key keeps the segment it
 * was minted with, and every reference the list surface hands out IS the stored
 * key's readable part, so a reference passed back always matches itself. What it does not accept is a
 * hand-written address using an agent's CURRENT name after a rename — and an
 * unambiguous address is worth more than that convenience.
 *
 * A KEY A RENAME FREED STILL RESOLVES, through `groupChatThreadAlias`. A
 * stored key used to be permanent; renaming a chat or a thread moves it, and
 * the addresses already written down -- in an agent's own notes, in a skill, in
 * a message queued before the rename -- cannot be rewritten by it. The alias is
 * what lands those where they always did instead of nowhere.
 *
 * Live first, alias second, for the reason every alias lookup here shares: if a
 * new thread has since taken the freed key, that thread is the answer.
 *
 * Returns null rather than refusing when nothing matches, so the caller falls
 * through to an id: the forms are alternatives, and an agent that stored an id
 * before slugs existed keeps working.
 */
async function resolveByKey(ref: string): Promise<ThreadDeliveryTarget | null> {
  // The reference exactly as given first -- a full key, including a pre-slug
  // key matched as a whole string -- then the readable body under the prefix.
  // No separator is ever converted: the colon spelling was retired with the
  // stored keys that carried it, and a reference written in it resolves to
  // nothing.
  const candidates = ref.startsWith(SESSION_KEY_PREFIX) ? [ref] : [ref, `${SESSION_KEY_PREFIX}${ref}`]
  for (const candidate of candidates) {
    const hit = await lookupStoredKey(candidate)
    if (hit) {
      return hit
    }
  }
  return null
}

async function lookupStoredKey(key: string): Promise<ThreadDeliveryTarget | null> {
  const threadId = await threadIdForSessionKey(key)
  if (!threadId) {
    return null
  }
  const [row] = await db
    .select(threadDeliveryColumns)
    .from(groupChatThread)
    .where(eq(groupChatThread.id, threadId))
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
export async function resolveThreadForAgent(agentNodeId: string, threadRef: string): Promise<ThreadDeliveryTarget> {
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
export async function listGroupChatsForAgentView(agent: AgentRef): Promise<AgentGroupChatRef[]> {
  const agentNodeId = await requireAgentNode(agent)
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
  // Same lookup host.ts's ordinary-session listSessions does: agent-client
  // only holds live (loaded-since-restart) sessions in memory, so a thread
  // whose session isn't in this map is offline, not necessarily unknown —
  // see the last-known fallback below.
  const metaBySessionKey = new Map(agentClient.listSessions().map((meta) => [meta.sessionKey, meta] as const))
  // Resolved once per thread, ahead of the synchronous map below: an offline
  // thread falls back to what it persisted before going offline (readLastKnownUsage
  // does its own settings-store read), and only offline threads pay for that
  // read at all.
  // One node read per distinct agent, not per thread: an offline thread needs
  // its agent's configured window (the only window authority left once the
  // session is not loaded -- see toContextUsage), and a chat's threads share
  // few agents between many threads.
  // The PROMISE is memoised, not the value it resolves to. These lookups run
  // inside the Promise.all below, so an await between the check and the store
  // would let every thread reach the check before any of them had stored
  // anything: all miss, all issue the lookup, and the memo dedupes nothing
  // while reading as though it does. Storing before the first await is what
  // makes the claim above true.
  const windowByAgentNodeId = new Map<string, Promise<number | undefined>>()
  const configuredWindowFor = (agentNodeId: string): Promise<number | undefined> => {
    let pending = windowByAgentNodeId.get(agentNodeId)
    if (!pending) {
      pending = agentConfiguredWindowByNodeId(agentNodeId)
      windowByAgentNodeId.set(agentNodeId, pending)
    }
    return pending
  }
  const contextUsageByKey = new Map(
    await Promise.all(
      threads.map(async (t) => {
        const live = metaBySessionKey.get(t.sessionKey)
        const usage = live
          ? toContextUsage(live.usage)
          : toContextUsage(
              undefined,
              (await readLastKnownUsage(t.sessionKey)) ?? undefined,
              await configuredWindowFor(t.agentNodeId),
            )
        return [t.sessionKey, usage] as const
      }),
    ),
  )
  // The rosters for every chat at once, alongside the threads. Needed because
  // `group_chat_start_thread` takes the target agent BY NAME and has no
  // defensible default (see startThreadAsAgent): without this the caller would
  // be made to guess a name and get the deliberately vague refusal for a typo.
  const membersByChatId = await agentMembersByChat(chats.map((c) => c.id))
  // Read from the same shared layout the thread list draws, so the folder named
  // here is the one a person sees the thread in.
  const folderByChatId = new Map(
    await Promise.all(
      chats.map(async (c) => [c.id, folderNameByThreadId((await readThreadLayout(c.id)).layout)] as const),
    ),
  )
  return chats.map((chat) => ({
    ref: chat.id,
    name: chat.name,
    topic: chat.topic,
    members: (membersByChatId.get(chat.id) ?? []).map((m) => m.name),
    threads: threads
      .filter((t) => t.groupChatId === chat.id)
      .map((t) => ({
        ref: agentThreadRef(t),
        title: t.title,
        folder: folderByChatId.get(chat.id)?.get(t.id) ?? null,
        agentNodeId: t.agentNodeId,
        createdAt: t.createdAt,
        contextUsage: contextUsageByKey.get(t.sessionKey) ?? null,
        queuedMessages: metaBySessionKey.get(t.sessionKey)?.queuedMessages ?? 0,
      })),
  }))
}

/** The reference `group_chat_list` hands out for a thread: readable where it has a slug, its id otherwise. */
function agentThreadRef(t: { id: string; slug: string | null; sessionKey: string }): string {
  return t.slug && isGroupChatSessionKey(t.sessionKey) ? threadRefFromSessionKey(t.sessionKey) : t.id
}

/**
 * File a thread in the folder of that name, creating the folder if the chat has
 * none. No gate: every caller has already established that the one asking is a
 * member of the thread's chat.
 */
async function placeThreadInFolder(groupChatId: string, threadId: string, folder: string): Promise<void> {
  await updateThreadLayout(groupChatId, (layout) => withThreadInFolder(layout, threadId, folder))
}

/**
 * A folder name as an agent passed it: trimmed, and refused when nothing is left.
 * Checked before anything is written, so a bad name costs nothing.
 */
function folderNameArgument(folder: string | undefined): string | undefined {
  if (folder === undefined) {
    return undefined
  }
  const trimmed = folder.trim()
  if (!trimmed) {
    throw new Error('A folder needs a name')
  }
  return trimmed
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
 * where a person is interrupting a run they are watching, and it is a different
 * axis from `queue` — position within the queue, not whether to interrupt.
 *
 * Whether this message waits or pushes is the CALLER's to state, and it is
 * required of them: an agent writing to a thread-mate usually has nothing
 * urgent, but the one sending a correction into a turn going the wrong way is
 * exactly who `push` exists for, and this function has no way to tell those
 * apart.
 */
export async function sendMessageInThreadAsAgent(
  agent: AgentRef,
  threadRef: string,
  text: string,
  queue: QueueMode,
): Promise<void> {
  const agentNodeId = await requireAgentNode(agent)
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('A message needs some text')
  }
  const row = await resolveThreadForAgent(agentNodeId, threadRef)
  // The agent's HANDLE, not the name it is addressed by. The name is a
  // display name -- free text, shared between accounts, changed by a rename --
  // and a message stamped with one resolves to nobody when it is read, so it
  // renders as that text with no face. The node id is already in hand one line
  // above; this is the same stamp a person's send makes, from the other source.
  await deliverIntoThread(row, trimmed, { queue, sender: await authorForAgentNode(agentNodeId, agentRefName(agent)) })
}

/**
 * The agent members of each of several chats, with the names an agent
 * addresses them by. Ungated on its own — every caller here has already
 * established the caller's own membership, and a chat's roster is not a
 * secret from someone already in it.
 *
 * ONE membership query and ONE node-list read for the whole set, in the same
 * shape the threads above are fetched: `listAgentNodesImpl` walks every space
 * in the registry, so calling it per chat turns a listing into as many full
 * graph reads as the caller has chats.
 *
 * Names, not node ids, because a name is what the tool surface takes and what
 * an agent can read. A member whose node has since disappeared is dropped
 * rather than listed with a placeholder: it cannot be addressed either way.
 * Every requested id gets an entry, so a caller never has to tell "no agent
 * members" apart from "chat not in the result".
 */
async function agentMembersByChat(
  groupChatIds: string[],
): Promise<Map<string, Array<{ nodeId: string; name: string }>>> {
  const out = new Map(groupChatIds.map((id) => [id, [] as Array<{ nodeId: string; name: string }>]))
  if (groupChatIds.length === 0) {
    return out
  }
  const rows = await db
    .select({ groupChatId: groupChatMember.groupChatId, agentNodeId: groupChatMember.agentNodeId })
    .from(groupChatMember)
    .where(and(inArray(groupChatMember.groupChatId, groupChatIds), eq(groupChatMember.principalType, 'agent')))
  const nameByNodeId = new Map((await listAgentNodesImpl()).map((n) => [n.nodeId, n.name]))
  for (const row of rows) {
    const name = row.agentNodeId ? nameByNodeId.get(row.agentNodeId) : undefined
    if (!row.agentNodeId || name === undefined) {
      continue
    }
    out.get(row.groupChatId)?.push({ nodeId: row.agentNodeId, name })
  }
  return out
}

/** One chat's agent members — see agentMembersByChat, which does the work. */
async function agentMembersOfChat(groupChatId: string): Promise<Array<{ nodeId: string; name: string }>> {
  return (await agentMembersByChat([groupChatId])).get(groupChatId) ?? []
}

/**
 * Start a thread as an agent — the tool-surface counterpart to `startThread`.
 * Same creation path (`createThread` mints every thread, whoever asked),
 * different gate: the CALLING agent's own membership of the chat, resolved
 * from its credential, exactly as `sendMessageInThreadAsAgent` does.
 *
 * WHICH AGENT THE THREAD ADDRESSES IS AN ARGUMENT, NOT AN INFERENCE. There is
 * no defensible default: addressing it to the caller would make handing work
 * to somebody else impossible, which is the entire reason this exists, and
 * picking any other member would be guessing at intent. So it is named, and
 * `group_chat_list` reports each chat's `members` so the name can be read off
 * rather than remembered.
 *
 * The target is resolved WITHIN the chat's own membership, which collapses
 * "no such agent" and "that agent is not in this chat" into one refusal —
 * they are the same fact to a caller who is not entitled to tell them apart,
 * and both arrive as the vague UNAVAILABLE a missing thread already gives. A
 * caller's own unknown name still refuses informatively through
 * `requireAgentNode`, because being told YOU are unrecognised leaks nothing
 * about anyone else.
 *
 * `folder` files the new thread in the thread-list folder of that name, made if
 * the chat has none -- the same layout write a person's drag makes. It happens
 * AFTER the first message is out: a delegation that was sent matters more than
 * where it is filed, so a placement that fails leaves a delivered thread at the
 * top level and says so, rather than a filed thread nobody was told about.
 */
export async function startThreadAsAgent(
  callerAgent: AgentRef,
  groupChatId: string,
  targetAgentName: string,
  firstMessage: string,
  opts?: { title?: string; folder?: string },
): Promise<StartThreadResult & { folder: string | null }> {
  const callerNodeId = await requireAgentNode(callerAgent)
  // The caller's membership is the gate, and a chat that does not exist has no
  // members — so a bad id and a chat the caller is not in refuse identically,
  // with no existence check to leak the difference.
  if (!(await isAgentMember(groupChatId, callerNodeId))) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  const trimmed = firstMessage.trim()
  if (!trimmed) {
    throw new Error('A message needs some text')
  }
  const folder = folderNameArgument(opts?.folder)
  const target = (await agentMembersOfChat(groupChatId)).find((m) => m.name === targetAgentName.trim())
  if (!target) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  const started = await createThread(groupChatId, target.nodeId, trimmed, {
    title: opts?.title,
    createdByUserId: null,
    // THE CALLER, NOT THE TARGET, for the same reason `sender` below is: the
    // thread is addressed TO the named agent and was started BY this one. It
    // is what lets the starter delete the thread it made for a colleague —
    // without it, a dispatcher could create threads and never clean them up.
    createdByAgentNodeId: callerNodeId,
    // THE CALLER, NOT THE TARGET. The thread is addressed TO the named agent;
    // the opening message is FROM the one that started it, exactly as a later
    // message through `sendMessageInThreadAsAgent` is. Its handle, never the
    // display name it was addressed by — see authorForAgentNode.
    sender: await authorForAgentNode(callerNodeId, agentRefName(callerAgent)),
  })
  if (folder) {
    try {
      await placeThreadInFolder(groupChatId, started.thread.id, folder)
    } catch (error) {
      throw new Error(
        `The thread "${threadRefFromSessionKey(started.thread.sessionKey)}" was started and its message sent, but it could not be ` +
          `filed in the folder "${folder}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
  return { ...started, folder: folder ?? null }
}

/**
 * Rename a thread, file it in a folder, or both, as an agent — the tool-surface
 * counterpart to the thread list's rename and drag.
 *
 * THE UI RENAME'S GATE, NOT A NEW ONE. A person may rename any thread of a chat
 * they are a member of; an agent may rename any thread of a chat IT is a member
 * of, resolved through `resolveThreadForAgent` like every other tool here. The
 * title change is `renameThread`'s own code past its gate, so the address moves
 * exactly as it does for a person and the old one keeps resolving through the
 * alias that records it.
 *
 * Title first, folder second: a refused title (taken, or nothing to build an
 * address from) then changes nothing at all.
 *
 * Returns the thread's reference AFTER the rename, since a new title can move it.
 */
export async function renameThreadAsAgent(
  agent: AgentRef,
  threadRef: string,
  changes: { title?: string; folder?: string },
): Promise<{ ref: string; title: string | null; folder: string | null }> {
  const agentNodeId = await requireAgentNode(agent)
  const target = await resolveThreadForAgent(agentNodeId, threadRef)
  const folder = folderNameArgument(changes.folder)
  if (changes.title === undefined && folder === undefined) {
    throw new Error('Nothing to change: pass a title, a folder, or both')
  }
  if (changes.title !== undefined) {
    await applyThreadRename(await threadRowForRename(target.id), changes.title)
  }
  if (folder) {
    await placeThreadInFolder(target.groupChatId, target.id, folder)
  }
  const [row] = await db
    .select({
      id: groupChatThread.id,
      slug: groupChatThread.slug,
      sessionKey: groupChatThread.sessionKey,
      title: groupChatThread.title,
    })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, target.id))
    .limit(1)
  if (!row) {
    throw new GroupChatAccessError('not-found', UNAVAILABLE)
  }
  const { layout } = await readThreadLayout(target.groupChatId)
  return { ref: agentThreadRef(row), title: row.title, folder: folderNameByThreadId(layout).get(row.id) ?? null }
}

/**
 * Compact a thread's session as an agent — the tool-surface counterpart to
 * `compactThread`. Same target, same effect (compact, then re-deliver the
 * thread's CURRENT standing context on success — see `compactThread`'s own
 * header for why that matters), different gate: membership is the calling
 * agent's own, resolved through `resolveThreadForAgent` exactly like
 * `sendMessageInThreadAsAgent`, rather than a signed-in user's.
 *
 * The thread's OWN agent must also still be a member — `resolveThreadForAgent`
 * only checks the CALLER, so this repeats the check `compactThread` makes
 * inline rather than through `deliverIntoThread`, since compaction never goes
 * through that shared delivery path (it talks to `requestCompact`
 * directly, same as `compactThread` does).
 */
export async function compactThreadAsAgent(agent: AgentRef, threadRef: string): Promise<ThreadCompactAck> {
  const agentNodeId = await requireAgentNode(agent)
  const row = await resolveThreadForAgent(agentNodeId, threadRef)
  if (!(await isAgentMember(row.groupChatId, row.agentNodeId))) {
    throw new GroupChatAccessError('agent-not-a-member', 'That agent is no longer a member of this group chat')
  }
  return toThreadCompactAck(await requestCompact(row.sessionKey))
}

/**
 * The compact job's status for a thread, as an agent — same resolution as
 * `compactThreadAsAgent`, but no agent-still-a-member check: reading a
 * finished or in-flight job's status is harmless even for a thread whose
 * agent has since left, matching `threadCompactStatus`'s own precedent (it
 * checks the requester's membership and nothing else either).
 */
export async function threadCompactStatusAsAgent(agent: AgentRef, threadRef: string): Promise<ThreadCompactStatus> {
  const agentNodeId = await requireAgentNode(agent)
  const row = await resolveThreadForAgent(agentNodeId, threadRef)
  return toThreadCompactStatus(getCompactStatus(row.sessionKey))
}

/**
 * A thread's recent turns, as an agent — the tool-surface counterpart to the
 * send-message node's `listTurns` action, built on the same shared core
 * (`turnsPageForSessionKey`), so a turn reads identically wherever it is
 * inspected from: same summaries, same truncation, same paging, same
 * in-progress marking. Gate matches `threadCompactStatusAsAgent`: the CALLER's
 * membership (via `resolveThreadForAgent`) and nothing else — reading turn
 * summaries of a thread the caller was put into is the same class of read as
 * the thread's transcript on screen.
 */
export async function listThreadTurnsAsAgent(
  agent: AgentRef,
  threadRef: string,
  params?: { turns?: number; beforeIndex?: number },
): Promise<TurnsPage> {
  const agentNodeId = await requireAgentNode(agent)
  const row = await resolveThreadForAgent(agentNodeId, threadRef)
  return turnsPageForSessionKey(row.sessionKey, { turns: params?.turns, beforeIndex: params?.beforeIndex })
}

/**
 * Send into a thread from a send-message node's graph-driven envelope — the
 * third caller of the shared delivery path, distinct from both the ones
 * above, and answering to the SAME authority: membership of whoever is
 * sending. The principal is who actually fed the run — an agent node, or a
 * system identity like a schedule's script or the forge webhook — and it must
 * hold a member row in the resolved thread's chat, exactly as an agent
 * calling `sendMessageInThreadAsAgent` must. A system sender is authorized by
 * an explicit per-chat grant row (`principalType: 'system'`), added and
 * revoked in the members list like any other member — never by a code-side
 * exemption for the `system.` prefix, which would be an allow-list nothing
 * can see or revoke.
 *
 * This replaced a gate on the sending node's agent:job graph wiring — an
 * authority borrowed from session ROUTING that no thread pipeline for a
 * container-run agent could ever satisfy, so every scheduled tick failed
 * while its schedule recorded success.
 *
 * Registered with stream.ts's thread-delivery registry at server startup
 * (registerThreadDeliveryResolver) rather than imported there directly — see
 * that registry's own header for why stream.ts must not import group-chat
 * code.
 */
export async function deliverThreadFromNode(
  threadRef: string,
  text: string,
  principal: SendPrincipal,
  queue: QueueMode,
  sender: string,
): Promise<ThreadDeliveryOutcome> {
  const trimmed = threadRef.trim()
  if (!trimmed) {
    return { status: 'not-found' }
  }
  const row = (await resolveByKey(trimmed)) ?? (await resolveById(trimmed))
  if (!row) {
    return { status: 'not-found' }
  }
  if (!(await isPrincipalMember(row.groupChatId, principal))) {
    return { status: 'not-a-member' }
  }
  const { queued } = await deliverIntoThread(row, text, { queue, sender })
  return { status: queued ? 'queued' : 'delivered' }
}
