// Server-side stream API mirroring the client `Stream<T>` shape so action
// handlers can `getStream(...)` / `broadcast(stream, chunk)` the same way
// browser-side AI nodes (prompt, text-gen, etc.) do today. Broadcasting
// pushes the chunk into local in-process subscribers AND emits a
// `stream_chunk` SSE event scoped to the owning space — the client SSE
// bridge feeds it back into the client stream registry, so existing
// `subscribe(stream, ...)` consumers wake up unchanged.
//
// Each stream keeps a small global ring buffer of the most recent chunks.
// On final chunks the accumulated text is delivered to downstream consumers:
// Log nodes persist it as an entry via `updateNodeData`, and any node whose
// target handle declares a `streamAction` has that action dispatched with the
// text — letting extensions consume a text-stream server-side without core
// knowing the node type.

// The plain implementations, not acp.ts's `createServerFn` wrappers: this
// module is reached from a node action that is already running inside a server
// function's handler, and nesting another one there is unreliable (see
// deliverToSendMessageNode). acp-impl.ts is server-only by construction — see
// its header for why that separation also keeps the client bundle clean.
import {
  cancelLocalImpl,
  ensureLocalSessionImpl,
  findTargetSessionImpl,
  hasActiveTurnImpl,
  promptLocalImpl,
} from '@/app/_authed/(agent)/_server/acp-impl'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { upsertSession } from '@/app/_authed/(agent)/_server/agent-sessions-store'
import { hideSessionByDefault } from '@/app/_authed/(agent)/_server/chat-list-layout-store'
import { composeEnvelope } from '@/app/_authed/(agent)/_shared/message-envelope'
import { updateNodeData } from '@/app/_authed/(extension-runtime)/_server/node-data'
import {
  type AgentContext,
  buildSessionKey,
  isAgentNodeReachable,
  parseSessionKey,
  resolveSessionOnGraph,
  type EdgeLike as SmEdgeLike,
  type NodeLike as SmNodeLike,
  tryParseJsonMessage,
} from '@/app/_authed/(extension-runtime)/_server/send-message-helpers'
import {
  type ContextUsage,
  compactionVerdict,
  toContextUsage,
} from '@/app/_authed/(extension-runtime)/_server/session-context-usage'
import { findExtensionHandle, type NodeMetadata } from '@/app/_authed/(extension-runtime)/_types'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import type { StreamChunkPayload } from '@/lib/sse-events'
import { toastStore } from '@/lib/toast-store'

export interface Stream<T> {
  subscribe(fn: (chunk: T) => void): () => void
  broadcast(chunk: T): void
}

interface StreamMeta {
  spaceId?: string
  nodeId: string
  handleId: string
}

const BUFFER_SIZE = 1000

class StreamImpl<T> implements Stream<T> {
  private handlers = new Set<(chunk: T) => void>()
  private buffer: T[] = []
  private accBuffer = ''
  // Chunk actions dispatch through a per-stream FIFO chain. A detached
  // dispatch per chunk would let dispatches overtake each other — each one
  // awaits registry and manifest loads before reaching the action — and
  // deliver chunks to the downstream action out of order.
  private chunkActionQueue: Promise<void> = Promise.resolve()

  constructor(
    private spaceId: string | undefined,
    private nodeId: string,
    private handleId: string,
  ) {}

  subscribe(fn: (chunk: T) => void): () => void {
    this.handlers.add(fn)
    return () => {
      this.handlers.delete(fn)
    }
  }

  broadcast(chunk: T): void {
    if (this.buffer.length >= BUFFER_SIZE) {
      this.buffer.shift()
    }
    this.buffer.push(chunk)
    for (const h of this.handlers) {
      h(chunk)
    }
    toastStore.broadcast({
      type: 'stream_chunk',
      spaceId: this.spaceId,
      nodeId: this.nodeId,
      handleId: this.handleId,
      chunk: chunk as unknown as StreamChunkPayload,
    })
    if (chunk !== null && typeof chunk === 'object') {
      const record = chunk as Record<string, unknown>
      this.chunkActionQueue = this.chunkActionQueue
        .then(() => dispatchDownstreamChunkActions(this.spaceId, this.nodeId, this.handleId, record))
        .catch((err) => {
          console.error('[stream chunk action] dispatch failed:', err instanceof Error ? err.message : String(err))
        })
    }
    const tc = chunk as unknown as { text?: string; final?: boolean }
    if (typeof tc.text === 'string' && typeof tc.final === 'boolean') {
      this.accBuffer += tc.text
      if (tc.final) {
        const text = this.accBuffer.trim()
        this.accBuffer = ''
        if (text) {
          void persistToDownstreamLogs(this.spaceId, this.nodeId, this.handleId, text)
          void persistToDownstreamSendMessages(this.spaceId, this.nodeId, this.handleId, text)
          void dispatchDownstreamTextActions(this.spaceId, this.nodeId, this.handleId, text)
        }
      }
    }
  }

  snapshot(): T[] {
    return this.buffer.slice()
  }

  meta(): StreamMeta {
    return { spaceId: this.spaceId, nodeId: this.nodeId, handleId: this.handleId }
  }

  clear(): void {
    this.buffer = []
  }
}

