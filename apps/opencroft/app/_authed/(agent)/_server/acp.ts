// EVERY export in this file must stay a `createServerFn`. It is imported
// directly by browser components (app-shell.tsx, ai-panel.tsx, the chat hooks),
// so it sits in the client graph on every page, and only the client build's
// stub substitution keeps its server-side import tail out of the browser
// bundle. A single plain exported function here has no stub and ships that tail
// — see the header of acp-impl.ts, which is where plain implementations go.
import { createServerFn } from '@tanstack/react-start'
import type { RecordsWindow } from 'agent-client/pagination'

import {
  cancelLocalImpl,
  ensureLocalSessionImpl,
  findTargetSessionImpl,
  hasActiveTurnImpl,
  type OpenedSession,
  promptLocalImpl,
  tabSessions,
} from '@/app/_authed/(agent)/_server/acp-impl'
import {
  deletePersistedConfigOptions,
  deletePersistedSession,
  writePersistedConfigOption,
  writePersistedSession,
} from '@/app/_authed/(agent)/_server/acp-session-store'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'

export const ensureLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { agentNodeId: string; jobNodeId: string; tabKey: string }) => data)
  .handler(async ({ data }): Promise<OpenedSession> => ensureLocalSessionImpl(data))

// `front` queues the message ahead of anything already held for the session
// when a turn is running (e.g. corrective guidance after a rejected permission).
// `flush` instead delivers everything held together with this message as one
// turn — used after interrupting a turn, so the agent sees the whole picture.
export const promptLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; text: string; front?: boolean; flush?: boolean }) => data)
  .handler(async ({ data }): Promise<void> => promptLocalImpl(data))

export const findTargetSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { baseKey: string }) => data)
  .handler(async ({ data }): Promise<{ sessionId: string } | null> => findTargetSessionImpl(data))

// Drop a message from the session's server-side queue before it's delivered.
// Clients observe the result via the 'queue' snapshot event on the stream.
export const removeQueuedLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    agentClient.removeQueued(data.sessionId, data.id)
  })

export const setLocalMode = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; modeId: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    await agentClient.setMode(data.sessionId, data.modeId)
  })

// Change one of the session's agent-advertised config options (model/effort/
// mode/…). Applies to this session only — never written back into the
// profile the session was started from.
export const setLocalConfigOption = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; configId: string; value: string | boolean }) => data)
  .handler(async ({ data }): Promise<void> => {
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
  })

export const cancelLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }): Promise<void> => cancelLocalImpl(sessionId))

export const hasActiveTurn = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((sessionId: string) => sessionId)
  .handler(async ({ data: sessionId }): Promise<boolean> => hasActiveTurnImpl(sessionId))

export const forgetLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((tabKey: string) => tabKey)
  .handler(async ({ data: tabKey }): Promise<void> => {
    const entry = tabSessions.get(tabKey)
    if (entry) {
      await agentClient.deleteSession(entry.id)
      tabSessions.delete(tabKey)
    }
    // Drop the durable pointer too, so a later restart doesn't resurrect it.
    await deletePersistedSession(tabKey)
    await deletePersistedConfigOptions(tabKey)
  })

// Branch the tab's session into a new one rewound to a user turn (0-based;
// drops that turn and everything after). Re-point the tab at the fork so a
// remount resumes the branch instead of re-creating the original.
export const forkLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { tabKey: string; sessionId: string; dropFromTurn: number }) => data)
  .handler(async ({ data }): Promise<{ sessionId: string } | null> => {
    const meta = await agentClient.forkSession(data.sessionId, data.dropFromTurn)
    if (!meta) {
      return null
    }
    // The fork keeps the same agent, so steering capability carries over. A
    // fork rewinds an already-prompted conversation, so its session is never
    // "new" for envelope purposes.
    tabSessions.set(data.tabKey, {
      id: meta.id,
      canFork: true,
      canSteer: tabSessions.get(data.tabKey)?.canSteer ?? false,
      everPrompted: true,
    })
    // Re-point the durable pointer at the fork so a restart resumes the branch.
    await writePersistedSession(data.tabKey, meta.id)
    return { sessionId: meta.id }
  })

// Tab keys of chat sessions currently blocked on an unresolved permission
// request, tab keys with a turn actively running, and tab keys with a live
// agent process at all (alive is a superset of the other two — see
// aliveSessionKeys) — polled once, from a shared module every chat list
// surface reads (use-session-activity.ts), to set each chat's
// process-visibility indicator: warning (pending), primary (active),
// success (alive but neither), or none (not in `alive`).
export const listSessionActivity = createServerFn({ method: 'GET', strict: { output: false } }).handler(
  async (): Promise<{ pending: string[]; active: string[]; alive: string[] }> => ({
    pending: agentClient.pendingPermissionSessionKeys(),
    active: agentClient.activeSessionKeys(),
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
  .handler(async ({ data: tabKey }): Promise<void> => {
    const entry = tabSessions.get(tabKey)
    if (entry) {
      await agentClient.deleteSession(entry.id)
      tabSessions.delete(tabKey)
    }
  })

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
    async ({ data }): Promise<RecordsWindow | null> =>
      agentClient.getRecordsWindow(data.sessionId, { beforeIndex: data.beforeIndex, records: HISTORY_PAGE_RECORDS }),
  )

export const respondLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { type: 'permission' | 'ask'; requestId: string; optionId?: string; answer?: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    if (data.type === 'permission') {
      agentClient.resolvePermission(data.requestId, data.optionId)
      return
    }
    agentClient.resolveElicitation(data.requestId, data.answer)
  })
