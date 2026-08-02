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
} from '@/app/(agent)/_server/acp-impl'
import { agentClient } from '@/app/(agent)/_server/agent-client-instance'
import { upsertSession } from '@/app/(agent)/_server/agent-sessions-store'
import { hideSessionByDefault } from '@/app/(agent)/_server/chat-list-layout-store'
import { composeEnvelope } from '@/app/(agent)/_shared/message-envelope'
import { updateNodeData } from '@/app/(extension-runtime)/_server/node-data'
import {
  type AgentContext,
  buildSessionKey,
  parseSessionKey,
  resolveSessionOnGraph,
  type EdgeLike as SmEdgeLike,
  type NodeLike as SmNodeLike,
  tryParseJsonMessage,
} from '@/app/(extension-runtime)/_server/send-message-helpers'
import {
  type ContextUsage,
  compactionVerdict,
  toContextUsage,
} from '@/app/(extension-runtime)/_server/session-context-usage'
import { findExtensionHandle, type NodeMetadata } from '@/app/(extension-runtime)/_types'
import { getSpacesRegistry } from '@/app/(space)/_server/store'
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
    import('@/app/(extension-runtime)/_server/node-actions'),
    import('@/app/(extension-runtime)/_server/loader'),
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
      console.error(`[stream→${target.type}.${actionId}] dispatch failed:`, err instanceof Error ? err.message : String(err))
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

// The one delivery mechanism behind every path that hands a message to a
// SendMessage node — the `text-in` stream wiring above, and
// the node's own `send` action via `host.sendMessage.send`. Resolves the
// target agent/job (payload fields win, the node's own defaults fill the
// rest), reuses a live session or creates one (registering + hiding it by
// default only on a genuine creation), and composes the
// envelope with instructions/task context gated on that same `created` flag
// too — so every caller gets identical session and envelope
// semantics, not a re-implementation of them. `force` is part of the
// same shared payload schema, so either entry point can carry it.
export async function deliverToSendMessageNode(
  target: GraphNodeLike,
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
  text: string,
): Promise<{ sessionKey: string; created: boolean; forced: boolean } | null> {
  const route = resolveRoute(text, target, nodes, edges)
  if (!route) {
    return null
  }

  // Reuse an existing live session for this agent+job (the node's own
  // remembered session, or a chat tab the user has open) so messages land in
  // one stable conversation. Only create a fresh session when none exists;
  // promptLocal then persists the pointer so it's remembered and reused next time.
  const existing = findTargetSessionImpl({ baseKey: route.sessionKey })
  let sessionId: string
  let created: boolean
  if (existing?.sessionId) {
    sessionId = existing.sessionId
    created = false
  } else {
    const opened = await ensureLocalSessionImpl({
      agentNodeId: route.ctx.agentNodeId,
      jobNodeId: route.ctx.jobNodeId,
      tabKey: route.sessionKey,
    })
    sessionId = opened.sessionId
    created = opened.created
    // Register in the shared registry (keyed by the node's base session key)
    // so the node-driven conversation shows up in the chat list and is
    // resumable on every device, like a UI-started chat. Idempotent, so it's
    // safe to call even when `opened` resumed a persisted session rather than
    // creating a fresh one.
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
    // it starts hidden. `created` (not just "no live session found") keeps
    // this from re-hiding a session the user has already interacted with,
    // e.g. one they closed and dispatch happens to reuse the key for later.
    if (created) {
      await hideSessionByDefault(route.sessionKey).catch(() => {})
    }
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
  return { sessionKey: route.sessionKey, created, forced }
}

// Nothing guarantees the compaction is observable when the prompt call returns,
// on either of two counts:
//
//   - `agentClient.prompt()` resolves once the prompt has been DISPATCHED, not
//     once the turn ends. deliverPrompt fires `connection.prompt()` with `void`
//     and lets settleTurn release the turn when it later resolves. And a prompt
//     sent while the session is busy is queued, so it has not even started.
//   - Usage arrives as a separate ACP session update, and the protocol does not
//     order that against the prompt response.
//
// So the turn is waited out here instead, by polling the same in-flight counter
// the rest of the host reads. Bounded, because a session can stay busy for a
// long time and an action must not hang on it: a timeout reports usage as
// unknown, which makes the verdict unknown, which restores the instructions —
// the safe direction. The same is true of the narrow race where the queue
// drains between two polls: reading early yields an unchanged figure, which is
// unknown rather than a false failure (see compactionVerdict).
const TURN_SETTLE_POLL_MS = 250
const TURN_SETTLE_TIMEOUT_MS = 5 * 60_000

async function awaitSessionIdle(sessionId: string): Promise<boolean> {
  const deadline = Date.now() + TURN_SETTLE_TIMEOUT_MS
  while (hasActiveTurnImpl(sessionId)) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, TURN_SETTLE_POLL_MS))
  }
  return true
}

// Appended after the re-delivered session-init block (see compactSessionOnGraph).
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
export async function compactSessionOnGraph(
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
  sessionKey: string,
): Promise<{
  contextUsageBefore: ContextUsage | null
  contextUsageAfter: ContextUsage | null
  compacted: boolean | null
  instructionsRestored: boolean
}> {
  const ctx = resolveSessionOnGraph(sessionKey, nodes as unknown as SmNodeLike[], edges as unknown as SmEdgeLike[])
  if (!ctx) {
    throw new Error(`No agent/job resolved for session: ${sessionKey}`)
  }
  // Only a session with a live process holds context to compact. An offline one
  // has nothing in memory — say so rather than silently starting a new session
  // and "compacting" that.
  const existing = findTargetSessionImpl({ baseKey: sessionKey })
  if (!existing) {
    throw new Error(`Session has no live process, so there is no context to compact: ${sessionKey}`)
  }
  const readUsage = (): ContextUsage | null =>
    toContextUsage(agentClient.listSessions().find((m) => m.sessionKey === sessionKey)?.usage)

  const contextUsageBefore = readUsage()
  // Sent raw: a leading slash marks a command, and composeEnvelope passes those
  // through unwrapped anyway.
  await promptLocalImpl({ sessionId: existing.sessionId, text: '/compact' })
  // Read only once the turn has actually finished — see awaitSessionIdle for
  // why the prompt call returning is not that moment. A turn that never
  // settles leaves usage unknown rather than reporting a stale figure as if it
  // were the post-compaction one.
  const settled = await awaitSessionIdle(existing.sessionId)
  const contextUsageAfter = settled ? readUsage() : null
  const compacted = compactionVerdict(contextUsageBefore, contextUsageAfter)

  // Restore on true (it worked, and the instructions went with the dropped
  // messages) and on null (cannot tell — re-sending is the safe direction: a
  // redundant envelope costs tokens, a missing one costs the agent its
  // instructions). Skip on false, which is the observed-failure case above.
  const hasInstructions = Boolean(ctx.jobContext?.trim()) || (ctx.instructions ?? []).some((i) => i.trim())
  if (compacted === false || !hasInstructions) {
    return { contextUsageBefore, contextUsageAfter, compacted, instructionsRestored: false }
  }
  const restore = composeEnvelope(REINSTRUCT_NOTE, {
    sessionInit: { jobContext: ctx.jobContext, instructions: ctx.instructions },
    isNewSession: true,
  })
  await promptLocalImpl({ sessionId: existing.sessionId, text: restore })
  return { contextUsageBefore, contextUsageAfter, compacted, instructionsRestored: true }
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
