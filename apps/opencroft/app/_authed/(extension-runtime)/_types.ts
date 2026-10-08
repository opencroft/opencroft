// Shared types for the extension system. Safe to import from both server and
// client — contains no runtime imports of Node-only or React APIs.

import type { ExecutionMode } from '@opencroft/core'

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
  /**
   * What a connection on this handle carries. Declared bare for one of the
   * extension's own handle types, qualified (`<owner>.<extension>.<type>`) for
   * another extension's; qualified in every declaration the runtime has read.
   */
  handleType: string
  /** @deprecated Declare `handleType`. Read only when `handleType` is absent. */
  contextType?: string
  role: 'source' | 'target'
  label?: string
  /** When true, `id` is treated as a prefix matching dynamically-rendered handle ids (e.g. per-instance outputs). */
  dynamic?: boolean
  /** For `text-stream` target handles: the node action to dispatch when an inbound
   *  stream completes, receiving the accumulated text as `ctx.params.text`. Lets a
   *  node consume a text-stream server-side (like the Log node) without core knowing
   *  the node type. */
  streamAction?: string
  /** The node action to dispatch on EVERY inbound chunk (not just completion),
   *  receiving the chunk's own fields as `ctx.params` (e.g. `{ text, final }`).
   *  Lets a node react incrementally to a stream server-side — e.g. starting
   *  work on partial output before the stream finishes — without core knowing
   *  the node type or chunk shape. */
  streamChunkAction?: string
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

/** A handle type an extension declares: bare in the declaration, qualified with the extension's id once read. */
export interface ExtensionHandleType {
  id: string
  label: string
  color: string
  description?: string
}

/** @deprecated Renamed `ExtensionHandleType`. */
export type ExtensionContextType = ExtensionHandleType

export interface NodeAction {
  id: string
  label: string
  description?: string
  icon?: string
  inputSchema?: Record<string, unknown>
  /** How callers wait for it. Absent means `sync` — see {@link ExecutionMode}. */
  execution?: ExecutionMode
}

export interface NodeMetadata {
  /**
   * The node's type. Declared bare (`gauge`), a slug unique among the
   * extension's nodes; qualified with the extension's id (`acme.widgets.gauge`)
   * in every manifest the runtime has read, which is also what graphs store.
   */
  type: string
  /** @deprecated Declare `type`. Read only when `type` is absent. */
  typeId?: string
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
  /** The handle types this extension declares, bare; see `ExtensionHandle.handleType`. */
  handleTypes?: ExtensionHandleType[]
  /** @deprecated Declare `handleTypes`. Read only when `handleTypes` is absent. */
  contexts?: ExtensionHandleType[]
  /** Generic, feature-defined provider points (e.g. `apps`). The runtime
   *  stores these opaquely — except `apps`, whose entries are types like
   *  nodes and are qualified the same way (`AppEntry.type`); features read
   *  them via getProvided. */
  provides?: Record<string, unknown[]>
  main?: string
  exports?: ExtensionExports
  activationEvents?: string[]
  /** Bare specifiers to resolve to an empty module in the CLIENT build only.
   *  For a dependency's own optional/runtime-gated branch (e.g. a library's
   *  internal `if (someOption) await import('heavy-thing')`) that this
   *  extension never reaches but esbuild still has to bundle, since it can't
   *  prove a runtime branch dead. Declaring nothing here changes nothing
   *  about the build. An entry that never matches an actual import in the
   *  build is reported as a build error, not silently ignored. If the
   *  stubbed code path is ever reached at runtime despite being declared
   *  dead, the failure is a TypeError from calling something on an empty
   *  module — not a module-resolution error — since the specifier still
   *  resolves to real (empty) code rather than being left unresolvable in
   *  the output. See compileClientSide in the extension compiler. */
  clientStubs?: string[]
}

