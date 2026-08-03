/**
 * `legacy` — the full `@ext/host` + `@ext/ui` client surface, ported 1:1 so
 * extensions can move off `@ext` onto `@opencroft/client`. The runtime is
 * injected by the host; these are the type declarations. APIs graduate out of
 * `legacy` into the typed `@opencroft/client` root over time.
 */
import type { ComponentType, FC, ReactNode } from 'react'

// ── Contracts ───────────────────────────────────────────────────────────────

export interface ExtensionHandle {
  id: string
  contextType: string
  role: 'source' | 'target'
  label?: string
  dynamic?: boolean
}

export interface ExtensionContextType {
  id: string
  label: string
  color: string
}

export interface ExtensionComponentProps<D = Record<string, unknown>> {
  id: string
  data: D
  selected?: boolean
}

export interface ExtensionInspectorProps<D = Record<string, unknown>> {
  nodeId: string
  data: D
  updateData: (patch: Partial<D>) => void
}

export interface InspectorTab<D = Record<string, unknown>> {
  id: string
  label: string
  icon?: string
  fullHeight?: boolean
  component: ComponentType<ExtensionInspectorProps<D>>
}

/** Context passed to a node context-menu item's `isEnabled`/`onSelect`. */
export interface NodeContextMenuContext<D = Record<string, unknown>> {
  nodeId: string
  typeId: string
  data: D
}

export interface NodeContextMenuItem<D = Record<string, unknown>> {
  /** Unique item id, used as the React key */
  id: string
  /** Item label shown in the menu */
  label: string
  /** Icon name from lucide-react (optional) */
  icon?: string
  /** Styles the item as a destructive (red) action */
  destructive?: boolean
  /** Whether the item is selectable; omit to always enable. May be async (e.g. checking live node state). */
  isEnabled?: (ctx: NodeContextMenuContext<D>) => boolean | Promise<boolean>
  /** Invoked when the item is selected. */
  onSelect: (ctx: NodeContextMenuContext<D>) => void | Promise<void>
}

export interface NodeDefinition<D = Record<string, unknown>> {
  typeId: string
  name: string
  category?: string
  description?: string
  icon?: string
  accent?: string
  handles?: ExtensionHandle[]
  defaultData?: D
  component: ComponentType<ExtensionComponentProps<D>>
  inspector?: ComponentType<ExtensionInspectorProps<D>>
  inspectorTabs?: InspectorTab<D>[]
  /** Entries this node type contributes to its right-click context menu, after the built-in Copy/Delete actions. */
  contextMenuItems?: NodeContextMenuItem<D>[]
  exposeOutput?: (handleId: string, data: D, typeId: string, nodeId: string) => unknown
}

export interface ExtensionDeclarationManifest {
  id: string
  name?: string
  version?: string
  description?: string
}

export interface CommandBarNode {
  id: string
  label: string
  subtitle: string
  data: Record<string, unknown>
  icon: import('lucide-react').LucideIcon
  accent: string
}

export interface CommandModeProps {
  nodes: CommandBarNode[]
  spaceName: string
  selectedNodeId: string | null
  focusTick: number
  /** Params passed by the caller of activate(modeId, params); null when opened without any. */
  params: unknown
  onFocusNode: (nodeId: string) => void
  onClose: () => void
  onFocusChange: (focused: boolean) => void
}

export interface CommandModeShortcut {
  key: string
  shift?: boolean
  alt?: boolean
}

export interface CommandModeDefinition {
  id: string
  label: string
  icon?: string
  description?: string
  shortcut?: CommandModeShortcut
  component: ComponentType<CommandModeProps>
}

export interface SettingsPageDefinition {
  id: string
  label: string
  icon?: string
  component: ComponentType
}

export interface ExtensionDeclaration {
  manifest: ExtensionDeclarationManifest
  contexts?: ExtensionContextType[]
  nodes?: NodeDefinition[]
  commandModes?: CommandModeDefinition[]
  settings?: SettingsPageDefinition[]
  /** Generic, feature-defined provider points (e.g. `dashboards`). */
  provides?: Record<string, unknown[]>
}

export interface HandlePinProps {
  type: string
  id?: string
  color?: string
  children?: ReactNode
}

export interface ExtensionStorage {
  get<T = unknown>(key: string): Promise<T | null>
  set<T = unknown>(key: string, value: T): Promise<void>
  delete(key: string): Promise<void>
  list(): Promise<string[]>
  clear(): Promise<void>
}

