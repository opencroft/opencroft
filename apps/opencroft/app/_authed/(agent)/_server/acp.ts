// EVERY export in this file must stay a `createServerFn`. It is imported
// directly by browser components (the group-chat thread route and the chat
// hooks), so it sits in the client graph on every page, and only the client build's
// stub substitution keeps its server-side import tail out of the browser
// bundle. A single plain exported function here has no stub and ships that tail
// — see the header of acp-impl.ts, which is where plain implementations go.
import { createServerFn } from '@tanstack/react-start'
import type { TurnEdit } from 'agent-client/queue-tags'
import type { ElicitationContentValue, Presence, QueueMode } from 'agent-client/types'

import type { AuthoredRecordsWindow } from '@/app/_authed/(agent)/_lib/acp-stream'
import type { WirePromptOrigin } from '@/app/_authed/(agent)/_lib/prompt-origin'
import {
  attachImageImpl,
  attachmentSizesImpl,
  cancelLocalImpl,
  deliverQueueLocalImpl,
  editTurnLocalImpl,
  ensureLocalSessionImpl,
  findTargetSessionImpl,
  forgetLocalSessionImpl,
  hasActiveTurnImpl,
  type OpenedSession,
  promptLocalImpl,
  sessionHistoryPageImpl,
  setPresenceLocalImpl,
  stopLocalImpl,
  stopLocalSessionProcessImpl,
  tabSessions,
} from '@/app/_authed/(agent)/_server/acp-impl'
import { writePersistedConfigOption } from '@/app/_authed/(agent)/_server/acp-session-store'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import type { StoredAttachment } from '@/app/_authed/(agent)/_server/attachment-store'
import { modeLockedByYolo } from '@/app/_authed/(agent)/_server/yolo-mode-enforcement'
import { backgroundWorkSessionKeys } from '@/app/_authed/(background-tasks)/_server/background-work'
import { backgroundTasks } from '@/app/_authed/(background-tasks)/_server/service'

export const ensureLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { agentNodeId: string; tabKey: string }) => data)
  .handler(async ({ data }): Promise<OpenedSession> => ensureLocalSessionImpl(data))

// An image the reader attached, on its way to the store. `data` is base64 with
// no `data:` prefix — what ACP's image block carries, so the payload is never
// re-encoded between here and the harness. What may be attached at all, and how
// large, is the store's to refuse: a limit enforced in the browser is a
// suggestion.
export const attachImage = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { tabKey: string; name: string; mimeType: string; data: string }) => data)
  .handler(async ({ data }): Promise<StoredAttachment> => attachImageImpl(data))

// The stored size of pictures this conversation already holds, for a composer
// showing ones it did not upload itself -- an edited message's. Scoped to the
// tab's conversation; an id from elsewhere is absent from the answer.
export const attachmentSizes = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { tabKey: string; ids: string[] }) => data)
  .handler(async ({ data }): Promise<Record<string, number>> => attachmentSizesImpl(data))

// `queue` says how this message relates to anything already held: `wait` to be
// delivered on its own when the turn ends, `push` to interrupt and deliver the
// whole queue as one turn. Required — sending into a busy session is a choice,
// not a default. `front` is orthogonal and decides position within the queue.
//
// `origin` is `WirePromptOrigin`, whose only variant names nobody: this is the
// browser's door, so a name stated here would be a name anyone could state.
// promptLocalImpl resolves it against the signed-in session.
//
// `attachments` are stored picture ids and nothing more: what they are called
// and whether they belong to this conversation is read server-side, from the
// store.
export const promptLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator(
    (data: {
      sessionId: string
      text: string
      front?: boolean
      queue: QueueMode
      origin: WirePromptOrigin
      attachments?: string[]
    }) => data,
  )
  .handler(async ({ data }): Promise<{ interrupted: boolean }> => promptLocalImpl(data))

// How often this session's agent reads its queue. Remembered, so a session
// reopened after a restart reads at the cadence it was set to rather than
// handing over everything it was holding the moment it comes back.
export const setPresenceLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; presence: Presence }) => data)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await setPresenceLocalImpl(data)
    return { ok: true }
  })