/** A manifest plus runtime-computed flags, as sent to the client loader. */
export interface ExtensionManifestInfo extends ExtensionManifest {
  /**
   * The folder under `extensions/` this extension runs from. It differs from
   * `id` for a local copy standing in for another extension, and its owner is
   * what says whether the extension is editable here.
   */
  folder: string
  /** Whether the extension ships a client bundle the browser should import. */
  hasClient: boolean
  /** Version of the built client artifacts, used to key their URLs so an
   *  unchanged extension is cached rather than re-downloaded. 0 when the
   *  extension has not been built yet. */
  clientVersion: number
  /** The icon names the client bundle's sources name, for the browser to load before it renders. */
  clientIcons: string[]
}

/**
 * What the browser needs to import one extension's client bundle, and nothing
 * more: it is fetched on every signed-in page. Descriptions and schemas stay
 * with the full manifest, read where they are shown.
 */
export type ExtensionClientInfo = Pick<ExtensionManifestInfo, 'id' | 'folder' | 'clientVersion' | 'clientIcons'>

export interface ExtensionRecord {
  manifest: ExtensionManifest
  sourceDir: string
  distDir: string
  updatedAt: number
}

/** An extension's output resolver. `type` is the node's BARE type, the name the extension declared it under. */
export type ExposeOutputFn = (handleId: string, nodeData: Record<string, unknown>, type: string) => unknown

export interface ConnectedSource {
  nodeId: string
  handleId: string
  type?: string
  data: Record<string, unknown>
}

export interface ResolvedInput<T = unknown> {
  sourceNodeId: string
  sourceHandleId: string
  /** The qualified handle type of the source handle. */
  handleType: string
  /** @deprecated Read `handleType`, which holds the same value. */
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
  /** The node's BARE type — the name the extension running the action declared it under. */
  type: string
  /** @deprecated Read `type`, which holds the same bare value. */
  typeId: string
  data: Record<string, unknown>
  params: Record<string, unknown>
  input<T = unknown>(handleId: string): T | undefined
  inputSource<T = unknown>(handleId: string): ResolvedInput<T> | undefined
  /** The nodes wired into `handleId`, each with the qualified `type` the graph stores. */
  connectedSources(handleId: string): ConnectedSource[]
  /**
   * The nodes whose area holds this one, each with its stored, qualified
   * `type`. `type` narrows them: bare for one of the calling extension's own
   * types, qualified for any extension's.
   */
  containingNodes(type?: string): NodeActionCtxNode[]
  output<T = unknown>(handleId: string): Stream<T>
  /** Persist a patch to this node's stored data (e.g. assign a key). */
  updateData(patch: Record<string, unknown>): void
  /**
   * The agent that invoked this action, when the surface that dispatched it
   * had one and could name it. Absent for a graph-driven run, where the
   * question is not "who asked" but "what fed this" -- that is `inputSource`,
   * and the two are never the same answer.
   *
   * A NAME, not a handle: what the dispatching surface resolved, unmodified.
   * An action that needs a durable identifier turns it into one where the
   * identifier is minted, so nothing here has to know what that costs.
   */
  callerAgent?: string
  /**
   * Aborted when whoever is waiting on this run gives up on it: a background
   * task cancelled by its caller, or out of time. Absent when nothing can
   * cancel the run — a button press, a graph-driven dispatch.
   *
   * Advisory. An action that never looks at it runs to its end regardless,
   * which is why a cancel of one is reported as requested, not done; one
   * that can stop part-way (a long pull, a loop over hosts) checks it
   * between steps and gives up there.
   */
  signal?: AbortSignal
}

export interface NodeActionDescriptor {
  nodeId: string
  /** The node's qualified type. */
  type: string
  extensionId: string
  actionId: string
  label: string
  description?: string
  /** JSON schema for the action's `params`, when it accepts any. Surfaced to
   *  agents via `list_actions` so they know what to pass to `call`. */
  inputSchema?: Record<string, unknown>
}

/** The HTTP routes an extension's server module exports as `routes`, the same
 *  way it exports `actions` and `nodeActions`. Declared in `@opencroft/server`,
 *  the surface extensions build against. */
export type { ExtensionRoute, ExtensionRouteHandler, ExtensionRoutes } from '@opencroft/server'

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
