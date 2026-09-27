// The reading surface's view model.
//
// Phase 1 returns IDS: a thread carries `agentNodeId`, a member carries
// `userId` or `agentNodeId`, and nothing carries a display name or avatar.
// Rendering any of that needs names and pictures, so this module resolves
// them once per request and hands the UI a shape it can draw directly.
//
// ACCESS CONTROL IS NOT REIMPLEMENTED HERE, DELIBERATELY. Every function
// below delegates to a phase-1 model function that performs its own
// membership check (`requireGroupChatMember`, which is private to model.ts),
// and enriches what comes back. That keeps exactly one place deciding who may
// read a group chat — adding a second would be two rules to keep in step, and
// the one that drifts is a hole. A function here that queries group-chat
// content without going through model.ts first is a bug.

import { db, groupChatMember, groupChatThread, user } from '@opencroft/db'
import { and, inArray, isNull } from 'drizzle-orm'

import type { GroupChatThreadSummary } from '@/app/_authed/(group-chats)/_server/model'
import {
  findThreadBySlug,
  findThreadInGroupChat,
  getGroupChat,
  listGroupChatsForUser,
  listMembers,
  listThreadsInGroupChat,
} from '@/app/_authed/(group-chats)/_server/model'
import { listAgentNodesImpl } from '@/app/_authed/(space)/_server/agents-impl'

/** A participant in a group chat — a person or an agent, rendered alike. */
export interface MemberRef {
  kind: 'user' | 'agent'
  /** `userId` for a person, `agentNodeId` for an agent. */
  id: string
  name: string
  avatarUrl: string | null
}

/** The single agent a thread is a session with. */
export interface AgentRef {
  nodeId: string
  name: string
  avatarUrl: string | null
}

export interface GroupChatListEntry {
  id: string
  name: string
  topic: string
  members: MemberRef[]
  threadCount: number
}

export interface GroupChatDetailView {
  id: string
  /** What the header shows. Presentation only — never sent to an agent. */
  name: string
  /** What agents are told this chat is for. Shown too, as the secondary line. */
  topic: string
  members: MemberRef[]
}

export interface GroupChatThreadEntry {
  id: string
  groupChatId: string
  title: string | null
  agent: AgentRef
  createdAt: Date
  /**
   * The tab key this thread's agent session was created under. A session key
   * is bearer-equivalent inside the ACP layer (phase 1's note on `getThread`),
   * but any member is already entitled to it, so handing it to a list is not
   * a new exposure — it is what lets a row ask the shared session-activity
   * poll for this thread's live status, the same way a chat-list row already
   * does with its own session key.
   */
  sessionKey: string
  /**
   * False once this thread's agent has been removed from the group chat. The
   * thread stays — it is still readable — but it can no longer be sent to,
   * which `sendMessageInThread` enforces server-side.
   *
   * Named for the fact rather than for what a screen does with it: the kit's
   * thread list takes a `disabled` flag, and the mapping from "no longer a
   * member" to "renders dimmed" belongs to the page, not to a server read.
   */
  agentIsMember: boolean
  /**
   * Whether this thread has unsent composer text. The draft's own text is not
   * exposed on list rows — a list of twenty threads has no use for twenty
   * drafts, same reasoning as this doc comment gives for `sessionKey` above
   * having been kept off list rows before it was needed for live status.
   */
  hasDraft: boolean
  /**
   * True for an archived thread: it is drawn in the chat's archive rather than
   * its thread list, opens read-only, and refuses every send until unarchived.
   */
  archived: boolean
}

// A reference that no longer resolves is shown, not hidden. `agentNodeId` is
// not a foreign key — agent nodes live in space-graph JSON, so an agent can be
// deleted from the graph while membership and threads still point at it. The
// honest rendering of that is a named placeholder: dropping the row would make
// a thread silently vanish from a list, and throwing would take a whole page
// down over one stale reference.
function missingAgent(nodeId: string): AgentRef {
  return { nodeId, name: 'Unknown agent', avatarUrl: null }
}

function missingUser(userId: string): MemberRef {
  return { kind: 'user', id: userId, name: 'Unknown user', avatarUrl: null }
}