export interface GraphEdgeLike {
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

export interface GraphNodeLike {
  id: string
  type?: string
  data?: Record<string, unknown>
}

interface LogEntry {
  at: number
  text: string
}

const DEFAULT_LOG_MAX = 500

async function persistToDownstreamLogs(
  spaceId: string | undefined,
  sourceNodeId: string,
  sourceHandleId: string,
  text: string,
): Promise<void> {
  if (!spaceId) {
    return
  }
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const space = r.getBySlug(spaceId)
  if (!space) {
    return
  }
  const edges = space.graph.edges as unknown as GraphEdgeLike[]
  const nodes = space.graph.nodes as unknown as GraphNodeLike[]
  for (const edge of edges) {
    if (edge.source !== sourceNodeId || edge.sourceHandle !== sourceHandleId) {
      continue
    }
    const target = nodes.find((n) => n.id === edge.target)
    if (target?.type !== 'log') {
      continue
    }
    const max =
      (target.data?.['max'] as number | undefined) && (target.data?.['max'] as number) > 0
        ? (target.data?.['max'] as number)
        : DEFAULT_LOG_MAX
    await updateNodeData(spaceId, target.id, (prev) => {
      const prevEntries = (prev['entries'] as LogEntry[] | undefined) ?? []
      const entry: LogEntry = { at: Date.now(), text }
      const nextEntries =
        prevEntries.length >= max
          ? [...prevEntries.slice(prevEntries.length - max + 1), entry]
          : [...prevEntries, entry]
      return { ...prev, entries: nextEntries }
    })
  }
}

// Shared by the `streamAction` (on completion) and `streamChunkAction` (on every
// chunk) mechanisms below: find downstream nodes whose target handle declares
// the given action field, and dispatch it with the given params. This keeps
// per-integration logic inside the owning extension — core never names
// specific node types.
async function dispatchToHandleAction(
  spaceId: string | undefined,
  sourceNodeId: string,
  sourceHandleId: string,
  actionField: 'streamAction' | 'streamChunkAction',
  params: Record<string, unknown>,
): Promise<void> {
  if (!spaceId) {
    return
  }
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const space = r.getBySlug(spaceId)
  if (!space) {
    return
  }
  const edges = space.graph.edges as unknown as GraphEdgeLike[]
  const nodes = space.graph.nodes as unknown as GraphNodeLike[]
  const outgoing = edges.filter((e) => e.source === sourceNodeId && e.sourceHandle === sourceHandleId)
  if (outgoing.length === 0) {
    return
  }
  // Late import avoids a cycle: node-actions imports getStream from this module.
  const [{ dispatchNodeAction }, { loadAllManifests }] = await Promise.all([
    import('@/app/_authed/(extension-runtime)/_server/node-actions'),
    import('@/app/_authed/(extension-runtime)/_server/loader'),
  ])
  const metaByType = new Map<string, NodeMetadata>()
  for (const manifest of await loadAllManifests()) {
    for (const node of manifest.nodes ?? []) {
      metaByType.set(node.typeId, node)
    }
  }
  for (const edge of outgoing) {
    const target = nodes.find((n) => n.id === edge.target)
    const meta = target?.type ? metaByType.get(target.type) : undefined
    const handle = meta?.handles ? findExtensionHandle(meta.handles, edge.targetHandle ?? '', 'target') : undefined
    const actionId = handle?.[actionField]
    if (!target || !actionId) {
      continue
    }
    try {
      await dispatchNodeAction({ data: { nodeId: target.id, actionId, params } })
    } catch (err) {
      console.error(
        `[stream→${target.type}.${actionId}] dispatch failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
}

// When a text-stream completes, dispatch the accumulated text to any downstream
// node whose target handle declares a `streamAction` in its manifest. The action
// receives the text as `ctx.params.text`.
async function dispatchDownstreamTextActions(
  spaceId: string | undefined,
  sourceNodeId: string,
  sourceHandleId: string,
  text: string,
): Promise<void> {
  await dispatchToHandleAction(spaceId, sourceNodeId, sourceHandleId, 'streamAction', { text })
}

// On every chunk of any stream (not gated on completion), dispatch it to any
// downstream node whose target handle declares a `streamChunkAction`. The
// action receives the chunk's own fields as `ctx.params` — e.g. `{ text, final }`
// for a text-stream chunk. Lets a node do incremental work as a stream arrives
// (e.g. start synthesizing speech sentence-by-sentence) instead of waiting for
// the whole stream to finish.
async function dispatchDownstreamChunkActions(
  spaceId: string | undefined,
  sourceNodeId: string,
  sourceHandleId: string,
  chunk: Record<string, unknown>,
): Promise<void> {
  await dispatchToHandleAction(spaceId, sourceNodeId, sourceHandleId, 'streamChunkAction', chunk)
}

async function persistToDownstreamSendMessages(
  spaceId: string | undefined,
  sourceNodeId: string,
  sourceHandleId: string,
  text: string,
): Promise<void> {
  if (!spaceId) {
    return
  }
  const r = getSpacesRegistry()
  await r.ensureLoaded()
  const space = r.getBySlug(spaceId)
  if (!space) {
    return
  }
  const edges = space.graph.edges as unknown as GraphEdgeLike[]
  const nodes = space.graph.nodes as unknown as GraphNodeLike[]
  for (const edge of edges) {
    if (edge.source !== sourceNodeId || edge.sourceHandle !== sourceHandleId) {
      continue
    }
    const target = nodes.find((n) => n.id === edge.target)
    if (target?.type !== 'send-message') {
      continue
    }
    try {
      await deliverToSendMessageNode(target, nodes, edges, text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[send-message] Failed to send via node ${target.id}:`, msg)
    }
  }
}

// Serialises work per session key. Deliveries for DIFFERENT keys still run
// concurrently; only same-key callers queue, and each sees the state the
// previous one left behind rather than a snapshot taken before it ran.
//
// A promise chain rather than a "first caller wins" guard: both deliveries
// carry different messages and both have to arrive, so the second must wait
// for the first, not be dropped as a duplicate of it.
const sessionKeyLocks = new Map<string, Promise<unknown>>()

// Exported so the ordering it guarantees can be checked directly, rather than
// only through a full delivery that needs a registered space and a live agent.
export async function withSessionKeyLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = sessionKeyLocks.get(key) ?? Promise.resolve()
  // `run` on both settlements: one delivery failing must not poison the queue
  // for everyone behind it, and it must not skip them either.
  const mine = previous.then(run, run)
  const tail = mine.catch(() => {})
  sessionKeyLocks.set(key, tail)
  try {
    return await mine
  } finally {
    // Clear the slot only when nobody queued behind us, so the map doesn't
    // grow an entry per delivery for the lifetime of the process.
    if (sessionKeyLocks.get(key) === tail) {
      sessionKeyLocks.delete(key)
    }
  }
}

