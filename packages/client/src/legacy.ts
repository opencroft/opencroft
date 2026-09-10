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
  /**
   * A `KeyboardEvent.code` value — the physical key, not the character it
   * produces, so the shortcut fires the same way on every keyboard layout.
   * Held with Ctrl (or Cmd on macOS) plus whichever of `shift`/`alt` below are
   * set. Letters: `'KeyF'`. Digits: `'Digit1'`. Punctuation has its own names
   * (`'Comma'`, `'Period'`, `'Slash'`, `'Minus'`, ...) — never the character
   * itself, since on some layouts a digit or punctuation key needs a modifier
   * to type the character it is labelled with on a US keyboard.
   */
  code: string
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

/**
 * The full canvas surface behind a Graph App instance -- editor, chat and
 * providers, pointed at the instance's graph. What the builtin Graph App's
 * component renders, and all it renders.
 */
export declare const GraphCanvas: FC<{ instanceId: string }>

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

// ── The host's chat surface ─────────────────────────────────────────────────
// Offered whole so an extension mounts the host's own conversation rather than
// arranging the pieces: the dock chrome, the embedded thread, and the picker
// that chooses which thread it shows. Host-injected at runtime.

/** Which conversation an embedded chat surface shows. */
export type EmbeddedChatSelection = { threadId: string } | { newId: string }

export interface EmbeddedAgentChatProps {
  /** The group chat's slug — the first segment of every thread session key. */
  space: string
  /** The DEFAULT thread slug this surface owns, one per member agent. */
  id: string
  /** Override the shown conversation. Unset = the default thread. */
  thread?: EmbeddedChatSelection | null
  /**
   * What to NAME the chat if this surface has to create it. The address is
   * always `space`; this is only the display name, and it defaults to the slug
   * when a host has no better one.
   */
  title?: string
  /**
   * Reports whether the chat RESOLVED: true only when it exists and the caller
   * can see it, false while loading and when it is missing, refused or failed.
   */
  onChatAvailable?: (available: boolean) => void
  className?: string
}
export declare const EmbeddedAgentChat: FC<EmbeddedAgentChatProps>

export interface ChatSelectorProps {
  /** The group chat's slug — same address the embedded chat surface takes. */
  space: string
  /** The current selection, so the open menu can mark the active thread. */
  selection?: EmbeddedChatSelection | null
  onChange: (selection: EmbeddedChatSelection) => void
  /** A larger tap target for touch surfaces; default is the compact header button. */
  size?: 'icon' | 'icon-sm' | 'icon-xs'
  className?: string
}
export declare const ChatSelector: FC<ChatSelectorProps>

export interface ChatDockProps {
  /** The group chat's address: the space's slug. */
  space: string
  /** The thread slug this surface addresses by default. */
  id: string
  /** What the panel's header calls the conversation. */
  title: string
  /** The chat's display name, used only if it has to be created. */
  chatName?: string
  /** The surface the chat sits beside, floats over, or covers. */
  children: ReactNode
}
/**
 * The whole chrome around an embedded thread — corner launcher, the three
 * docks plus the floating window, the mobile cover and its Back behaviour.
 */
export declare const ChatDock: FC<ChatDockProps>

// ── Selection scope ─────────────────────────────────────────────────────────
// What the reader has selected on the surface the chat sits beside, and
// whether it rides along with the next message.

export interface UserSelection {
  /** What the quotation shows. Presentation only — never sent to the agent. */
  label: string
  /** What the agent receives when passing is on. */
  content: string
}

export interface SelectionContextValue {
  /** The current selection, or null when nothing is selected. */
  selection: UserSelection | null
  /**
   * Whether a selection rides along with the next message. A standing
   * preference of the scope rather than a property of what is selected:
   * publishing a selection does not touch it, and it can be set with nothing
   * selected at all.
   */
  passEnabled: boolean
  setSelection: (selection: UserSelection | null) => void
  clearSelection: () => void
  togglePass: () => void
}

export declare const SelectionProvider: FC<{ children: ReactNode }>
/** Throws outside a `SelectionProvider` rather than returning an empty scope. */
export declare const useSelection: () => SelectionContextValue

// ── URL parameters, and the breakpoint ──────────────────────────────────────

export interface UrlParamWriteOptions {
  /**
   * Replace the current history entry instead of pushing a new one. Defaults
   * to `true`, so state that changes as often as the screen does does not make
   * the back button walk through it one step at a time.
   */
  replace?: boolean
}

export interface UrlParamControls {
  /** The current value, or `null` when the parameter is absent. */
  value: string | null
  /** Write the parameter, leaving every other parameter untouched. */
  set: (value: string, options?: UrlParamWriteOptions) => void
  /** Remove the parameter, leaving every other parameter untouched. */
  remove: (options?: UrlParamWriteOptions) => void
}

/** One URL search parameter, for state that should survive a reload. */
export declare const useUrlParam: (name: string) => UrlParamControls

/** The kit's mobile breakpoint, the same signal the host's own chat dock reads. */
export declare const useIsMobile: () => boolean

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

export type CodeEditorLanguage = 'typescript' | 'javascript' | 'python' | 'shell' | 'json' | 'plaintext'
export interface CodeEditorProps {
  value: string
  language?: CodeEditorLanguage
  readOnly?: boolean
  onChange?: (value: string) => void
  /** Reveal and place the cursor on this 1-based line once, on mount. */
  line?: number
  /** Defaults to filling its container, which must have a definite height. */
  height?: string | number
}
/**
 * The host's code editor. Provided here rather than imported from an editor
 * package so every surface shares one editor runtime — an extension bundle has
 * no runtime module resolver, so its own copy would initialise a second one.
 */
export declare const CodeEditor: FC<CodeEditorProps>
