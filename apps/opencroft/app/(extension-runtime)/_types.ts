// Shared types for the extension system. Safe to import from both server and
// client — contains no runtime imports of Node-only or React APIs.

/** Generic node data — all node data objects extend this. */
export type NodeData = Record<string, unknown>

/** A resolved context flowing through a connected edge. */
export interface ResolvedContext<V = unknown> {
  sourceNodeId: string
  sourceHandleId: string
  type: string
  value: V
}

export interface ExtensionHandle {
  id: string
  contextType: string
  role: 'source' | 'target'
  label?: string
  /** When true, `id` is treated as a prefix matching dynamically-rendered handle ids (e.g. per-instance outputs). */
  dynamic?: boolean
  /** For `text-stream` target handles: the node action to dispatch when an inbound
   *  stream completes, receiving the accumulated text as `ctx.params.text`. Lets a
   *  node consume a text-stream server-side (like the Log node) without core knowing
   *  the node type. */
  streamAction?: string
}

/** Resolve a runtime handle id against a node's static handle declarations, supporting prefix-matched dynamic handles. */
export function findExtensionHandle(
  handles: ExtensionHandle[],
  handleId: string,
  role: 'source' | 'target',
): ExtensionHandle | undefined {
  return handles.find((h) => {
    if (h.role !== role) {
      return false
    }
    if (h.dynamic) {
      return handleId.startsWith(h.id)
    }
    return h.id === handleId
  })
}

export interface ExtensionContextType {
  id: string
  label: string
  color: string
  description?: string
}

export interface NodeAction {
  id: string
  label: string
  description?: string
  icon?: string
  inputSchema?: Record<string, unknown>
}

export interface NodeMetadata {
  typeId: string
  name: string
  category?: string
  description?: string
  icon?: string
  accent?: string
  handles?: ExtensionHandle[]
  actions?: NodeAction[]
  defaultData?: Record<string, unknown>
}

export interface ExtensionExports {
  server?: string
  client?: string
}

// extension.json — authored on disk. Minimal: identity + deps + optional
// static node metadata for lazy palette discovery. Runtime behavior comes
// from the compiled client bundle.
export interface ExtensionManifest {
  id: string
  name: string
  version: string
  description?: string
  extensionDependencies?: string[]
  nodes?: NodeMetadata[]
  contexts?: ExtensionContextType[]
  /** Generic, feature-defined provider points (e.g. `dashboards`). The runtime
   *  stores these opaquely; features read them via getProvided. */
  provides?: Record<string, unknown[]>
  main?: string
  exports?: ExtensionExports
  activationEvents?: string[]
}

/** A manifest plus runtime-computed flags, as sent to the client loader. */
export interface ExtensionManifestInfo extends ExtensionManifest {
  /** Whether the extension ships a client bundle the browser should import. */
  hasClient: boolean
}

export interface ExtensionRecord {
  manifest: ExtensionManifest
  sourceDir: string
  distDir: string
  updatedAt: number
}

export type ExposeOutputFn = (handleId: string, nodeData: Record<string, unknown>, typeId: string) => unknown

export interface ConnectedSource {
  nodeId: string
  handleId: string
  type?: string
  data: Record<string, unknown>
}

export interface ResolvedInput<T = unknown> {
  sourceNodeId: string
  sourceHandleId: string
  contextType: string
  value: T
}

export interface NodeActionCtxNode {
  id: string
  type?: string
  position: { x: number; y: number }
  data: Record<string, unknown>
}

/** Streaming primitive — same shape as the client `Stream<T>` so server-side action handlers can be migrated from the browser without changing call sites. */
export interface Stream<T> {
  subscribe(fn: (chunk: T) => void): () => void
  broadcast(chunk: T): void
}

export interface NodeActionCtx {
  nodeId: string
  typeId: string
  data: Record<string, unknown>
  params: Record<string, unknown>
  input<T = unknown>(handleId: string): T | undefined
  inputSource<T = unknown>(handleId: string): ResolvedInput<T> | undefined
  connectedSources(handleId: string): ConnectedSource[]
  containingNodes(typeId?: string): NodeActionCtxNode[]
  output<T = unknown>(handleId: string): Stream<T>
  /** Persist a patch to this node's stored data (e.g. assign a key). */
  updateData(patch: Record<string, unknown>): void
}

export interface NodeActionDescriptor {
  nodeId: string
  typeId: string
  extensionId: string
  actionId: string
  label: string
  description?: string
  /** JSON schema for the action's `params`, when it accepts any. Surfaced to
   *  agents via `list_actions` so they know what to pass to `call`. */
  inputSchema?: Record<string, unknown>
}

/** An HTTP handler exposed by an extension's server module, served at
 *  `/api/ext/<scope>/<slug>/http/<path>`. Receives the raw Request and returns a
 *  (possibly streaming) Response — suitable for proxies, webhooks, and SSE. */
export type ExtensionRouteHandler = (request: Request) => Response | Promise<Response>

/** Map of route path → handler. Exported as `routes` from an extension's
 *  server module, the same way `actions` and `nodeActions` are. */
export type ExtensionRoutes = Record<string, ExtensionRouteHandler>

export interface CompileError {
  file: string
  line?: number
  column?: number
  message: string
}

export interface BuildResult {
  success: boolean
  errors: CompileError[]
  warnings: CompileError[]
  clientHash: string
  serverHash: string
}