// Reuse an existing live session for this key (the node's own remembered
// session, a chat tab the user has open, or the durable pointer) so messages
// land in one stable conversation; only create a fresh session when none
// exists. Shared by the agent:job path below AND group-chat thread delivery
// (via deliverIntoThread) — both need the identical check-then-act, and
// before this converged on it a thread's own open was
// ensureLocalSessionImpl called directly, a second, unguarded copy of the
// same logic.
//
// Serialised per session key: resolving and creating is a check-then-act, and
// two deliveries for one key arriving together would otherwise both find
// nothing and both create. Only this part is serialised — a caller's own
// prompt call stays outside, because it is in flight for the whole turn and
// holding the lock across it would make a second delivery wait out the
// agent's work instead of queueing behind it.
//
// ensureLocalSessionImpl has its OWN in-flight dedup for calls that overlap
// in time, so two truly-simultaneous callers were already coalesced below
// that layer before this existed — checked directly, a concurrency test
// against the real session-opening code cannot tell "guarded here" from
// "only guarded one layer down" apart. What this lock adds beyond that is
// closing the narrower window BETWEEN resolving ("does one already exist?")
// and creating, across two calls that do not overlap tightly enough for the
// lower guard to catch — the same reasoning already applied to the agent:job
// path. The provable, demonstrated gain either way: one delivery-
// serialization primitive instead of two copies that could drift apart.
export async function resolveOrCreateSession(
  sessionKey: string,
  open: { agentNodeId: string; jobNodeId: string; tabKey: string },
): Promise<{ sessionId: string; created: boolean }> {
  return withSessionKeyLock(sessionKey, async () => {
    const existing = await findTargetSessionImpl({ baseKey: sessionKey })
    if (existing?.sessionId) {
      return { sessionId: existing.sessionId, created: false }
    }
    const opened = await ensureLocalSessionImpl(open)
    return { sessionId: opened.sessionId, created: opened.created }
  })
}

/** What `deliverToSendMessageNode` actually delivered to — an agent:job
 *  session or a group-chat thread. A caller
 *  that only cares whether delivery happened can ignore `kind`; one that logs
 *  or reports outcomes reads it to know which fields apply. */
export type SendMessageDeliveryResult =
  | { kind: 'agent'; sessionKey: string; created: boolean; forced: boolean }
  | { kind: 'thread'; threadRef: string; status: 'queued' | 'delivered' }

/**
 * Resolve a thread reference against a running turn and this send-message
 * node's own graph wiring, and either deliver or refuse — the group-chat
 * counterpart to the agent:job path below. Registered by group-chats' own
 * server startup (registerThreadDeliveryResolver), NOT imported here: this
 * module knows nothing about group chats specifically, the same reason
 * StandingContextResolver exists rather than an import of group-chat code
 * (see registerStandingContextResolver above).
 *
 * The reachability predicate is passed IN rather than the resolver reading
 * the graph itself, because the graph belongs to the caller (this node's own
 * space) — a thread's target agent must be checked against the SAME
 * authority reachablePairs grants the agent:job path, and that authority is
 * a property of the node doing the sending, not of the thread being sent to.
 */
export type ThreadDeliveryOutcome =
  | { status: 'queued' | 'delivered' }
  | { status: 'not-found' }
  | { status: 'not-reachable' }
export type ThreadDeliveryResolver = (
  threadRef: string,
  text: string,
  isReachable: (agentNodeId: string) => boolean,
) => Promise<ThreadDeliveryOutcome>

// globalThis-backed like compactJobs further down (and every other
// server-lifetime singleton in this app — see globalForSpaces,
// globalForReaper, globalForScheduler, globalForStartup): a plain
// module-scoped array here silently resets to empty whenever Vite's dev SSR
// gives this module a fresh instance because some other file that imports it
// changed, while this registry's only writer (server/startup.ts's
// once-per-process ensureServerStarted) never runs a second time to
// repopulate it. Confirmed as the cause of a real failure: the
// group_chat_compact MCP path resolved through a post-hot-reload instance of
// this module with an empty resolvers array ("No agent/job resolved for
// session"), while the UI ring's Compact button kept using the instance from
// server boot. Applying the same fix here since the mechanism is identical.
// globalThis-backed like compactJobs further down (and every other
// server-lifetime singleton in this app — see globalForSpaces,
// globalForReaper, globalForScheduler, globalForStartup): a plain
// module-scoped array here silently resets to empty whenever Vite's dev SSR
// gives this module a fresh instance because some other file that imports it
// changed, while this registry's only writer (server/startup.ts's
// once-per-process ensureServerStarted) never runs a second time to
// repopulate it. Confirmed as the cause of a real failure: the
// group_chat_compact MCP path resolved through a post-hot-reload instance of
// this module with an empty resolvers array ("No agent/job resolved for
// session"), while the UI ring's Compact button kept using the instance from
// server boot. Applying the same fix here since the mechanism is identical.
const globalForThreadDelivery = globalThis as unknown as {
  __THREAD_DELIVERY_RESOLVERS__?: ThreadDeliveryResolver[]
}
if (!globalForThreadDelivery.__THREAD_DELIVERY_RESOLVERS__) {
  globalForThreadDelivery.__THREAD_DELIVERY_RESOLVERS__ = []
}
const threadDeliveryResolvers = globalForThreadDelivery.__THREAD_DELIVERY_RESOLVERS__