/**
 * nodeId -> agent, built once per call.
 *
 * `listAgentNodesImpl()` walks every space's graph, so calling it per thread
 * or per member would re-read the whole registry for each row. One call, one
 * map, however many rows.
 */
async function agentsByNodeId(): Promise<Map<string, AgentRef>> {
  const nodes = await listAgentNodesImpl()
  return new Map(nodes.map((n) => [n.nodeId, { nodeId: n.nodeId, name: n.name, avatarUrl: n.avatar ?? null }] as const))
}

/**
 * The agent node ids currently in a group chat's membership.
 *
 * Goes through `listMembers` rather than querying the table directly so the
 * membership gate is applied by the same function every other read here uses —
 * a second, ungated path to the same rows is how the two drift apart.
 */
async function agentMemberIds(request: Request, groupChatId: string): Promise<Set<string>> {
  const rows = await listMembers(request, groupChatId)
  return new Set(rows.flatMap((r) => (r.principalType === 'agent' && r.agentNodeId ? [r.agentNodeId] : [])))
}

async function usersById(userIds: string[]): Promise<Map<string, MemberRef>> {
  if (userIds.length === 0) {
    return new Map()
  }
  const rows = await db
    .select({ id: user.id, name: user.name, image: user.image })
    .from(user)
    .where(inArray(user.id, userIds))
  return new Map(
    rows.map((r) => [r.id, { kind: 'user' as const, id: r.id, name: r.name, avatarUrl: r.image ?? null }] as const),
  )
}

function toMemberRefs(
  rows: Array<{ principalType: string; userId: string | null; agentNodeId: string | null }>,
  agents: Map<string, AgentRef>,
  users: Map<string, MemberRef>,
): MemberRef[] {
  const out: MemberRef[] = []
  for (const row of rows) {
    if (row.principalType === 'agent' && row.agentNodeId) {
      const agent = agents.get(row.agentNodeId) ?? missingAgent(row.agentNodeId)
      out.push({ kind: 'agent', id: agent.nodeId, name: agent.name, avatarUrl: agent.avatarUrl })
    } else if (row.userId) {
      out.push(users.get(row.userId) ?? missingUser(row.userId))
    }
    // A 'system' grant row (a scheduled pipeline's or webhook's delivery
    // authorization — see groupChatMember in the schema) carries neither id
    // column and is not surfaced in this view yet: MemberRef feeds kit
    // components typed to user | agent, and widening a kit-tracked component
    // is its own kit-first change. The grant stays listable and revocable
    // through listGroupChatMembers / removeGroupChatMember meanwhile.
  }
  return out
}

/**
 * Every group chat the signed-in user is a member of, with its participants
 * and how many threads it holds.
 *
 * The membership gate is `listGroupChatsForUser`'s: the ids it returns are
 * already scoped to chats this user belongs to, so the bulk member and thread
 * queries below are restricted to exactly those ids and can add nothing the
 * caller was not already entitled to. They are bulk rather than per-chat to
 * avoid a query per row.
 */
export async function listGroupChatsForUserView(request: Request): Promise<GroupChatListEntry[]> {
  const chats = await listGroupChatsForUser(request)
  if (chats.length === 0) {
    return []
  }
  const chatIds = chats.map((c) => c.id)

  const memberRows = await db
    .select({
      groupChatId: groupChatMember.groupChatId,
      principalType: groupChatMember.principalType,
      userId: groupChatMember.userId,
      agentNodeId: groupChatMember.agentNodeId,
    })
    .from(groupChatMember)
    .where(inArray(groupChatMember.groupChatId, chatIds))

  // Active threads only: an archived one is not in the chat's thread list.
  const threadRows = await db
    .select({ groupChatId: groupChatThread.groupChatId })
    .from(groupChatThread)
    .where(and(inArray(groupChatThread.groupChatId, chatIds), isNull(groupChatThread.archivedAt)))

  const agents = await agentsByNodeId()
  const users = await usersById(memberRows.flatMap((r) => (r.userId ? [r.userId] : [])))

  const membersByChat = new Map<string, typeof memberRows>()
  for (const row of memberRows) {
    const list = membersByChat.get(row.groupChatId) ?? []
    list.push(row)
    membersByChat.set(row.groupChatId, list)
  }
  const threadCounts = new Map<string, number>()
  for (const row of threadRows) {
    threadCounts.set(row.groupChatId, (threadCounts.get(row.groupChatId) ?? 0) + 1)
  }

  return chats.map((chat) => ({
    id: chat.id,
    name: chat.name,
    topic: chat.topic,
    members: toMemberRefs(membersByChat.get(chat.id) ?? [], agents, users),
    threadCount: threadCounts.get(chat.id) ?? 0,
  }))
}