// ── Extension authoring ─────────────────────────────────────────────────────

export declare const defineExtension: (decl: ExtensionDeclaration) => ExtensionDeclaration
export declare const extensionId: string
export declare const invoke: <T = unknown>(name: string, ...args: unknown[]) => Promise<T>
export declare const dispatch: (nodeId: string, actionId: string, params?: Record<string, unknown>) => Promise<unknown>
export declare const createStorage: (namespace?: string) => ExtensionStorage
export declare const assetUrl: (path: string) => string
export declare const routeUrl: (path: string) => string

// ── React + canvas runtime (host-provided) ──────────────────────────────────

export declare const React: typeof import('react')
export declare const createPortal: typeof import('react-dom').createPortal
export declare const Handle: typeof import('@xyflow/react').Handle
export declare const Position: typeof import('@xyflow/react').Position
export declare const NodeResizer: typeof import('@xyflow/react').NodeResizer
export declare const useReactFlow: typeof import('@xyflow/react').useReactFlow
export declare const useUpdateNodeInternals: typeof import('@xyflow/react').useUpdateNodeInternals
export declare const useGraphNodes: typeof import('@xyflow/react').useNodes
export declare const useGraphEdges: typeof import('@xyflow/react').useEdges
export declare const icons: typeof import('lucide-react')
export declare const toast: typeof import('sonner').toast

export declare const InputHandle: FC<HandlePinProps>
export declare const OutputHandle: FC<HandlePinProps>

export declare const NodeFrame: ComponentType<Record<string, unknown>>
export declare const NodeCard: ComponentType<Record<string, unknown>>
export declare const NodeCardHeader: ComponentType<Record<string, unknown>>
export declare const NodeCardContent: ComponentType<Record<string, unknown>>
export declare const useNodeAccent: () => string

/** A resolved context flowing through a connected edge. */
export interface ResolvedContext<V = unknown> {
  sourceNodeId: string
  sourceHandleId: string
  type: string
  value: V
}
export declare const useNodeContext: <V = unknown>(nodeId: string, targetHandleId: string) => ResolvedContext<V> | null

export interface InspectorIntent {
  tab?: string
  instanceId?: string
  tabRequestId?: number
}
export declare const inspectorIntent: {
  get: (nodeId: string) => InspectorIntent
  open: (nodeId: string, tab: string, instanceId?: string) => void
  setInstance: (nodeId: string, instanceId: string | undefined) => void
  subscribe: (cb: () => void) => () => void
}
export declare const useInspectorIntent: (nodeId: string) => InspectorIntent

/** Overlay control returned by useOverlay; activate(modeId, params?) opens a registered command mode. */
export interface OverlayControl {
  activate: (modeId: string, params?: unknown) => void
  dismiss: () => void
}
export declare const useOverlay: (slots?: Record<string, unknown>) => OverlayControl

// ── Streaming ────────────────────────────────────────────────────────────────

export interface TextChunk {
  text: string
  final: boolean
}

export interface Stream<T> {
  subscribe(fn: (chunk: T) => void): () => void
  broadcast(chunk: T): void
}

export declare const getStream: <T>(nodeId: string, handleId: string) => Stream<T>
export declare const subscribe: <T>(stream: Stream<T>, fn: (chunk: T) => void) => () => void
export declare const broadcast: <T>(stream: Stream<T>, chunk: T) => void

// ── Docker container state (host-provided hooks) ────────────────────────────

export declare const useDockerContainers: (...args: unknown[]) => unknown
export declare const useDockerSnapshotReceived: (...args: unknown[]) => unknown
export declare const useSeedDockerContainers: (...args: unknown[]) => unknown

// ── UI components ────────────────────────────────────────────────────────────
// The full `ui` package surface (every shadcn component plus SearchableDropdown,
// Popover, Command, Combobox, …). Host-injected at runtime; `ui/ext` is the set.
export * from 'ui/ext'

// App-provided components that live outside the `ui` package.
export declare const FileBrowser: ComponentType<Record<string, unknown>>
export declare const FileManagerProvider: ComponentType<Record<string, unknown>>
export declare const Terminal: FC<import('@opencroft/terminal/client').TerminalProps>
/** Pre-@opencroft/terminal name for the `Terminal` component. */
export declare const InspectorTerminalBody: typeof Terminal
export declare const CommandBar: ComponentType<Record<string, unknown>>
export declare const CommandBarMenu: ComponentType<Record<string, unknown>>
export declare const CommandBarMenuItem: ComponentType<Record<string, unknown>>