export function registerThreadDeliveryResolver(resolver: ThreadDeliveryResolver): void {
  if (!threadDeliveryResolvers.includes(resolver)) {
    threadDeliveryResolvers.push(resolver)
  }
}

// The one delivery mechanism behind every path that hands a message to a
// SendMessage node — the `text-in` stream wiring above, and
// the node's own `send` action via `host.sendMessage.send`. Resolves the
// target agent/job (payload fields win, the node's own defaults fill the
// rest), reuses a live session or creates one (registering + hiding it by
// default only on a genuine creation), and composes the
// envelope with instructions/task context gated on that same `created` flag
// too — so every caller gets identical session and envelope
// semantics, not a re-implementation of them. `force` is part of the
// same shared payload schema, so either entry point can carry it, and so
// is `thread` — mutually exclusive with agent/job/key/session, checked
// before either branch runs so a caller naming both gets a clear refusal
// instead of one silently winning.
export async function deliverToSendMessageNode(
  target: GraphNodeLike,
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
  text: string,
): Promise<SendMessageDeliveryResult | null> {
  const parsed = tryParseJsonMessage(text)
  if (parsed?.thread) {
    if (parsed.agent || parsed.job || parsed.key || parsed.session) {
      throw new Error('A message may target a thread or an agent/job session, not both')
    }
    const threadRef = parsed.thread.trim()
    const isReachable = (agentNodeId: string) =>
      isAgentNodeReachable(nodes as unknown as SmNodeLike[], edges as unknown as SmEdgeLike[], agentNodeId)
    let outcome: ThreadDeliveryOutcome = { status: 'not-found' }
    for (const resolver of threadDeliveryResolvers) {
      outcome = await resolver(threadRef, parsed.message, isReachable)
      if (outcome.status !== 'not-found') {
        break
      }
    }
    if (outcome.status === 'not-found' || outcome.status === 'not-reachable') {
      throw new Error(`Thread not reachable from this node: ${threadRef || '(empty)'}`)
    }
    return { kind: 'thread', threadRef, status: outcome.status }
  }

  const route = resolveRoute(text, target, nodes, edges)
  if (!route) {
    return null
  }

  const { sessionId, created } = await resolveOrCreateSession(route.sessionKey, {
    agentNodeId: route.ctx.agentNodeId,
    jobNodeId: route.ctx.jobNodeId,
    tabKey: route.sessionKey,
  })
  if (created) {
    // Register in the shared registry (keyed by the node's base session key)
    // so the node-driven conversation shows up in the chat list and is
    // resumable on every device, like a UI-started chat.
    await upsertSession({
      key: route.sessionKey,
      agentNodeId: route.ctx.agentNodeId,
      agentName: route.ctx.agentName,
      jobNodeId: route.ctx.jobNodeId,
      jobName: route.ctx.jobName,
      title: route.title,
      createdAt: Date.now(),
    }).catch(() => {})
    // A dispatch-created session is registered but never activated by the
    // user — the sidebar shows active chats, not existing ones, so
    // it starts hidden.
    await hideSessionByDefault(route.sessionKey).catch(() => {})
  }

  // `force`: interrupt an in-flight turn instead of waiting behind it.
  // cancelLocal only signals the agent to stop — it doesn't touch activeTurns
  // or the queue itself; whatever ends the cancelled turn's in-flight prompt
  // is what actually drains it (see agent-client's settleTurn). Only
  // meaningful against a session that already has a turn running, so `forced`
  // reports honestly: a force call against an idle or brand-new session never
  // claims to have interrupted anything.
  let forced = false
  if (route.force) {
    forced = hasActiveTurnImpl(sessionId)
    if (forced) {
      await cancelLocalImpl(sessionId)
    }
  }

  // Automated senders never include the selected-node/space system context
  // (chat-only); task context + instructions are session-scoped, so only a
  // freshly created ACP session gets them.
  const message = composeEnvelope(route.message, {
    sessionInit: { jobContext: route.ctx.jobContext, instructions: route.ctx.instructions },
    isNewSession: created,
  })

  // Not `front`: activeTurns is still >0 the instant this call is made (the
  // cancel above hasn't resolved yet), so this lands at the END of whatever's
  // already queued — queued messages first, then this one, which is the order a
  // force wants. `flush` is what then delivers them together as one turn once
  // the cancelled turn settles, instead of one per turn: a force is a push, and
  // draining one at a time would have the agent act on each stale message
  // before it ever reached this one.
  await promptLocalImpl({ sessionId, text: message, flush: route.force })
  return { kind: 'agent', sessionKey: route.sessionKey, created, forced }
}

