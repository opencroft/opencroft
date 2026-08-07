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
  deleteThread,
  getGroupChat,
  getThread,
  listGroupChatsForUser,
  listMembers,
  listThreadsInGroupChat,
  removeMember,
  sendMessageInThread,
  startThread,
} from '@/app/_authed/(group-chats)/_server/model'
import type {
  AgentRef,
  GroupChatDetailView,
  GroupChatListEntry,
  GroupChatThreadEntry,
  MemberRef,
} from '@/app/_authed/(group-chats)/_server/read-model'
import {
  getGroupChatDetailView,
  getThreadView,
  listGroupChatsForUserView,
  listThreadsInGroupChatView,
} from '@/app/_authed/(group-chats)/_server/read-model'
import type { DirectoryUser } from '@/app/_authed/(group-chats)/_server/user-directory'
import { listDirectoryUsers } from '@/app/_authed/(group-chats)/_server/user-directory'
import type { GroupChatAccessFailure } from '@/app/_authed/(group-chats)/_shared/access-error'
import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'

// So no client file ever has a reason to name model.ts directly — the same
// pattern agents.ts just adopted for agents-impl.ts. These are erased at
// build time and carry no runtime binding, so re-exporting them here is safe
// even though model.ts's own runtime tail is not client-safe.
export type {
  AgentRef,
  DirectoryUser,
  GroupChatDetailView,
  GroupChatListEntry,
  GroupChatSummary,
  GroupChatThreadEntry,
  GroupChatThreadSummary,
  MemberPrincipal,
  MemberRef,
  StartThreadResult,
}

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

export const removeGroupChatMember = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; principal: MemberPrincipal }) => data)
  .handler(async ({ data }): Promise<void> => removeMember(getRequest(), data.groupChatId, data.principal))

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

/**
 * The outcome of a thread send: delivered, or refused with a code.
 *
 * A REFUSAL IS RETURNED, NOT THROWN, and that is the point. A thrown error
 * does not survive this boundary intact — `createServerFn` serialises it to
 * `$TSR/Error` carrying `message` and nothing else, so `name`, `code` and
 * every other own property are gone by the time the browser sees it. Any
 * client-side branch on those fields silently falls through to whatever its
 * fallback is, which is exactly what happened here: the send was refused
 * correctly and the reader was told "your message could not be sent" instead
 * of why.
 *
 * Matching on the message text would work today and break on the next copy
 * edit. A returned value crosses as data, so the code arrives intact and the
 * wording stays a client-side concern.
 *
 * Faults still throw. Only a deliberate refusal — something the reader can act
 * on — comes back this way.
 */
export type SendThreadMessageResult = { ok: true } | { ok: false; code: GroupChatAccessFailure }

export const sendGroupChatThreadMessage = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { threadId: string; text: string; front?: boolean }) => data)
  .handler(async ({ data }): Promise<SendThreadMessageResult> => {
    try {
      await sendMessageInThread(getRequest(), data.threadId, data.text, { front: data.front })
      return { ok: true }
    } catch (error) {
      // `instanceof` is reliable HERE and only here: this runs in the same
      // process that threw, with the real class. It is the client side that
      // cannot use it, which is why the code is put on the wire as data.
      if (error instanceof GroupChatAccessError) {
        return { ok: false, code: error.code }
      }
      throw error
    }
  })

// ── The reading surface's view model (phase 2) ───────────────────────────
//
// These sit ALONGSIDE the raw functions above rather than replacing them.
// The raw shapes are phase 1's recorded contract and other callers (the
// agent-side lookup, phase 3's writes) depend on them; the UI needs ids
// resolved to names and avatars, which is a different concern and a heavier
// query. Keeping both means neither surface pays for the other's needs.

export const listMyGroupChatsView = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<GroupChatListEntry[]> => listGroupChatsForUserView(getRequest()),
)

export const getMyGroupChatView = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((groupChatId: string) => groupChatId)
  .handler(
    async ({ data: groupChatId }): Promise<GroupChatDetailView> => getGroupChatDetailView(getRequest(), groupChatId),
  )

export const listGroupChatThreadsView = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((groupChatId: string) => groupChatId)
  .handler(
    async ({ data: groupChatId }): Promise<GroupChatThreadEntry[]> =>
      listThreadsInGroupChatView(getRequest(), groupChatId),
  )

// The people a member picker offers. Signed-in only; see user-directory.ts for
// why this is its own function rather than a widened admin read.
export const listDirectoryUsersForPicker = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<DirectoryUser[]> => listDirectoryUsers(getRequest()),
)

export const getGroupChatThreadView = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(
    async ({ data: threadId }): Promise<GroupChatThreadEntry & { sessionKey: string }> =>
      getThreadView(getRequest(), threadId),
  )

export const deleteGroupChatThread = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }): Promise<void> => deleteThread(getRequest(), threadId))