export const findTargetSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { baseKey: string }) => data)
  .handler(async ({ data }): Promise<{ sessionId: string } | null> => await findTargetSessionImpl(data))

// Drop a message from the session's server-side queue before it's delivered.
// Clients observe the result via the 'queue' snapshot event on the stream.
export const removeQueuedLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    agentClient.removeQueued(data.sessionId, data.id)
  })

// Stop one background task, without cancelling the turn. Returns whether the
// stop was taken; clients observe the task's own state change via the
// async_task event on the stream.
//
// The engine stops a task its harness runs, and hands one this host runs back
// to the host's registry. It can do neither for a session it no longer holds,
// so a stop pressed on a host task after its session was unloaded goes to the
// registry directly — the task outlived its session, and so must its stop.
export const stopBackgroundTaskLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; asyncTaskId: string }) => data)
  .handler(async ({ data }): Promise<{ stopped: boolean }> => {
    if (await agentClient.stopAsyncTask(data.sessionId, data.asyncTaskId)) {
      return { stopped: true }
    }
    return { stopped: await backgroundTasks.requestStop(data.asyncTaskId) }
  })

// While YOLO is on, every session is pinned to bypass and mode changes are
// refused here rather than applied and then quietly undone by the enforcement
// pass. Returns the refusal as DATA, not a thrown error: a thrown createServerFn
// error reaches the browser with only its message, leaving the client unable to
// tell a refusal from a transport failure.
export const setLocalMode = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; modeId: string }) => data)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; reason: 'yolo-locked' }> => {
    if (modeLockedByYolo()) {
      return { ok: false, reason: 'yolo-locked' }
    }
    await agentClient.setMode(data.sessionId, data.modeId)
    return { ok: true }
  })

// Change one of the session's agent-advertised config options (model/effort/
// mode/…). Applies to this session only — never written back into the
// profile the session was started from.
export const setLocalConfigOption = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; configId: string; value: string | boolean }) => data)
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; reason: 'yolo-locked' }> => {
    // Modes reach the client twice — as session modes AND as a `mode` config
    // option built from the same list — so the YOLO lock has to hold on both
    // paths, or the selector becomes a way around it. This is the path the UI
    // actually takes (setLocalMode has no callers), which is why the refusal is
    // returned as data rather than swallowed: a caller that cannot tell refused
    // from applied can only present the change as having worked.
    if (data.configId === 'mode' && modeLockedByYolo()) {
      return { ok: false, reason: 'yolo-locked' }
    }
    await agentClient.setConfigOption(data.sessionId, data.configId, data.value)
    // Also persist it per-tab so a later cold-start resume (openLocalSession's
    // session/load path) can replay it — see the comment there. Assumes the
    // sessionId is already in tabSessions (true for every current caller, all
    // of which go through a tab); an override set through any future path
    // that bypasses the tab map would silently skip persistence.
    for (const [tabKey, entry] of tabSessions) {
      if (entry.id === data.sessionId) {
        await writePersistedConfigOption(tabKey, data.configId, data.value)
        break
      }
    }
    return { ok: true }
  })

export const cancelLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }): Promise<void> => cancelLocalImpl(sessionId))

// The reader's Stop, which is not the same thing as a cancel: with unread
// messages held it cancels AND delivers them, because a stop with something
// unsaid is usually a correction rather than an abandonment. Separate from
// cancelLocal so the plain cancel stays available to callers that mean only
// that -- the permission flow's corrective guidance still cancels and queues
// ahead, and must not sweep the queue out while doing it.
export const stopLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }): Promise<{ delivered: number }> => stopLocalImpl(sessionId))

// Deliver everything waiting, now — the Unread section's divider. Distinct
// from stopLocal, which is the reader's Stop and carries its own meaning:
// this adds nothing, cancels nothing on its own and hands the queue over
// exactly as a push would.
export const deliverQueueLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }): Promise<void> => deliverQueueLocalImpl(sessionId))

export const hasActiveTurn = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }): Promise<boolean> => hasActiveTurnImpl(sessionId))

