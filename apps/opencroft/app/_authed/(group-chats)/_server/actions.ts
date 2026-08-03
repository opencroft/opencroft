// Thin createServerFn wrappers over model.ts. Authorization is NOT this
// file's job — every export delegates straight to a model function, which
// calls its own membership check. This file exists only to give the browser
// something to call; see admin-users-actions.ts for the same split.

import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import type {
  GroupChatSummary,
  GroupChatThreadSummary,
  MemberPrincipal,
  StartThreadResult,
} from '@/app/_authed/(group-chats)/_server/model'
import {
  addMember,
  createGroupChat,
  getGroupChat,
  getThread,
  listGroupChatsForUser,
  listMembers,
  listThreadsInGroupChat,
  sendMessageInThread,
  startThread,
} from '@/app/_authed/(group-chats)/_server/model'

// So no client file ever has a reason to name model.ts directly — the same
// pattern agents.ts just adopted for agents-impl.ts. These are erased at
// build time and carry no runtime binding, so re-exporting them here is safe
// even though model.ts's own runtime tail is not client-safe.
export type { GroupChatSummary, GroupChatThreadSummary, MemberPrincipal, StartThreadResult }

export const listMyGroupChats = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<GroupChatSummary[]> => listGroupChatsForUser(getRequest()),
)

export const getMyGroupChat = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((groupChatId: string) => groupChatId)
  .handler(async ({ data: groupChatId }): Promise<GroupChatSummary> => getGroupChat(getRequest(), groupChatId))

export const createMyGroupChat = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((topic: string) => topic)
  .handler(async ({ data: topic }): Promise<GroupChatSummary> => createGroupChat(getRequest(), topic))

export const addGroupChatMember = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; principal: MemberPrincipal }) => data)
  .handler(async ({ data }): Promise<void> => addMember(getRequest(), data.groupChatId, data.principal))

export const listGroupChatMembers = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((groupChatId: string) => groupChatId)
  .handler(async ({ data: groupChatId }) => listMembers(getRequest(), groupChatId))

export const listGroupChatThreads = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((groupChatId: string) => groupChatId)
  .handler(
    async ({ data: groupChatId }): Promise<GroupChatThreadSummary[]> =>
      listThreadsInGroupChat(getRequest(), groupChatId),
  )

export const getGroupChatThread = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }): Promise<GroupChatThreadSummary> => getThread(getRequest(), threadId))

export const startGroupChatThread = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; agentNodeId: string; firstMessage: string }) => data)
  .handler(
    async ({ data }): Promise<StartThreadResult> =>
      startThread(getRequest(), data.groupChatId, data.agentNodeId, data.firstMessage),
  )

export const sendGroupChatThreadMessage = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { threadId: string; text: string }) => data)
  .handler(async ({ data }): Promise<void> => sendMessageInThread(getRequest(), data.threadId, data.text))
