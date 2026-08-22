// EVERY export in this file must stay a `createServerFn`. It is imported
// directly by browser components (app-shell.tsx, ai-panel.tsx, the chat hooks),
// so it sits in the client graph on every page, and only the client build's
// stub substitution keeps its server-side import tail out of the browser
// bundle. A single plain exported function here has no stub and ships that tail
// — see the header of acp-impl.ts, which is where plain implementations go.
import { createServerFn } from '@tanstack/react-start'
import type { RecordsWindow } from 'agent-client/pagination'
import type { Presence, QueueMode } from 'agent-client/types'

import type { WirePromptOrigin } from '@/app/_authed/(agent)/_lib/prompt-origin'
import {
  cancelLocalImpl,
  deliverQueueLocalImpl,
  ensureLocalSessionImpl,
  findTargetSessionImpl,
  forgetLocalSessionImpl,
  hasActiveTurnImpl,
  type OpenedSession,
  promptLocalImpl,
  setPresenceLocalImpl,
  stopLocalImpl,
  stopLocalSessionProcessImpl,
  tabSessions,
} from '@/app/_authed/(agent)/_server/acp-impl'
import { writePersistedConfigOption, writePersistedSession } from '@/app/_authed/(agent)/_server/acp-session-store'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { modeLockedByYolo } from '@/app/_authed/(agent)/_server/yolo-mode-enforcement'
import {
  type CompactAck,
  type CompactStatus,
  type GraphEdgeLike,
  type GraphNodeLike,
  getCompactStatusOnGraph,
  requestCompactOnGraph,
} from '@/app/_authed/(extension-runtime)/_server/stream'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'

export const ensureLocalSession = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { agentNodeId: string; jobNodeId: string; tabKey: string }) => data)
  .handler(async ({ data }): Promise<OpenedSession> => ensureLocalSessionImpl(data))

// `queue` says how this message relates to anything already held: `wait` to be
// delivered on its own when the turn ends, `push` to interrupt and deliver the
// whole queue as one turn. Required — sending into a busy session is a choice,
// not a default. `front` is orthogonal and decides position within the queue.
//
// `origin` is `WirePromptOrigin`, whose only variant names nobody: this is the
// browser's door, so a name stated here would be a name anyone could state.
// promptLocalImpl resolves it against the signed-in session.
export const promptLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator(
    (data: { sessionId: string; text: string; front?: boolean; queue: QueueMode; origin: WirePromptOrigin }) => data,
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

// The space a node lives in, and its full node/edge list -- the same
// per-space scoping requestCompactOnGraph's other caller (the send-message
// node action, host.ts's `compact`) already uses, just resolved from an
// agent node instead of a send-message node.
async function findNodeGraph(nodeId: string): Promise<{ nodes: GraphNodeLike[]; edges: GraphEdgeLike[] } | null> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  for (const summary of registry.list()) {
    const space = registry.getBySlug(summary.slug)
    if (!space) {
      continue
    }
    const nodes = space.graph.nodes as unknown as GraphNodeLike[]
    if (nodes.some((n) => n.id === nodeId)) {
      return { nodes, edges: space.graph.edges as unknown as GraphEdgeLike[] }
    }
  }
  return null
}

// Compact a 1:1 chat's own session -- the graph-based mechanism a
// send-message node action already uses to compact a THIRD party's reachable
// session, exposed here for a chat's own open tab instead. No reachability
// check: this always targets the session the caller already has open, not
// one it is reaching for.
export const compactLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { agentNodeId: string; sessionKey: string }) => data)
  .handler(async ({ data }): Promise<CompactAck> => {
    const graph = await findNodeGraph(data.agentNodeId)
    if (!graph) {
      throw new Error('Agent node not found')
    }
    return requestCompactOnGraph(graph.nodes, graph.edges, data.sessionKey)
  })

export const getLocalCompactStatus = createServerFn({ method: 'GET', strict: { output: false } })
  .inputValidator((sessionKey: string) => sessionKey)
  .handler(async ({ data: sessionKey }): Promise<CompactStatus> => getCompactStatusOnGraph(sessionKey))

// Drop a message from the session's server-side queue before it's delivered.
// Clients observe the result via the 'queue' snapshot event on the stream.
export const removeQueuedLocal = createServerFn({ method: 'POST', strict: { output: false } })
  .inputValidator((data: { sessionId: string; id: string }) => data)
  .handler(async ({ data }): Promise<void> => {
    agentClient.removeQueued(data.sessionId, data.id)
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
    // A fork rewinds an already-prompted conversation, so it carries history.
    await writePersistedSession(data.tabKey, meta.id, true)
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
