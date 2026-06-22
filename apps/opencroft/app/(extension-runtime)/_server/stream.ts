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
import { updateNodeData } from '@/app/(extension-runtime)/_server/node-data'
import {
  type AgentContext,
  buildSessionKey,
  resolveSessionOnGraph,
  type EdgeLike as SmEdgeLike,
  type NodeLike as SmNodeLike,
  tryParseJsonMessage,
  wrapMessageWithContext,
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

// When a text-stream completes, dispatch the accumulated text to any downstream
// node whose target handle declares a `streamAction` in its manifest. The action
// receives the text as `ctx.params.text`. This keeps per-integration logic inside
// the owning extension — core never names specific node types.
async function dispatchDownstreamTextActions(
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
    if (!target || !handle?.streamAction) {
      continue
    }
    try {
      await dispatchNodeAction({ data: { nodeId: target.id, actionId: handle.streamAction, params: { text } } })
    } catch (err) {
      console.error(
        `[stream→${target.type}.${handle.streamAction}] dispatch failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }
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

    let message = route.message
    if (!message.trim().startsWith('/')) {
      message = wrapMessageWithContext(
        message,
        { name: space.name, slug: spaceId },
        sourceNodeId,
        route.ctx.jobContext,
        route.ctx.instructions,
      )
    }

    try {
      // Reuse an existing live session for this agent+job (the node's own
      // remembered session, or a chat tab the user has open) so messages land in
      // one stable conversation. Only create a fresh session when none exists;
      // promptLocal then persists the pointer so it's remembered and reused next time.
      const existing = await findTargetSession({ data: { baseKey: route.sessionKey } })
      let sessionId: string
      if (existing?.sessionId) {
        sessionId = existing.sessionId
      } else {
        sessionId = (
          await ensureLocalSession({
            data: { agentNodeId: route.ctx.agentNodeId, jobNodeId: route.ctx.jobNodeId, tabKey: route.sessionKey },
          })
        ).sessionId
        // A brand-new session: register it in the shared registry (keyed by the
        // node's base session key) so the node-driven conversation shows up in
        // the chat list and is resumable on every device, like a UI-started chat.
        await upsertSession({
          key: route.sessionKey,
          agentNodeId: route.ctx.agentNodeId,
          agentName: route.ctx.agentName,
          jobNodeId: route.ctx.jobNodeId,
          jobName: route.ctx.jobName,
          title: route.ctx.jobName,
          createdAt: Date.now(),
        }).catch(() => {})
      }
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
}

interface RouteResolution {
  sessionKey: string
  message: string
  ctx: AgentContext
}

function resolveRoute(
  text: string,
  target: GraphNodeLike,
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
): RouteResolution | null {
  const smNodes = nodes as unknown as SmNodeLike[]
  const smEdges = edges as unknown as SmEdgeLike[]

  const parsed = tryParseJsonMessage(text)
  if (parsed) {
    const ctx = resolveSessionOnGraph(parsed.session, smNodes, smEdges)
    if (!ctx) {
      return null
    }
    return { sessionKey: parsed.session, message: parsed.message, ctx }
  }

  const data = (target.data ?? {}) as SendMessageNodeData
  const a = (data.defaultAgent || '').trim()
  const j = (data.defaultJob || '').trim()
  if (!a || !j) {
    return null
  }
  const sessionKey = buildSessionKey(a, j)
  const ctx = resolveSessionOnGraph(sessionKey, smNodes, smEdges)
  if (!ctx) {
    return null
  }
  return { sessionKey, message: text, ctx }
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
