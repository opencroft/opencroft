// Thin createServerFn wrappers over model.ts. Authorization is NOT this
// file's job — every export delegates straight to a model function, which
// calls its own membership check. This file exists only to give the browser
// something to call; see admin-users-actions.ts for the same split.

import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'

import type { CompactAck, CompactStatus } from '@/app/_authed/(extension-runtime)/_server/stream'
import type {
  GroupChatPinSummary,
  GroupChatSummary,
  GroupChatThreadSummary,
  MemberPrincipal,
  StartThreadResult,
} from '@/app/_authed/(group-chats)/_server/model'
import {
  addMember,
  addPin,
  clearThread,
  compactThread,
  createGroupChat,
  deleteThread,
  editPin,
  getGroupChat,
  getThread,
  listGroupChatsForUser,
  listMembers,
  listPins,
  listThreadsInGroupChat,
  removeMember,
  removePin,
  renameGroupChat,
  sendMessageInThread,
  setGroupChatTopic,
  setThreadDraft,
  startThread,
  threadCompactStatus,
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
  GroupChatPinSummary,
  GroupChatSummary,
  GroupChatThreadEntry,
  GroupChatThreadSummary,
  MemberPrincipal,
  MemberRef,
  StartThreadResult,
}

/**
 * The outcome of a group-chat write: done, or refused with a code.
 *
 * A REFUSAL IS RETURNED, NOT THROWN, and that is the point. A thrown error
 * does not survive this boundary intact — `createServerFn` serialises it to
 * `$TSR/Error` carrying `message` and nothing else, so `name`, `code` and
 * every other own property are gone by the time the browser sees it. Any
 * client-side branch on those fields silently falls through to whatever its
 * fallback is: the write is refused correctly and the reader is told "that
 * didn't work" instead of why.
 *
 * Matching on the message text would work today and break on the next copy
 * edit. A returned value crosses as data, so the code arrives intact and the
 * wording stays a client-side concern.
 *
 * Faults still throw. Only a deliberate refusal — something the reader can act
 * on — comes back this way. An empty name is a fault, not a refusal: every
 * surface that can send one disables its own submit first, so reaching it
 * means a direct call, and there is nothing for a reader to act on.
 */
export type GroupChatWriteResult = { ok: true } | { ok: false; code: GroupChatAccessFailure }

/**
 * Turn a model refusal into the result above, leaving faults to throw.
 *
 * `instanceof` is reliable HERE and only here: this runs in the same process
 * that threw, with the real class. It is the client side that cannot use it,
 * which is why the code is put on the wire as data.
 */
async function asWriteResult(run: () => Promise<void>): Promise<GroupChatWriteResult> {
  try {
    await run()
    return { ok: true }
  } catch (error) {
    if (error instanceof GroupChatAccessError) {
      return { ok: false, code: error.code }
    }
    throw error
  }
}

export const listMyGroupChats = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<GroupChatSummary[]> => listGroupChatsForUser(getRequest()),
)

export const getMyGroupChat = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((groupChatId: string) => groupChatId)
  .handler(async ({ data: groupChatId }): Promise<GroupChatSummary> => getGroupChat(getRequest(), groupChatId))

// The topic is optional and falls back to the name — see `createGroupChat`.
// Accepts a bare string too, which is what creation sent before a chat had a
// name at all: the same call now names the chat and seeds its topic from it,
// which is exactly what those callers meant.
/**
 * Created, or refused with a code — the name's slug being taken is something
 * the person can act on, so it crosses as data rather than as a thrown error
 * whose code would not survive the boundary.
 */
export type CreateGroupChatResult = { ok: true; chat: GroupChatSummary } | { ok: false; code: GroupChatAccessFailure }

export const createMyGroupChat = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: string | { name: string; topic?: string }) => data)
  .handler(async ({ data }): Promise<CreateGroupChatResult> => {
    const input = typeof data === 'string' ? { name: data } : data
    try {
      return { ok: true, chat: await createGroupChat(getRequest(), input.name, input.topic) }
    } catch (error) {
      if (error instanceof GroupChatAccessError) {
        return { ok: false, code: error.code }
      }
      throw error
    }
  })

export const renameMyGroupChat = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; name: string }) => data)
  .handler(
    async ({ data }): Promise<GroupChatWriteResult> =>
      asWriteResult(() => renameGroupChat(getRequest(), data.groupChatId, data.name)),
  )

export const setMyGroupChatTopic = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; topic: string }) => data)
  .handler(
    async ({ data }): Promise<GroupChatWriteResult> =>
      asWriteResult(() => setGroupChatTopic(getRequest(), data.groupChatId, data.topic)),
  )

export const addGroupChatMember = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; principal: MemberPrincipal }) => data)
  .handler(
    async ({ data }): Promise<GroupChatWriteResult> =>
      asWriteResult(() => addMember(getRequest(), data.groupChatId, data.principal)),
  )