export const forgetLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((tabKey: string) => tabKey)
  .handler(async ({ data: tabKey }): Promise<void> => forgetLocalSessionImpl(tabKey))

// Commit an edited turn: rewind to it and re-send it with the reader's words.
//
// The turn is named by its position in the session's event log — the block id
// the transcript already carries — and never by a count of user turns: the
// browser holds a bounded tail of the conversation, so the two numberings
// disagree the moment anything scrolls off, and an edit keyed on the count
// rewrites whichever message they disagreed about.
//
// `edits` carries WORDS ONLY, each keyed by the position of the message it
// replaces within that turn. Authorship, send times, the interrupt note and
// this app's own context tags are read server-side from the delivered turn —
// this wire cannot state them, exactly as it cannot state a sender on an
// ordinary send (see WirePromptOrigin). Refuses with null when there is no user
// turn at that index, and throws when an edit names a message the turn does not
// have.
export const editTurnLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { tabKey: string; sessionId: string; eventIndex: number; edits: TurnEdit<string>[] }) => data)
  .handler(async ({ data }): Promise<{ sessionId: string } | null> => editTurnLocalImpl(data))

// Tab keys of chat sessions currently blocked on someone (an unresolved
// permission request or an unanswered question), tab keys with a turn actively
// running, tab keys with live background work (a subagent or task still
// running — Working even with no turn open), and tab keys with a live agent process at
// all (alive is a superset of the others — see aliveSessionKeys) — polled
// once, from a shared module every chat list surface reads
// (use-session-activity.ts), to set each chat's process-visibility indicator:
// warning (pending), primary (active/background), success (alive but
// neither), or none (not in `alive`).
export const listSessionActivity = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<{ pending: string[]; active: string[]; background: string[]; alive: string[] }> => ({
    pending: agentClient.awaitingUserSessionKeys(),
    active: agentClient.activeSessionKeys(),
    background: [...backgroundWorkSessionKeys()],
    alive: agentClient.aliveSessionKeys(),
  }),
)

// Stop a session's agent process without closing the chat: ends the ACP
// session (gracefully, or kills the underlying subprocess if nothing else
// shares it — see agentClient.deleteSession) but, unlike forgetLocalSession,
// deliberately keeps the persisted tabKey->sessionId pointer and config
// overrides. The next message to this tab falls through to
// openLocalSession's cold-start session/load path and resumes the same
// session — the chat and its history are untouched.
export const stopProcessLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((tabKey: string) => tabKey)
  .handler(async ({ data: tabKey }): Promise<void> => stopLocalSessionProcessImpl(tabKey))

// How many agent records one press of "load older messages" fetches. Smaller
// than the opening window (acp.stream.ts's INITIAL_HISTORY_RECORDS) because a
// cold open wants enough to read while a deliberate request wants to arrive
// quickly — the reader can simply press again.
//
// It used to be smaller for a different reason: paging was driven by scrolling
// and a large page arrived as a jolt. There is no jolt to avoid now, and the
// figures are a product choice rather than a derivation.
const HISTORY_PAGE_RECORDS = 10

// The "older messages" half of the tail-first + scroll-up pagination pattern
// is a plain request/response fetch against the
// already-replayed, already in-memory event log — no protocol round-trip, no
// SSE. `beforeIndex` is a previous window's `startIndex` (the stream's
// history_end payload for the first call, or an earlier page's for the next).
export const getSessionHistoryPageLocal = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((data: { sessionId: string; beforeIndex: number }) => data)
  .handler(
    async ({ data }): Promise<AuthoredRecordsWindow | null> =>
      sessionHistoryPageImpl(data.sessionId, data.beforeIndex, HISTORY_PAGE_RECORDS),
  )

export const respondLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator(
    (data: {
      type: 'permission' | 'ask'
      requestId: string
      optionId?: string
      answer?: string | Record<string, ElicitationContentValue>
    }) => data,
  )
  .handler(async ({ data }): Promise<void> => {
    if (data.type === 'permission') {
      agentClient.resolvePermission(data.requestId, data.optionId)
      return
    }
    agentClient.resolveElicitation(data.requestId, data.answer)
  })
