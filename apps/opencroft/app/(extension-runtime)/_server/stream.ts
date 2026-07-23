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

import { ensureLocalSession, findTargetSession, promptLocal } from '@/app/(agent)/_server/acp'
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

interface GraphEdgeLike {
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
}

interface GraphNodeLike {
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

    const route = resolveRoute(text, target, nodes, edges)
    if (!route) {
      continue
    }

    try {
      // Reuse an existing live session for this agent+job (the node's own
      // remembered session, or a chat tab the user has open) so messages land in
      // one stable conversation. Only create a fresh session when none exists;
      // promptLocal then persists the pointer so it's remembered and reused next time.
      const existing = await findTargetSession({ data: { baseKey: route.sessionKey } })
      let sessionId: string
      let created: boolean
      if (existing?.sessionId) {
        sessionId = existing.sessionId
        created = false
      } else {
        const opened = await ensureLocalSession({
          data: { agentNodeId: route.ctx.agentNodeId, jobNodeId: route.ctx.jobNodeId, tabKey: route.sessionKey },
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

      // Automated senders never include the selected-node/space system context
      // (chat-only); task context + instructions are session-scoped, so only a
      // freshly created ACP session gets them.
      const message = composeEnvelope(route.message, {
        sessionInit: { jobContext: route.ctx.jobContext, instructions: route.ctx.instructions },
        isNewSession: created,
      })

      await promptLocal({ data: { sessionId, text: message } })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[send-message] Failed to send to session ${route.sessionKey}:`, msg)
    }
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

  return { sessionKey, message, ctx, title }
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