// Nothing guarantees the compaction is observable when the prompt call returns,
// on either of two counts:
//
//   - `agentClient.prompt()` resolves once the prompt has been DISPATCHED, not
//     once the turn ends. deliverPrompt fires `connection.prompt()` with `void`
//     and lets settleTurn release the turn when it later resolves.
//   - Usage arrives as a separate ACP session update, and the protocol does not
//     order that against the prompt response.
//
// So the turn is waited out here instead — but NOT by polling activeTurns
// (hasActiveTurnImpl), which was this function's original approach and is
// unsound whenever anything else was sent to the session while the dispatched
// turn ran. A prompt arriving mid-turn is held (agent-client's queue), and
// settleTurn drains the next held prompt SYNCHRONOUSLY, in the same tick it
// decrements activeTurns to zero — so a caller polling that counter can never
// observe the true-zero instant between "this turn ended" and "the next queued
// one started"; it just sees activeTurns stay above zero and keeps waiting,
// now for a turn it has no stake in. Two consequences follow, and both were
// observed: the usage read meant to bracket the compaction ALONE
// lands after that unrelated turn too, corrupting the verdict; and because
// `promptLocalImpl` only awaits DISPATCH, never delivery (see above), the
// restore was reported sent the instant it was handed off, whether or not its
// own turn ever actually finished.
//
// Waiting for a specific event sidesteps the race: a session never runs two
// turns at once — prompt() only calls deliverPrompt when activeTurns was
// already zero, everything else queues (see prompt() in agent-client.ts) — so
// turn_end/error events after a dispatch arrive in the exact order turns were
// (or will be) delivered. That makes a dispatch's own outcome countable even
// when it lands on a session that is not idle: if something is already
// running, `dispatch`'s prompt queues behind it rather than starting
// immediately, so its terminal event is the SECOND one to arrive, not the
// first — and however many more turns were already queued ahead of it don't
// change that count, because `front: true` (used for the restore below) puts
// a queued prompt at the head of whatever else is waiting, immediately behind
// only the turn currently running. `hasActiveTurnImpl` is read once, right
// before dispatch, to decide how many terminal events to skip; like the
// pre-flight check in this function's caller, that narrows the race rather
// than closing it (a turn could still start in the gap between the read and
// the dispatch landing), which is the same trade this file already makes
// elsewhere for the same reason: closing it fully needs prompt() to report
// queued-versus-delivered, its own separate work.
//
// Subscribing from the tail (not fromIndex 0, the default) matters too:
// subscribe() replays a session's full history to a new subscriber before
// going live, and an old turn_end from long before this dispatch would
// otherwise be counted as one of the events being waited out.
const TURN_SETTLE_TIMEOUT_MS = 5 * 60_000

export type DispatchedTurnOutcome = 'finished' | 'interrupted' | 'timeout'

export async function awaitDispatchedTurn(
  sessionId: string,
  dispatch: () => Promise<void>,
): Promise<DispatchedTurnOutcome> {
  const turnsAhead = hasActiveTurnImpl(sessionId) ? 1 : 0
  const tail = agentClient.getEventsWindow(sessionId, { turns: 1 })
  const fromIndex = tail ? tail.startIndex + tail.events.length : 0

  let seen = 0
  let settle: (outcome: DispatchedTurnOutcome) => void = () => {}
  const outcome = new Promise<DispatchedTurnOutcome>((resolve) => {
    settle = resolve
  })
  const unsubscribe = agentClient.subscribe(
    sessionId,
    (event) => {
      if (event.kind !== 'turn_end' && event.kind !== 'error') {
        return
      }
      if (seen < turnsAhead) {
        seen += 1
        return
      }
      settle(
        event.kind === 'error' || event.stopReason === 'cancelled' || event.stopReason === 'resumed'
          ? 'interrupted'
          : 'finished',
      )
    },
    { fromIndex },
  )
  try {
    await dispatch()
    let resolveTimeout: (outcome: DispatchedTurnOutcome) => void = () => {}
    const timeout = new Promise<DispatchedTurnOutcome>((resolve) => {
      resolveTimeout = resolve
    })
    const timer = setTimeout(() => resolveTimeout('timeout'), TURN_SETTLE_TIMEOUT_MS)
    const result = await Promise.race([outcome, timeout])
    clearTimeout(timer)
    return result
  } finally {
    unsubscribe()
  }
}

// Appended after the re-delivered session-init block (see performCompact).
// Written to read as a trailing line under the instructions themselves, because
// composeEnvelope puts the session-init parts ahead of the message.
const REINSTRUCT_NOTE =
  'The task context and instructions above are the ones this session was started with. Compaction has just summarised this conversation and dropped the original messages, including the ones that carried them — so they are repeated here. Re-read them and follow them for the rest of this session, including re-loading anything they tell you to load.'

// Compact a live session's context, then give it back the instructions the
// compaction dropped.
//
// Compaction replaces the conversation with a summary. The session-init
// envelope — the agent's task context and standing instructions — is delivered
// exactly once, on the first message of a session (see composeEnvelope's
// `isNewSession`), so it is in those dropped messages and nothing re-sends it.
// The instructions are therefore re-delivered here rather than merely referred
// to: after compaction there is nothing left in context for a bare "re-read
// your instructions" to point at.
//
// Re-sending lives inside this function on purpose. Compaction without it
// leaves an agent that has quietly lost its instructions, which is the failure
// this whole action exists to prevent — so it must not be something a caller
// can forget to do, or do differently.
//
// The whole sequence — read, compact, read, judge, then restore — is here for
// the same reason. Both reads have to bracket the compaction ALONE: measuring
// after the restore would score the re-sent envelope's tokens against the
// compaction and report failure precisely when compaction had worked. And the
// restore has to consult the verdict, because the harness that has no
// `/compact` answers it as an ordinary message: appending a full instruction
// envelope on top of that would leave an action whose job is to shrink a
// context having grown it on its own failure path.
// Assumes the session is ALREADY idle — the caller (runCompactJob, below) is
// what guarantees that; this function never checks or waits, so it must never
// be called against a session that might still be running a turn.
//
export interface CompactResult {
  sessionKey: string
  // Usage bracketing the compaction alone — both read before the instruction
  // restore, so the restore's own tokens are never scored against it. Same
  // null-means-unknown rule as SessionSummary.contextUsage.
  contextUsageBefore: ContextUsage | null
  contextUsageAfter: ContextUsage | null
  // Whether the held context actually shrank; null when it cannot be told.
  // Never inferred from the command having been delivered without an error —
  // see compactionVerdict.
  compacted: boolean | null
  // Whether the session actually finished reading the re-sent instructions —
  // not merely whether they were handed to the connection (those are
  // different moments, and conflating them is how a caller ends up
  // believing a session is primed when it silently is not). False when there
  // were none to re-send, when `compacted` is false — a harness that answered
  // `/compact` as an ordinary message did not drop them, so appending them
  // again would only grow the context this action exists to shrink — and when
  // the restore was sent but its own turn was interrupted or never settled.
  instructionsRestored: boolean
}

