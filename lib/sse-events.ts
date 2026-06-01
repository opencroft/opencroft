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

export interface StreamChunkPayload {
  text: string
  final: boolean
}

export type SSEEvent = BaseEvent &
  (
    | { type: 'toast'; message: string; toastType: 'info' | 'success' | 'warning' | 'error' }
    | { type: 'focus_node'; nodeId: string; panToNode?: boolean }
    | { type: 'clear_focus' }
    | { type: 'comment'; nodeId: string; message: string }
    | { type: 'clear_comment'; nodeId: string }
    | { type: 'graph_updated' }
    | { type: 'extensions_updated' }
    | { type: 'open_space'; slug: string; nodeId?: string }
    | { type: 'doc_comments_updated'; docPath: string }
    | { type: 'approval_pending'; request: PendingApproval }
    | { type: 'approval_resolved'; id: string }
    | { type: 'ask_user_pending'; request: PendingAskUser }
    | { type: 'ask_user_resolved'; id: string }
    | { type: 'docker_ps_updated'; dockerNodeId: string; containers: DockerContainerSnapshot[] }
    | { type: 'stream_chunk'; nodeId: string; handleId: string; chunk: StreamChunkPayload }
    | { type: 'node_data_updated'; nodeId: string; data: Record<string, unknown> }
  )

/** Comment anchored to a node, as stored on the client side. One per node. */
export interface Comment {
  nodeId: string
  message: string
}
