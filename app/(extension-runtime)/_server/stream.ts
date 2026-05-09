// Server-side stream API mirroring the client `Stream<T>` shape so action
// handlers can `getStream(...)` / `broadcast(stream, chunk)` the same way
// browser-side AI nodes (prompt, text-gen, etc.) do today. Broadcasting
// pushes the chunk into local in-process subscribers AND emits a
// `stream_chunk` SSE event scoped to the owning space — the client SSE
// bridge feeds it back into the client stream registry, so existing
// `subscribe(stream, ...)` consumers wake up unchanged.
//
// Each stream keeps a small global ring buffer of the most recent chunks.
// On final chunks, downstream Log nodes have their accumulated entry
// persisted into their own node data via `updateNodeData`, which both saves
// the graph and emits `node_data_updated` for in-place client refresh.

import { updateNodeData } from '@/app/(extension-runtime)/_server/node-data';
import {
  buildSessionKey,
  resolveSessionOnGraph,
  tryParseJsonMessage,
  wrapMessageWithContext,
  type NodeLike as SmNodeLike,
  type EdgeLike as SmEdgeLike,
} from '@/app/(extension-runtime)/_server/send-message-helpers';
import { getSpacesRegistry } from '@/app/(space)/server/store';
import { type StreamChunkPayload } from '@/lib/sse-events';
import { toastStore } from '@/lib/toast-store';


export interface Stream<T> {
  subscribe(fn: (chunk: T) => void): () => void;
  broadcast(chunk: T): void;
}

interface StreamMeta {
  spaceId?: string;
  nodeId: string;
  handleId: string;
}

const BUFFER_SIZE = 1000;

class StreamImpl<T> implements Stream<T> {
  private handlers = new Set<(chunk: T) => void>();
  private buffer: T[] = [];
  private accBuffer = '';

  constructor(
    private spaceId: string | undefined,
    private nodeId: string,
    private handleId: string,
  ) {}

  subscribe(fn: (chunk: T) => void): () => void {
    this.handlers.add(fn);
    return () => {
      this.handlers.delete(fn);
    };
  }

  broadcast(chunk: T): void {
    if (this.buffer.length >= BUFFER_SIZE) {
      this.buffer.shift();
    }
    this.buffer.push(chunk);
    for (const h of this.handlers) {
      h(chunk);
    }
    toastStore.broadcast({
      type: 'stream_chunk',
      spaceId: this.spaceId,
      nodeId: this.nodeId,
      handleId: this.handleId,
      chunk: chunk as unknown as StreamChunkPayload,
    });
    const tc = chunk as unknown as { text?: string; final?: boolean };
    if (typeof tc.text === 'string' && typeof tc.final === 'boolean') {
      this.accBuffer += tc.text;
      if (tc.final) {
        const text = this.accBuffer.trim();
        this.accBuffer = '';
        if (text) {
          void persistToDownstreamLogs(this.spaceId, this.nodeId, this.handleId, text);
          void persistToDownstreamSendMessages(this.spaceId, this.nodeId, this.handleId, text);
        }
      }
    }
  }

  snapshot(): T[] {
    return this.buffer.slice();
  }

  meta(): StreamMeta {
    return { spaceId: this.spaceId, nodeId: this.nodeId, handleId: this.handleId };
  }

  clear(): void {
    this.buffer = [];
  }
}

interface GraphEdgeLike {
  source: string;
  target: string;
  sourceHandle?: string;
  targetHandle?: string;
}

interface GraphNodeLike {
  id: string;
  type?: string;
  data?: Record<string, unknown>;
}

interface LogEntry {
  at: number;
  text: string;
}

const DEFAULT_LOG_MAX = 500;

async function persistToDownstreamLogs(
  spaceId: string | undefined,
  sourceNodeId: string,
  sourceHandleId: string,
  text: string,
): Promise<void> {
  if (!spaceId) {
    return;
  }
  const r = getSpacesRegistry();
  await r.ensureLoaded();
  const space = r.getBySlug(spaceId);
  if (!space) {
    return;
  }
  const edges = space.graph.edges as unknown as GraphEdgeLike[];
  const nodes = space.graph.nodes as unknown as GraphNodeLike[];
  for (const edge of edges) {
    if (edge.source !== sourceNodeId || edge.sourceHandle !== sourceHandleId) {
      continue;
    }
    const target = nodes.find((n) => n.id === edge.target);
    if (target?.type !== 'log') {
      continue;
    }
    const max = ((target.data?.['max'] as number | undefined) && (target.data?.['max'] as number) > 0)
      ? (target.data?.['max'] as number)
      : DEFAULT_LOG_MAX;
    await updateNodeData(spaceId, target.id, (prev) => {
      const prevEntries = ((prev['entries'] as LogEntry[] | undefined) ?? []);
      const entry: LogEntry = { at: Date.now(), text };
      const nextEntries = prevEntries.length >= max
        ? [...prevEntries.slice(prevEntries.length - max + 1), entry]
        : [...prevEntries, entry];
      return { ...prev, entries: nextEntries };
    });
  }
}