// A source of standing context for sessions the graph cannot resolve at all —
// a group-chat thread has no node/edge presence, but still holds an agent
// worth restoring after compaction. Registered explicitly (see
// server/startup.ts) rather than as an import-time side effect, and
// deliberately without this module naming group chats or any other owner: it
// only knows that *something* may claim a given session key prefix.
export interface StandingContext {
  jobContext: string
  instructions: string[]
}
export type StandingContextResolver = (sessionKey: string) => Promise<StandingContext | null>

// globalThis-backed — see registerThreadDeliveryResolver's header just above
// for why (same registration mechanism, same startup.ts writer, same
// Vite-dev-SSR module-reinstantiation hazard). This is the registry whose
// empty-after-reload state actually produced the group_chat_compact failure.
// globalThis-backed — see registerThreadDeliveryResolver's header just above
// for why (same registration mechanism, same startup.ts writer, same
// Vite-dev-SSR module-reinstantiation hazard). This is the registry whose
// empty-after-reload state actually produced the group_chat_compact failure.
const globalForStandingContext = globalThis as unknown as {
  __STANDING_CONTEXT_RESOLVERS__?: StandingContextResolver[]
}
if (!globalForStandingContext.__STANDING_CONTEXT_RESOLVERS__) {
  globalForStandingContext.__STANDING_CONTEXT_RESOLVERS__ = []
}
const standingContextResolvers = globalForStandingContext.__STANDING_CONTEXT_RESOLVERS__

export function registerStandingContextResolver(resolver: StandingContextResolver): void {
  if (!standingContextResolvers.includes(resolver)) {
    standingContextResolvers.push(resolver)
  }
}

// The graph first — unchanged behaviour for every `agent:*` session — then
// each registered resolver in turn. First match wins; a key nobody claims
// resolves to null exactly as resolveSessionOnGraph alone did before this.
async function resolveStandingContext(
  sessionKey: string,
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
): Promise<StandingContext | null> {
  const graphCtx = resolveSessionOnGraph(sessionKey, nodes as unknown as SmNodeLike[], edges as unknown as SmEdgeLike[])
  if (graphCtx) {
    return { jobContext: graphCtx.jobContext, instructions: graphCtx.instructions }
  }
  for (const resolver of standingContextResolvers) {
    const resolved = await resolver(sessionKey)
    if (resolved) {
      return resolved
    }
  }
  return null
}

// The guard this replaced used to refuse a working/waiting session outright,
// because a prompt sent into a busy session is QUEUED rather than delivered,
// which made compaction unsafe there in a way that no amount of waiting
// fixed: a concurrent `force` send interrupting the in-flight turn drains the
// whole queue as one prompt (see agent-client's settleTurn), joining each
// entry with a `[message N of M]` prefix — a queued `/compact` no longer
// begins with a slash once joined like that, so the harness reads it as
// conversational text instead of a command, and the compaction silently
// never happens. waitUntilIdle sidesteps this the same way the old guard did
// — by never putting `/compact` in that queue at all — while still letting
// the request wait instead of being refused.
async function performCompact(
  sessionId: string,
  sessionKey: string,
  resolveContext: () => Promise<StandingContext | null>,
): Promise<CompactResult> {
  const readUsage = (): ContextUsage | null =>
    toContextUsage(agentClient.listSessions().find((m) => m.sessionKey === sessionKey)?.usage)

  const contextUsageBefore = readUsage()
  // Sent raw: a leading slash marks a command, and composeEnvelope passes those
  // through unwrapped anyway.
  const compactOutcome = await awaitDispatchedTurn(sessionId, () => promptLocalImpl({ sessionId, text: '/compact' }))
  // Read only once /compact's OWN turn has actually finished. 'interrupted'
  // (cancelled, the connection dying mid-turn, or a plain error) and 'timeout'
  // both leave usage unknown rather than reporting a stale or partial figure as
  // if it were the post-compaction one — deliberately: a cancelled or errored
  // compaction did not reliably shrink anything, so treating its usage as a
  // trustworthy "after" reading could report a false compaction, and the whole
  // point of `compacted === false` skipping the restore is that it must never
  // be wrong in that direction.
  const contextUsageAfter = compactOutcome === 'finished' ? readUsage() : null
  const compacted = compactionVerdict(contextUsageBefore, contextUsageAfter)

  // Skip on false, the observed-failure case above — before even resolving
  // what to restore, since there is nothing to do with it.
  if (compacted === false) {
    return { sessionKey, contextUsageBefore, contextUsageAfter, compacted, instructionsRestored: false }
  }

  // Resolved fresh HERE, not the snapshot requestCompactOnGraph saw when this
  // job was queued: a group chat's topic/pins (or, for a graph session, wired
  // instructions) can change while the job waits its turn, and what gets
  // restored is what is true NOW — see groupChatStandingContext's header for
  // why that is what makes pins survive compaction by construction rather
  // than by luck. For a graph session this recomputes from the same node/edge
  // snapshot requestCompactOnGraph already had, so nothing observable changes
  // there. A session whose context resolves to nothing at restore time (its
  // owner deleted meanwhile) safely skips the restore instead of sending
  // stale or empty text.
  const restoreCtx = await resolveContext()
  // Restore on true (it worked, and the instructions went with the dropped
  // messages) and on null (cannot tell — re-sending is the safe direction: a
  // redundant envelope costs tokens, a missing one costs the agent its
  // instructions).
  const hasInstructions =
    Boolean(restoreCtx?.jobContext?.trim()) || (restoreCtx?.instructions ?? []).some((i) => i.trim())
  if (!restoreCtx || !hasInstructions) {
    return { sessionKey, contextUsageBefore, contextUsageAfter, compacted, instructionsRestored: false }
  }
  const restore = composeEnvelope(REINSTRUCT_NOTE, {
    sessionInit: { jobContext: restoreCtx.jobContext, instructions: restoreCtx.instructions },
    isNewSession: true,
  })
  // `front: true`: if anything auto-drained into a turn while /compact's own
  // turn was settling (see this function's header and awaitDispatchedTurn),
  // that turn may still be running here. Without `front`, the restore would
  // join the tail of whatever else is already queued behind it and could wait
  // arbitrarily long to even start; `front` guarantees it is the very next
  // thing delivered once the current turn ends, which is also the assumption
  // awaitDispatchedTurn's turn-counting relies on.
  const restoreOutcome = await awaitDispatchedTurn(sessionId, () =>
    promptLocalImpl({ sessionId, text: restore, front: true }),
  )
  // Honestly reflects whether the agent actually finished reading the restore,
  // not merely whether it was handed to the connection — see this function's
  // header comment for why dispatch and delivery are not the same moment and
  // why silently conflating them is worth avoiding.
  return {
    sessionKey,
    contextUsageBefore,
    contextUsageAfter,
    compacted,
    instructionsRestored: restoreOutcome === 'finished',
  }
}

