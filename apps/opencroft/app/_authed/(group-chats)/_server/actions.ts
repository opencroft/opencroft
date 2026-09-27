// Thin createServerFn wrappers over model.ts. Authorization is NOT this
// file's job — every export delegates straight to a model function, which
// calls its own membership check. This file exists only to give the browser
// something to call; see admin-users-actions.ts for the same split.

import { createServerFn } from '@tanstack/react-start'
import { getRequest } from '@tanstack/react-start/server'
import type { QueueMode } from 'agent-client/types'

import { refusalAsData } from '@/app/_authed/(agent)/_shared/session-open-refusal'
import { listArtifactsForThread, type ThreadArtifact } from '@/app/_authed/(group-chats)/_server/artifacts'
import type {
  GroupChatPinSummary,
  GroupChatSummary,
  GroupChatThreadSummary,
  JoinGroupChatResult,
  MemberPrincipal,
  StartThreadResult,
  ThreadCompactAck,
  ThreadCompactStatus,
} from '@/app/_authed/(group-chats)/_server/model'
import {
  addMember,
  addPin,
  clearThread,
  compactThread,
  createGroupChat,
  deleteGroupChat,
  deleteThread,
  editPin,
  forkThreadAt,
  getGroupChat,
  getThread,
  // Aliased: the server function below carries the same name.
  joinSpaceGroupChat as joinSpaceChat,
  listGroupChatsForUser,
  listMembers,
  listPins,
  listThreadsInGroupChat,
  openThreadSession,
  removeMember,
  removePin,
  renameGroupChat,
  renameThread,
  resolveGroupChatBySlug,
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
  findThreadViewBySlug,
  findThreadViewInGroupChat,
  getGroupChatDetailView,
  listGroupChatsForUserView,
  listThreadsInGroupChatView,
} from '@/app/_authed/(group-chats)/_server/read-model'
import { getThreadLayout, putThreadLayout } from '@/app/_authed/(group-chats)/_server/thread-layout-access'
import type { ThreadLayout, VersionedThreadLayout } from '@/app/_authed/(group-chats)/_server/thread-layout-store'
import type { DirectoryUser } from '@/app/_authed/(group-chats)/_server/user-directory'
import { listDirectoryUsers } from '@/app/_authed/(group-chats)/_server/user-directory'
import type { GroupChatAccessFailure } from '@/app/_authed/(group-chats)/_shared/access-error'
import { GroupChatAccessError } from '@/app/_authed/(group-chats)/_shared/access-error'
import { slug as slugify } from '@/app/_authed/(server)/_server/types'
import { listSystemSenderIds } from '@/app/_server/message-author'
import { requireSessionServerFn } from '@/app/_server/require-session'

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
  JoinGroupChatResult,
  MemberPrincipal,
  MemberRef,
  StartThreadResult,
  ThreadLayout,
  VersionedThreadLayout,
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

// `slug` is for a caller that owns the address rather than the name -- a space,
// whose chat it has to be able to find again by its OWN slug. Without it the
// address is whatever the display name slugifies to, which is the same string
// only by luck: two spaces both called "Docs" are `docs` and `docs-2`, and the
// second would mint `docs`, fail as taken, and never find a chat of its own.
// The model refuses a slug that is not slug-shaped rather than repairing it.
export const createMyGroupChat = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: string | { name: string; topic?: string; slug?: string }) => data)
  .handler(async ({ data }): Promise<CreateGroupChatResult> => {
    const input = typeof data === 'string' ? { name: data } : data
    try {
      return { ok: true, chat: await createGroupChat(getRequest(), input.name, input.topic, { slug: input.slug }) }
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

// Renaming a thread moves its slug, so it can be refused for a taken name the
// same way creating one can -- which is why it returns a result rather than
// throwing, like every other write whose refusal a person can act on.
export const renameMyGroupChatThread = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { threadId: string; title: string }) => data)
  .handler(
    async ({ data }): Promise<GroupChatWriteResult> =>
      asWriteResult(() => renameThread(getRequest(), data.threadId, data.title)),
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

/**
 * The system senders a grant may name.
 *
 * Served rather than baked into the client so the members dialog offers
 * exactly what `addMember` accepts — one derived population (`listSystemSenderIds`:
 * the author map's identities plus each running extension's own), read on both
 * sides of the request. A copy
 * in the client drifts the moment a trigger is added, and a free-text field
 * drifts on a single keystroke: `system.scripts` is a grant that authorizes
 * nothing, reads in the list as granted, and leaves the pipeline failing with
 * the message that asked for it. Offering the population removes the mistake
 * instead of reporting it.
 *
 * Not chat-scoped, so a session is the whole check — and it IS checked here: a
 * server function is its own callable HTTP endpoint, reachable without going
 * through the page that leads to it, so `_authed` is routing rather than a
 * boundary. Every other export in this file gets the same answer from the
 * model function it delegates to; this one has no model function, so it asks
 * directly.
 */
export const listSystemSenders = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<string[]> => {
    await requireSessionServerFn()
    return listSystemSenderIds()
  },
)

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
 * Fork a thread at one of its messages into a new thread of the same chat and
 * agent: the new session carries the conversation up to that message, the
 * forked message waits in the new thread's composer as a draft, and nothing
 * has been sent. Refusals come back as data for the same reason a send's do —
 * a missing turn and a thread the caller cannot have are one refusal, and a
 * thrown error would reach the browser stripped of the code that says which.
 */
export type ForkThreadOutcome =
  | { ok: true; thread: GroupChatThreadSummary }
  | { ok: false; code: GroupChatAccessFailure }

export const forkGroupChatThreadAt = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { threadId: string; eventIndex: number; draft: string }) => data)
  .handler(async ({ data }): Promise<ForkThreadOutcome> => {
    try {
      const thread = await forkThreadAt(getRequest(), data.threadId, data.eventIndex, data.draft)
      return { ok: true, thread }
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

/**
 * Open this thread's session, addressed by thread id.
 *
 * Deliberately NOT the generic `ensureLocalSession`, which takes a tab key: a
 * thread's key moves when the chat or the thread is renamed, and a screen loaded
 * before that still holds the old one. Opening is the one call that can CREATE a
 * session, so a stale key there does not error -- it produces an empty
 * conversation under an address nothing resolves. The id is stable; the key is
 * read from the row. See `openThreadSession`.
 *
 * A refusal only a person can remove (no key, not signed in) is answered as
 * data, the same as `ensureLocalSession` -- see session-open-refusal.ts.
 */
export const openGroupChatThreadSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }) => refusalAsData(() => openThreadSession(getRequest(), threadId)))