export const removeGroupChatMember = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; principal: MemberPrincipal }) => data)
  .handler(
    async ({ data }): Promise<GroupChatWriteResult> =>
      asWriteResult(() => removeMember(getRequest(), data.groupChatId, data.principal)),
  )

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

/** Started, or refused with a code — a taken thread title is actionable too. */
export type StartThreadOutcome = { ok: true; started: StartThreadResult } | { ok: false; code: GroupChatAccessFailure }

export const startGroupChatThread = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; agentNodeId: string; firstMessage: string; title?: string }) => data)
  .handler(async ({ data }): Promise<StartThreadOutcome> => {
    try {
      const started = await startThread(getRequest(), data.groupChatId, data.agentNodeId, data.firstMessage, {
        title: data.title,
      })
      return { ok: true, started }
    } catch (error) {
      if (error instanceof GroupChatAccessError) {
        return { ok: false, code: error.code }
      }
      throw error
    }
  })

/**
 * The outcome of a thread send: delivered, or refused with a code.
 *
 * The same shape as every other write here, kept under its own name because
 * the send path names it in three places and a rename would churn code that
 * carries no new risk. Why a refusal is returned rather than thrown is on
 * `GroupChatWriteResult` above.
 */
export type SendThreadMessageResult = GroupChatWriteResult

export const sendGroupChatThreadMessage = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { threadId: string; text: string; front?: boolean }) => data)
  .handler(
    async ({ data }): Promise<SendThreadMessageResult> =>
      asWriteResult(() => sendMessageInThread(getRequest(), data.threadId, data.text, { front: data.front })),
  )

/** Compaction started, or refused with a code — same shape as `StartThreadOutcome`. */
export type CompactThreadOutcome = { ok: true; ack: CompactAck } | { ok: false; code: GroupChatAccessFailure }

// Not wrapped in `asWriteResult`: that helper discards the success payload
// (`{ ok: true }` with nothing else), but the caller needs the CompactAck back
// to start polling. Same try/catch `asWriteResult` does internally, kept
// inline for the payload — see model.ts's `compactThread` for the gate.
export const compactGroupChatThread = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }): Promise<CompactThreadOutcome> => {
    try {
      const ack = await compactThread(getRequest(), threadId)
      return { ok: true, ack }
    } catch (error) {
      if (error instanceof GroupChatAccessError) {
        return { ok: false, code: error.code }
      }
      throw error
    }
  })

export const getGroupChatThreadCompactStatus = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }): Promise<CompactStatus> => threadCompactStatus(getRequest(), threadId))

// ── Pinned notes ─────────────────────────────────────────────────────────

export const listMyGroupChatPins = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((groupChatId: string) => groupChatId)
  .handler(async ({ data: groupChatId }): Promise<GroupChatPinSummary[]> => listPins(getRequest(), groupChatId))

// Returns the write result rather than the new pin: the caller reloads the
// list anyway, and the cap refusal is the outcome it actually has to branch on.
export const addGroupChatPin = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; text: string }) => data)
  .handler(
    async ({ data }): Promise<GroupChatWriteResult> =>
      asWriteResult(async () => {
        await addPin(getRequest(), data.groupChatId, data.text)
      }),
  )

export const editGroupChatPin = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { pinId: string; text: string }) => data)
  .handler(
    async ({ data }): Promise<GroupChatWriteResult> =>
      asWriteResult(() => editPin(getRequest(), data.pinId, data.text)),
  )

export const removeGroupChatPin = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((pinId: string) => pinId)
  .handler(
    async ({ data: pinId }): Promise<GroupChatWriteResult> => asWriteResult(() => removePin(getRequest(), pinId)),
  )

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
    async ({ data: threadId }): Promise<GroupChatThreadEntry & { draft: string | null }> =>
      getThreadView(getRequest(), threadId),
  )

// Save (or clear, with an empty string) a thread's composer draft. Fired on
// the same debounce/flush schedule AgentCommandBarHost already drives for the
// 1:1 chat -- see setDraft in use-agent-sessions.ts for the sibling call.
export const setGroupChatThreadDraft = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { threadId: string; draft: string }) => data)
  .handler(async ({ data }): Promise<void> => setThreadDraft(getRequest(), data.threadId, data.draft))

export const deleteGroupChatThread = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }): Promise<void> => deleteThread(getRequest(), threadId))

// Same shape as deleteGroupChatThread (throws a GroupChatAccessError on
// refusal rather than returning one as data) -- useClearControl's contract
// has no slot to display a refusal message differently than any other
// failure, so there is nothing for a refusal-as-data shape to buy here that
// deleteGroupChatThread's own precedent doesn't already cover identically.
export const clearGroupChatThread = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }): Promise<void> => clearThread(getRequest(), threadId))