// One compact job per session at a time — see requestCompactOnGraph. In-memory
// only, same as every other live-session fact in this codebase (agent-client's
// own sessions included): a restart drops it, and there is nothing to resume,
// because a pending job that has not dispatched anything yet has no side
// effect to pick back up.
interface CompactJob {
  state: 'pending' | 'running' | 'done' | 'error'
  requestedAt: number
  startedAt: number | null
  finishedAt: number | null
  result: CompactResult | null
  error: string | null
}

export interface CompactAck {
  sessionKey: string
  accepted: true
  // True when this call joined an already-pending/running job instead of
  // starting a new one — the duplicate-protection signal: a caller that
  // re-fires after a timeout learns it did not start a second compaction.
  coalesced: boolean
  state: 'pending' | 'running'
}

export interface CompactStatus {
  sessionKey: string
  state: 'never-requested' | CompactJob['state']
  requestedAt?: number
  startedAt?: number
  finishedAt?: number
  result?: CompactResult
  error?: string
}

const globalForCompact = globalThis as unknown as { __COMPACT_JOBS__?: Map<string, CompactJob> }
if (!globalForCompact.__COMPACT_JOBS__) {
  globalForCompact.__COMPACT_JOBS__ = new Map()
}
const compactJobs = globalForCompact.__COMPACT_JOBS__

// Resolves once the session has no turn in flight right now — never sends
// anything, so it can never be what interrupts a turn. Loops rather than
// resolving on the first turn_end/error: agent-client drains its own queue
// SYNCHRONOUSLY, in the same tick a turn settles (see awaitDispatchedTurn's
// header for the full race), so a turn already queued ahead of this request
// can be running again before this function's subscriber even gets to react
// to the event that just fired. Re-checking hasActiveTurnImpl after every
// settle, and re-subscribing from a fresh tail if it is still true, is what
// makes this converge on a genuinely idle moment instead of a stale one.
async function waitUntilIdle(sessionId: string): Promise<void> {
  while (hasActiveTurnImpl(sessionId)) {
    await new Promise<void>((resolve) => {
      const tail = agentClient.getEventsWindow(sessionId, { turns: 1 })
      const fromIndex = tail ? tail.startIndex + tail.events.length : 0
      const unsubscribe = agentClient.subscribe(
        sessionId,
        (event) => {
          if (event.kind !== 'turn_end' && event.kind !== 'error') {
            return
          }
          unsubscribe()
          resolve()
        },
        { fromIndex },
      )
    })
  }
}

async function runCompactJob(
  sessionId: string,
  sessionKey: string,
  resolveContext: () => Promise<StandingContext | null>,
  job: CompactJob,
): Promise<void> {
  try {
    await waitUntilIdle(sessionId)
    job.state = 'running'
    job.startedAt = Date.now()
    job.result = await performCompact(sessionId, sessionKey, resolveContext)
    job.state = 'done'
  } catch (err) {
    job.state = 'error'
    job.error = err instanceof Error ? err.message : String(err)
  } finally {
    job.finishedAt = Date.now()
  }
}

