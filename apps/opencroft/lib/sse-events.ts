// ── SSE Event Types ─────────────────────────────────────────────────────
//
// Shared type definitions for SSE events between server and client.

interface BaseEvent {
  /** Scope this event to a specific space. Omit for global events. */
  spaceId?: string
}

export interface PendingApproval {
  id: string
  tool: string
  args: Record<string, unknown>
  view?: string
  spaceId?: string
  createdAt: number
}

export interface AskUserQuestion {
  title: string
  question: string
  options: string[]
  multiple: boolean
}

export interface PendingAskUser {
  id: string
  questions: AskUserQuestion[]
  spaceId?: string
  createdAt: number
}

export interface DockerContainerSnapshot {
  id: string
  name: string
  service: string
  status: string
  running: boolean
}

// The session keys of the receiving person's own chat threads, by activity:
// waiting on someone (pending), a turn running (active), background work
// running (background), a live agent process at all (alive — a superset of the
// others). Always the whole picture, never a delta, so a missed frame cannot
// leave a reader out of step.
export interface SessionActivitySnapshot {
  pending: string[]
  active: string[]
  background: string[]
  alive: string[]
}

// A stream chunk's shape is owned by whichever node produced it (text, audio,
// or anything else JSON-safe), not by core — this event just carries it
// verbatim from the server stream registry to the client stream registry.
export type StreamChunkPayload = Record<string, unknown>

export type SSEEvent = BaseEvent &
  (
    | { type: 'toast'; message: string; toastType: 'info' | 'success' | 'warning' | 'error' }
    | { type: 'focus_node'; nodeId: string; panToNode?: boolean }
    | { type: 'clear_focus' }
    | { type: 'comment'; nodeId: string; message: string }
    | { type: 'clear_comment'; nodeId: string }
    | { type: 'graph_updated' }
    | { type: 'extensions_updated' }
    | { type: 'extension_event'; extensionId: string; name: string; payload?: Record<string, unknown> }
    | { type: 'open_space'; slug: string; nodeId?: string }
    | { type: 'approval_pending'; request: PendingApproval }
    | { type: 'approval_resolved'; id: string }
    | { type: 'ask_user_pending'; request: PendingAskUser }
    | { type: 'ask_user_resolved'; id: string }
    | { type: 'docker_ps_updated'; dockerNodeId: string; containers: DockerContainerSnapshot[] }
    | { type: 'stream_chunk'; nodeId: string; handleId: string; chunk: StreamChunkPayload }
    | { type: 'node_data_updated'; nodeId: string; data: Record<string, unknown> }
    | { type: 'session_activity'; activity: SessionActivitySnapshot }
  )

/** Comment anchored to a node, as stored on the client side. One per node. */
export interface Comment {
  nodeId: string
  message: string
}