async function persistToDownstreamSendMessages(
  spaceId: string | undefined,
  sourceNodeId: string,
  sourceHandleId: string,
  text: string,
): Promise<void> {
  if (!spaceId) {
    return;
  }
  const r = getSpacesRegistry();
  await r.ensureLoaded();
  const space = r.getBySlug(spaceId);
  if (!space) {
    return;
  }
  const edges = space.graph.edges as unknown as GraphEdgeLike[];
  const nodes = space.graph.nodes as unknown as GraphNodeLike[];
  for (const edge of edges) {
    if (edge.source !== sourceNodeId || edge.sourceHandle !== sourceHandleId) {
      continue;
    }
    const target = nodes.find((n) => n.id === edge.target);
    if (target?.type !== 'send-message') {
      continue;
    }

    const route = resolveRoute(text, target, nodes, edges);
    if (!route) {
      continue;
    }

    let message = route.message;
    if (!message.trim().startsWith('/')) {
      message = wrapMessageWithContext(
        message,
        spaceId,
        sourceNodeId,
        route.ctx.jobContext,
        route.ctx.instructions,
      );
    }

    try {
      const { gateway } = await import('@/app/(openclaw)/_server/gateway-client');
      await gateway().call('chat.send', {
        sessionKey: route.sessionKey,
        message,
        idempotencyKey: crypto.randomUUID(),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[send-message] Failed to send to session ${route.sessionKey}:`, msg);
    }
  }
}

interface SendMessageNodeData {
  defaultAgent?: string;
  defaultJob?: string;
}

interface RouteResolution {
  sessionKey: string;
  message: string;
  ctx: { jobContext: string; instructions: string[] };
}

function resolveRoute(
  text: string,
  target: GraphNodeLike,
  nodes: GraphNodeLike[],
  edges: GraphEdgeLike[],
): RouteResolution | null {
  const smNodes = nodes as unknown as SmNodeLike[];
  const smEdges = edges as unknown as SmEdgeLike[];

  const parsed = tryParseJsonMessage(text);
  if (parsed) {
    const ctx = resolveSessionOnGraph(parsed.session, smNodes, smEdges);
    if (!ctx) {
      return null;
    }
    return { sessionKey: parsed.session, message: parsed.message, ctx };
  }

  const data = (target.data ?? {}) as SendMessageNodeData;
  const a = (data.defaultAgent || '').trim();
  const j = (data.defaultJob || '').trim();
  if (!a || !j) {
    return null;
  }
  const sessionKey = buildSessionKey(a, j);
  const ctx = resolveSessionOnGraph(sessionKey, smNodes, smEdges);
  if (!ctx) {
    return null;
  }
  return { sessionKey, message: text, ctx };
}

const g = globalThis as Record<string, unknown>;
if (!g.__STREAM_REGISTRY__) {
  g.__STREAM_REGISTRY__ = new Map<string, StreamImpl<unknown>>();
}
const registry = g.__STREAM_REGISTRY__ as Map<string, StreamImpl<unknown>>;

function keyFor(nodeId: string, handleId: string): string {
  return `${nodeId}::${handleId}`;
}

export function getStream<T>(spaceId: string | undefined, nodeId: string, handleId: string): Stream<T> {
  const key = keyFor(nodeId, handleId);
  let impl = registry.get(key);
  if (!impl) {
    impl = new StreamImpl<unknown>(spaceId, nodeId, handleId);
    registry.set(key, impl);
  }
  return impl as unknown as Stream<T>;
}

export function subscribe<T>(stream: Stream<T>, fn: (chunk: T) => void): () => void {
  return stream.subscribe(fn);
}

export function broadcast<T>(stream: Stream<T>, chunk: T): void {
  stream.broadcast(chunk);
}

export interface BufferedStream {
  nodeId: string;
  handleId: string;
  chunks: StreamChunkPayload[];
}

export function listBufferedStreams(spaceId: string | undefined): BufferedStream[] {
  const result: BufferedStream[] = [];
  for (const impl of registry.values()) {
    const meta = impl.meta();
    if (spaceId !== undefined && meta.spaceId !== undefined && meta.spaceId !== spaceId) {
      continue;
    }
    const chunks = impl.snapshot() as StreamChunkPayload[];
    if (chunks.length === 0) {
      continue;
    }
    result.push({ nodeId: meta.nodeId, handleId: meta.handleId, chunks });
  }
  return result;
}
