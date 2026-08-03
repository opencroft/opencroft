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
import { inArray } from 'drizzle-orm'

import {
  getGroupChat,
  getThread,
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
  topic: string
  members: MemberRef[]
  threadCount: number
}

export interface GroupChatDetailView {
  id: string
  topic: string
  members: MemberRef[]
}

export interface GroupChatThreadEntry {
  id: string
  groupChatId: string
  title: string | null
  agent: AgentRef
  createdAt: Date
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

  const threadRows = await db
    .select({ groupChatId: groupChatThread.groupChatId })
    .from(groupChatThread)
    .where(inArray(groupChatThread.groupChatId, chatIds))

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
    topic: chat.topic,
    members: toMemberRefs(membersByChat.get(chat.id) ?? [], agents, users),
    threadCount: threadCounts.get(chat.id) ?? 0,
  }))
}

/** One group chat's header data: its topic and who is taking part. */
export async function getGroupChatDetailView(request: Request, groupChatId: string): Promise<GroupChatDetailView> {
  const chat = await getGroupChat(request, groupChatId)
  const memberRows = await listMembers(request, groupChatId)
  const agents = await agentsByNodeId()
  const users = await usersById(memberRows.flatMap((r) => (r.userId ? [r.userId] : [])))
  return {
    id: chat.id,
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
  return threads.map((t) => ({
    id: t.id,
    groupChatId: t.groupChatId,
    title: t.title,
    agent: agents.get(t.agentNodeId) ?? missingAgent(t.agentNodeId),
    createdAt: t.createdAt,
  }))
}

/** One thread, with its agent resolved. Refuses exactly as `getThread`. */
export async function getThreadView(request: Request, threadId: string): Promise<GroupChatThreadEntry> {
  const thread = await getThread(request, threadId)
  const agents = await agentsByNodeId()
  return {
    id: thread.id,
    groupChatId: thread.groupChatId,
    title: thread.title,
    agent: agents.get(thread.agentNodeId) ?? missingAgent(thread.agentNodeId),
    createdAt: thread.createdAt,
  }
}