export const sendGroupChatThreadMessage = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator(
    (data: { threadId: string; text: string; front?: boolean; queue: QueueMode; attachments?: string[] }) => data,
  )
  .handler(
    async ({ data }): Promise<SendThreadMessageResult> =>
      asWriteResult(() =>
        sendMessageInThread(getRequest(), data.threadId, data.text, {
          front: data.front,
          queue: data.queue,
          attachments: data.attachments,
        }),
      ),
  )

/** Compaction started, or refused with a code — same shape as `StartThreadOutcome`. */
export type CompactThreadOutcome = { ok: true; ack: ThreadCompactAck } | { ok: false; code: GroupChatAccessFailure }

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
  .handler(async ({ data: threadId }): Promise<ThreadCompactStatus> => threadCompactStatus(getRequest(), threadId))

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

// ── Thread folders ───────────────────────────────────────────────────────

export const getGroupChatThreadLayout = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((groupChatId: string) => groupChatId)
  .handler(async ({ data: groupChatId }): Promise<VersionedThreadLayout> => getThreadLayout(getRequest(), groupChatId))

/**
 * Saved, or refused because someone else saved first.
 *
 * The refusal comes back as DATA and carries the layout that won, for the two
 * reasons this file already returns refusals rather than throwing them: a
 * thrown error crosses the boundary as a bare message, and this one has a
 * payload the caller needs. There is nothing for the caller to do with "your
 * write did not land" on its own — it has to show what did land instead.
 */
export type SaveThreadLayoutResult = { ok: true; version: number } | { ok: false; current: VersionedThreadLayout }

export const saveGroupChatThreadLayout = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; layout: ThreadLayout; expectedVersion: number }) => data)
  .handler(async ({ data }): Promise<SaveThreadLayoutResult> => {
    const version = await putThreadLayout(getRequest(), data.groupChatId, data.layout, data.expectedVersion)
    if (version === null) {
      return { ok: false, current: await getThreadLayout(getRequest(), data.groupChatId) }
    }
    return { ok: true, version }
  })

// The people a member picker offers. Signed-in only; see user-directory.ts for
// why this is its own function rather than a widened admin read.
export const listDirectoryUsersForPicker = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<DirectoryUser[]> => listDirectoryUsers(getRequest()),
)

// ── The embedded surface's reads ─────────────────────────────────────────

/**
 * How an embedded chat's `space` resolves for this caller. Four states,
 * because the surface has something different to offer in each:
 *
 *   `missing`   no chat carries this slug — the surface offers to create it.
 *   `joinable`  a chat carries it, the caller is not in it, and the slug names
 *               a space — the surface offers to Join.
 *   `refused`   anything else the caller cannot have, carrying the collapsed
 *               `not-found` code: what the reader sees is the thread route's
 *               refusal, unchanged.
 *   `ok`        the chat, for a member.
 *
 * `missing` and `joinable` disclose that a slug is taken. That was already
 * observable to any signed-in user through the create path this same surface
 * offers (`createGroupChat` refuses `slug-taken` whoever asks) — see
 * `resolveGroupChatBySlug` for the reasoning, and for why `joinable` is
 * decided on the server rather than by whichever host mounted the component.
 */
export type GroupChatEmbedView =
  | { state: 'missing' }
  | { state: 'joinable' }
  | { state: 'refused'; code: GroupChatAccessFailure }
  | { state: 'ok'; chat: GroupChatDetailView }