// Entry point for the `compact` action: accepts the request and returns
// immediately, never holding the caller for the compaction itself. Nothing is
// sent into the session while a turn is running (see waitUntilIdle/
// performCompact above), so this can never be what interrupts one, which is
// what makes "queue behind the turn" true here rather than just "queue the
// timeout".
//
// `nodes`/`edges` may be empty — a session with no graph presence at all
// (a group-chat thread) resolves purely through a registered
// StandingContextResolver instead; see resolveStandingContext above.
export async function requestCompactOnGraph(
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
  sessionKey: string,
): Promise<CompactAck> {
  const ctx = await resolveStandingContext(sessionKey, nodes, edges)
  if (!ctx) {
    throw new Error(`No agent/job resolved for session: ${sessionKey}`)
  }
  // Only a session with a live process holds context to compact. An offline
  // one has nothing in memory — say so rather than silently starting a new
  // session and "compacting" that. Nothing to wait for either, so this stays
  // a synchronous error rather than a queued job.
  const existing = await findTargetSessionImpl({ baseKey: sessionKey })
  if (!existing) {
    throw new Error(`Session has no live process, so there is no context to compact: ${sessionKey}`)
  }

  const current = compactJobs.get(sessionKey)
  if (current && (current.state === 'pending' || current.state === 'running')) {
    return { sessionKey, accepted: true, coalesced: true, state: current.state }
  }

  const job: CompactJob = {
    state: 'pending',
    requestedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  }
  compactJobs.set(sessionKey, job)
  // Deliberately not awaited — the whole point is that the caller does not
  // wait for this. runCompactJob owns its own errors (see its try/catch), so
  // this can never surface as an unhandled rejection.
  void runCompactJob(existing.sessionId, sessionKey, () => resolveStandingContext(sessionKey, nodes, edges), job)
  return { sessionKey, accepted: true, coalesced: false, state: 'pending' }
}

// Entry point for the `compactStatus` action — the queryable signal that a
// compact actually ran, since the caller no longer gets the result back from
// the call that requested it.
export function getCompactStatusOnGraph(sessionKey: string): CompactStatus {
  const job = compactJobs.get(sessionKey)
  if (!job) {
    return { sessionKey, state: 'never-requested' }
  }
  return {
    sessionKey,
    state: job.state,
    requestedAt: job.requestedAt,
    startedAt: job.startedAt ?? undefined,
    finishedAt: job.finishedAt ?? undefined,
    result: job.result ?? undefined,
    error: job.error ?? undefined,
  }
}

interface SendMessageNodeData {
  defaultAgent?: string
  defaultJob?: string
  titleOverride?: string
}

interface RouteResolution {
  sessionKey: string
  message: string
  ctx: AgentContext
  title: string
  force: boolean
}

function resolveRoute(
  text: string,
  target: GraphNodeLike,
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
): RouteResolution | null {
  const smNodes = nodes as unknown as SmNodeLike[]
  const smEdges = edges as unknown as SmEdgeLike[]
  const data = (target.data ?? {}) as SendMessageNodeData

  // Input is either a JSON envelope `{ agent?, job?, key?, title?, message }` or plain text.
  const parsed = tryParseJsonMessage(text)
  const message = parsed ? parsed.message : text

  // A legacy `session` string ("agent:<agent>:<job>") supplies agent/job when the
  // dedicated fields are absent.
  const legacy = parsed?.session ? parseSessionKey(parsed.session) : null

  // Payload fields win; the node's configured defaults fill any that are omitted.
  const agentName = parsed?.agent || legacy?.agentSlug || data.defaultAgent || ''
  const jobName = parsed?.job || legacy?.jobSlug || data.defaultJob || ''
  if (!agentName.trim() || !jobName.trim()) {
    // Nothing resolvable to route to — drop silently.
    return null
  }

  // The optional key widens the session identity so one agent+job can hold several
  // stable, independent sessions (one per key); it does not change which agent/job
  // nodes the session binds to.
  const sessionKey = buildSessionKey(agentName, jobName, parsed?.key)
  const ctx = resolveSessionOnGraph(sessionKey, smNodes, smEdges)
  if (!ctx) {
    return null
  }

  // Applied only when the session is first created (see caller). Payload title wins
  // over the node's override, then falls back to the job name.
  const title = parsed?.title || (data.titleOverride || '').trim() || ctx.jobName

  return { sessionKey, message, ctx, title, force: parsed?.force === true }
}

const g = globalThis as Record<string, unknown>
if (!g.__STREAM_REGISTRY__) {
  g.__STREAM_REGISTRY__ = new Map<string, StreamImpl<unknown>>()
}
const registry = g.__STREAM_REGISTRY__ as Map<string, StreamImpl<unknown>>

function keyFor(nodeId: string, handleId: string): string {
  return `${nodeId}::${handleId}`
}

export function getStream<T>(spaceId: string | undefined, nodeId: string, handleId: string): Stream<T> {
  const key = keyFor(nodeId, handleId)
  let impl = registry.get(key)
  if (!impl) {
    impl = new StreamImpl<unknown>(spaceId, nodeId, handleId)
    registry.set(key, impl)
  }
  return impl as unknown as Stream<T>
}

export function subscribe<T>(stream: Stream<T>, fn: (chunk: T) => void): () => void {
  return stream.subscribe(fn)
}

export function broadcast<T>(stream: Stream<T>, chunk: T): void {
  stream.broadcast(chunk)
}

export interface BufferedStream {
  nodeId: string
  handleId: string
  chunks: StreamChunkPayload[]
}

export function listBufferedStreams(spaceId: string | undefined): BufferedStream[] {
  const result: BufferedStream[] = []
  for (const impl of registry.values()) {
    const meta = impl.meta()
    if (spaceId !== undefined && meta.spaceId !== undefined && meta.spaceId !== spaceId) {
      continue
    }
    const chunks = impl.snapshot() as StreamChunkPayload[]
    if (chunks.length === 0) {
      continue
    }
    result.push({ nodeId: meta.nodeId, handleId: meta.handleId, chunks })
  }
  return result
}
