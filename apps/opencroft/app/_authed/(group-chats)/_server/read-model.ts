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
import type { QueuedPrompt } from 'agent-client/types'
import { and, inArray, isNull } from 'drizzle-orm'

import type { ResolvedAuthor } from '@/app/_authed/(agent)/_lib/acp-stream'
import { withAuthors } from '@/app/_authed/(agent)/_server/attach-authors'
import { waitingEntries } from '@/app/_authed/(agent)/_server/queue-store'
import { type SnippetPart, searchTranscripts } from '@/app/_authed/(agent)/_server/transcript-search'
import type { ContextUsage } from '@/app/_authed/(extension-runtime)/_server/session-context-usage'
import type { GroupChatThreadSummary } from '@/app/_authed/(group-chats)/_server/model'
import {
  countThreadsInGroupChat,
  findThreadBySlug,
  findThreadInGroupChat,
  getGroupChat,
  lastKnownContextUsage,
  listGroupChatsForUser,
  listMembers,
  listThreadsInGroupChat,
} from '@/app/_authed/(group-chats)/_server/model'
import type { ThreadList } from '@/app/_authed/(group-chats)/_server/thread-layout-store'
import { listAgentDirectory } from '@/app/_authed/(space)/_server/agents-impl'
import { agentAvatarUrl } from '@/app/_server/agent-avatar'
import { userAvatarUrl } from '@/app/_server/user-avatar'

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
  /** How many threads the chat's archive holds. The archived threads
   *  themselves are a separate read, made only where they are drawn. */
  archivedThreadCount: number
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

/** Messages waiting for a thread's agent, and the accounts their senders
 *  resolve to -- the same pair a `queue` event carries on the stream. */
export interface ThreadQueue {
  items: QueuedPrompt[]
  authors?: Record<string, ResolvedAuthor>
}

/**
 * One thread as its own screen opens it: the list entry, plus the draft's
 * text and the messages waiting for its agent. The queue is here for the
 * screen to draw while the conversation is still opening -- the session's
 * stream is what carries it after that, and on a cold load the page is drawn
 * long before the stream starts.
 */
export type GroupChatThreadView = GroupChatThreadEntry & { draft: string | null; queue: ThreadQueue }

/** A thread as a list row carries it: the entry, plus what the list shows while its session is not running. */
export interface GroupChatThreadListEntry extends GroupChatThreadEntry {
  /**
   * The context this thread's session held at its last turn end, with `asOf`
   * set; null when it never reported any. A running session's current reading
   * is pushed with the session activity instead, so this is the figure for a
   * session that is not running -- which is why it is read for every thread,
   * loaded or not, rather than only for the ones offline at load.
   */
  lastContextUsage: ContextUsage | null
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
 * `listAgentDirectory()` walks every space's graph, so calling it per thread
 * or per member would re-read the whole registry for each row. One call, one
 * map, however many rows. It is also what extensions read as `host.agents`,
 * so an agent's face here and in an App is the same one -- handed to the page
 * as an address rather than the picture's bytes, so every row naming the
 * agent costs a URL and the browser fetches the picture once.
 */
async function agentsByNodeId(): Promise<Map<string, AgentRef>> {
  const agents = await listAgentDirectory()
  return new Map(
    agents.map((a) => {
      const avatarUrl = agentAvatarUrl({ nodeId: a.id, avatar: a.avatarUrl })
      return [a.id, { nodeId: a.id, name: a.name, avatarUrl }] as const
    }),
  )
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
    rows.map((r) => [r.id, { kind: 'user' as const, id: r.id, name: r.name, avatarUrl: userAvatarUrl(r) }] as const),
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
    archivedThreadCount: await countThreadsInGroupChat(request, groupChatId, 'archive'),
  }
}

/** The threads in one of a group chat's lists, each with its agent resolved. */
export async function listThreadsInGroupChatView(
  request: Request,
  groupChatId: string,
  list: ThreadList,
): Promise<GroupChatThreadListEntry[]> {
  const threads = await listThreadsInGroupChat(request, groupChatId, list)
  if (threads.length === 0) {
    return []
  }
  const agents = await agentsByNodeId()
  const agentMembers = await agentMemberIds(request, groupChatId)
  const lastContextByKey = await lastKnownContextUsage(threads)
  return threads.map((t) => ({
    lastContextUsage: lastContextByKey.get(t.sessionKey) ?? null,
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
): Promise<GroupChatThreadView | null> {
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
): Promise<GroupChatThreadView | null> {
  const thread = await findThreadBySlug(request, groupChatId, agentNodeId, threadSlug)
  if (!thread) {
    return null
  }
  return enrichThread(request, thread)
}

/** One message in a thread's transcript that a search matched. */
export interface ThreadTranscriptHit {
  threadId: string
  /** Where the matching message starts in the recorded transcript: its identity in the thread. */
  position: number
  /** Whether the match is in the question or the agent's reply. */
  role: 'user' | 'agent'
  /** Where the message's turn starts: what the thread opens at. */
  turn: number
  snippet: SnippetPart[]
  createdAt: Date
}

export interface ThreadTranscriptSearch {
  hits: ThreadTranscriptHit[]
  truncated: boolean
}

/** How many hits one search answers with, newest first. */
const TRANSCRIPT_SEARCH_LIMIT = 50

/**
 * The messages in one group chat's threads that match `query`, newest first.
 * Archived threads are searched only when asked for.
 *
 * The gate is `listThreadsInGroupChat`'s, per this module's header rule: the
 * search runs over exactly the session keys of the threads it returns, so
 * nothing outside the chat -- or outside the caller's membership -- can match.
 */
export async function searchThreadTranscriptsView(
  request: Request,
  groupChatId: string,
  query: string,
  includeArchived: boolean,
): Promise<ThreadTranscriptSearch> {
  const threads = await listThreadsInGroupChat(request, groupChatId, includeArchived ? undefined : 'active')
  const threadIdByKey = new Map(threads.map((t) => [t.sessionKey, t.id] as const))
  const { hits, truncated } = await searchTranscripts([...threadIdByKey.keys()], query, TRANSCRIPT_SEARCH_LIMIT)
  return {
    hits: hits.flatMap(({ sessionKey, ...hit }) => {
      const threadId = threadIdByKey.get(sessionKey)
      return threadId ? [{ threadId, ...hit }] : []
    }),
    truncated,
  }
}

/** The shared tail of the single-thread reads: resolve the agent and its
 *  current membership for one already-gated thread row. */
async function enrichThread(request: Request, thread: GroupChatThreadSummary): Promise<GroupChatThreadView> {
  const agents = await agentsByNodeId()
  const agentMembers = await agentMemberIds(request, thread.groupChatId)
  const queue = await waitingQueue(thread.sessionKey)
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
    queue,
  }
}

/**
 * The thread's waiting messages, authored the way the stream authors them.
 * Read only behind `enrichThread`'s callers, which have already checked the
 * reader is in the chat. A failed read costs the preview, not the thread:
 * the open replaces it with the live queue moments later either way.
 */
async function waitingQueue(sessionKey: string): Promise<ThreadQueue> {
  let items: QueuedPrompt[]
  try {
    items = await waitingEntries(sessionKey)
  } catch (err) {
    console.error("[group-chats] Could not read a thread's waiting messages:", err instanceof Error ? err.message : err)
    return { items: [] }
  }
  if (items.length === 0) {
    return { items }
  }
  const authored = await withAuthors({ kind: 'queue', items })
  return { items, ...(authored.authors ? { authors: authored.authors } : {}) }
}