export const getGroupChatEmbedView = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((space: string) => space)
  .handler(async ({ data: space }): Promise<GroupChatEmbedView> => {
    const resolved = await resolveGroupChatBySlug(getRequest(), space)
    if (resolved.state === 'missing') {
      return { state: 'missing' }
    }
    if (resolved.state === 'not-a-member') {
      return resolved.joinable ? { state: 'joinable' } : { state: 'refused', code: 'not-found' }
    }
    return { state: 'ok', chat: await getGroupChatDetailView(getRequest(), resolved.chat.id) }
  })

/**
 * Join the space's own chat. Returns its refusal as DATA rather than throwing
 * it, for the reason recorded on `GroupChatAccessError`: a refusal thrown out
 * of a `createServerFn` reaches the browser as a bare message with its `code`
 * stripped, so a caller that has to know which refusal it was cannot be given
 * one that throws.
 */
export const joinSpaceGroupChat = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((space: string) => space)
  .handler(async ({ data: space }): Promise<JoinGroupChatResult> => joinSpaceChat(getRequest(), space))

/**
 * The thread an embedded surface's (agent, id) pair maps to, or null when the
 * first send has yet to create it. `id` is slugified here, the same transform
 * `startThread` applies to the title the surface will start the thread with —
 * one transform on both paths is what keeps lookup and creation naming the
 * same thread. An id that slugifies to nothing finds nothing; the start path
 * is where it earns its explicit `slug-unusable` refusal.
 */
export const findGroupChatEmbedThread = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; agentNodeId: string; id: string }) => data)
  .handler(async ({ data }): Promise<(GroupChatThreadEntry & { draft: string | null }) | null> => {
    const threadSlug = slugify(data.id)
    if (!threadSlug) {
      return null
    }
    return findThreadViewBySlug(getRequest(), data.groupChatId, data.agentNodeId, threadSlug)
  })

/**
 * A thread named by id, inside the chat the reader has open -- the thread
 * route and the embedded surface both open threads this way:
 *
 *   `ok`        the thread.
 *   `gone`      the chat holds no such thread -- it was deleted. Safe to say,
 *               see `findThreadInGroupChat`.
 *   `refused`   the caller is not a member of the chat. Each surface answers
 *               with its chat-level state, which already says what access
 *               the reader has.
 *
 * Returned as data, like `joinSpaceGroupChat`'s refusal, because a thrown one
 * reaches the browser with its code stripped.
 */
export type GroupChatThreadInChat =
  | { state: 'ok'; thread: GroupChatThreadEntry & { draft: string | null } }
  | { state: 'gone' }
  | { state: 'refused' }

export const findGroupChatThreadInChat = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((data: { groupChatId: string; threadId: string }) => data)
  .handler(async ({ data }): Promise<GroupChatThreadInChat> => {
    try {
      const thread = await findThreadViewInGroupChat(getRequest(), data.groupChatId, data.threadId)
      return thread ? { state: 'ok', thread } : { state: 'gone' }
    } catch (error) {
      if (error instanceof GroupChatAccessError) {
        return { state: 'refused' }
      }
      throw error
    }
  })

// A thread's artifacts, for the reader. Gated on the caller's own membership,
// exactly as the thread's messages are — the agent-facing write path is a
// separate function with a separate check (see artifacts.ts on why one function
// taking either identity would be a mistake).
export const listThreadArtifacts = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }): Promise<ThreadArtifact[]> => listArtifactsForThread(getRequest(), threadId))

// Save (or clear, with an empty string) a thread's composer draft, on the
// debounce/flush schedule AgentCommandBarHost drives. The draft belongs to the
// thread row, so it is stored here rather than against the session key.
export const setGroupChatThreadDraft = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { threadId: string; draft: string }) => data)
  .handler(async ({ data }): Promise<void> => setThreadDraft(getRequest(), data.threadId, data.draft))

export const deleteGroupChatThread = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }): Promise<void> => deleteThread(getRequest(), threadId))

// Deleting the container, not a thread in it. Same throwing shape as
// deleteGroupChatThread just above and for the same reason: the only refusal
// this can produce is the shared not-found/non-member one, which a person can
// do nothing differently about, so there is nothing for a refusal-as-data
// shape to carry that the confirm dialog's generic failure line does not
// already say.
//
// UI only, deliberately. There is no agent-facing counterpart on the MCP
// surface: an agent deleting a chat it is a member of -- including the one it
// is running in -- is a footgun with no use case behind it.
export const deleteMyGroupChat = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((groupChatId: string) => groupChatId)
  .handler(async ({ data: groupChatId }): Promise<void> => deleteGroupChat(getRequest(), groupChatId))

// Same shape as deleteGroupChatThread (throws a GroupChatAccessError on
// refusal rather than returning one as data) -- useClearControl's contract
// has no slot to display a refusal message differently than any other
// failure, so there is nothing for a refusal-as-data shape to buy here that
// deleteGroupChatThread's own precedent doesn't already cover identically.
export const clearGroupChatThread = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((threadId: string) => threadId)
  .handler(async ({ data: threadId }): Promise<void> => clearThread(getRequest(), threadId))