/** One group chat's header data: its name and topic, and who is taking part. */
export async function getGroupChatDetailView(request: Request, groupChatId: string): Promise<GroupChatDetailView> {
  const chat = await getGroupChat(request, groupChatId)
  const memberRows = await listMembers(request, groupChatId)
  const agents = await agentsByNodeId()
  const users = await usersById(memberRows.flatMap((r) => (r.userId ? [r.userId] : [])))
  return {
    id: chat.id,
    name: chat.name,
    topic: chat.topic,
    members: toMemberRefs(memberRows, agents, users),
  }
}

/** The threads inside one group chat, each with its agent resolved. */
export async function listThreadsInGroupChatView(
  request: Request,
  groupChatId: string,
): Promise<GroupChatThreadEntry[]> {
  const threads = await listThreadsInGroupChat(request, groupChatId)
  if (threads.length === 0) {
    return []
  }
  const agents = await agentsByNodeId()
  const agentMembers = await agentMemberIds(request, groupChatId)
  return threads.map((t) => ({
    id: t.id,
    groupChatId: t.groupChatId,
    title: t.title,
    agent: agents.get(t.agentNodeId) ?? missingAgent(t.agentNodeId),
    createdAt: t.createdAt,
    agentIsMember: agentMembers.has(t.agentNodeId),
    sessionKey: t.sessionKey,
    hasDraft: Boolean(t.draft?.trim()),
    archived: t.archivedAt !== null,
  }))
}

/**
 * One thread of a given group chat by id, with its agent resolved, or null
 * when the chat holds no such thread -- see `findThreadInGroupChat`. Same
 * shape the list entries carry, plus the draft's own text — which list rows
 * still don't get, for the same reason `hasDraft`'s doc comment on
 * `GroupChatThreadEntry` gives.
 */
export async function findThreadViewInGroupChat(
  request: Request,
  groupChatId: string,
  threadId: string,
): Promise<(GroupChatThreadEntry & { draft: string | null }) | null> {
  const thread = await findThreadInGroupChat(request, groupChatId, threadId)
  if (!thread) {
    return null
  }
  return enrichThread(request, thread)
}

/**
 * One agent's thread with a given slug, enriched like `findThreadViewInGroupChat`, or
 * null when no such thread exists — the embedded surface's "first send will
 * create it" state, which the caller needs as data rather than a refusal.
 * The gate is `findThreadBySlug`'s, per this module's header rule.
 */
export async function findThreadViewBySlug(
  request: Request,
  groupChatId: string,
  agentNodeId: string,
  threadSlug: string,
): Promise<(GroupChatThreadEntry & { draft: string | null }) | null> {
  const thread = await findThreadBySlug(request, groupChatId, agentNodeId, threadSlug)
  if (!thread) {
    return null
  }
  return enrichThread(request, thread)
}

/** The shared tail of the single-thread reads: resolve the agent and its
 *  current membership for one already-gated thread row. */
async function enrichThread(
  request: Request,
  thread: GroupChatThreadSummary,
): Promise<GroupChatThreadEntry & { draft: string | null }> {
  const agents = await agentsByNodeId()
  const agentMembers = await agentMemberIds(request, thread.groupChatId)
  return {
    id: thread.id,
    groupChatId: thread.groupChatId,
    title: thread.title,
    agent: agents.get(thread.agentNodeId) ?? missingAgent(thread.agentNodeId),
    createdAt: thread.createdAt,
    agentIsMember: agentMembers.has(thread.agentNodeId),
    hasDraft: Boolean(thread.draft?.trim()),
    sessionKey: thread.sessionKey,
    draft: thread.draft,
    archived: thread.archivedAt !== null,
  }
}
