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
  /**
   * What a connection on this handle carries: one of this extension's own
   * handle types bare (`signal`), another extension's qualified
   * (`builtin.core.terminal-context`). Required unless the deprecated
   * `contextType` stands in for it.
   */
  handleType?: string
  /** @deprecated Declare `handleType`. Read only when `handleType` is absent. */
  contextType?: string
  role: 'source' | 'target'
  label?: string
  dynamic?: boolean
}

/** A handle type this extension declares, by its bare id; the host qualifies it with the extension's id. */
export interface ExtensionHandleType {
  id: string
  label: string
  color: string
}

/** @deprecated Renamed `ExtensionHandleType`. */
export type ExtensionContextType = ExtensionHandleType

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
  /** The node's type as this extension declared it: bare. */
  type: string
  /** @deprecated Read `type`, which holds the same bare value. */
  typeId: string
  data: D
  /**
   * The node's wired inputs as the open canvas has them, keyed by target
   * handle id — what `useNodeContext` returns per handle. Prefer it over
   * `data.__resolvedContexts`, which the server writes on save and which lags
   * wiring done in the open page.
   */
  contexts: Record<string, ResolvedContext>
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
  /**
   * The node's type, bare: a slug unique among this extension's nodes. The
   * host qualifies it with the extension's id (`<owner>.<extension>.<type>`),
   * which is the form graph data carries. Required unless the deprecated
   * `typeId` stands in for it.
   */
  type?: string
  /** @deprecated Declare `type`. Read only when `type` is absent. */
  typeId?: string
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
  /**
   * Told the node's type as declared here (bare), and the node's wired inputs
   * as the open canvas has them (`contexts`, keyed by target handle id, as in
   * `NodeContextMenuContext`). An output built from an input reads it there,
   * not from `data.__resolvedContexts`, which lags wiring done in the open page.
   * The value must be JSON-serialisable: consumers on the canvas are handed a
   * structural copy of it.
   */
  exposeOutput?: (
    handleId: string,
    data: D,
    type: string,
    nodeId: string,
    contexts: Record<string, ResolvedContext>,
  ) => unknown
}

export interface ExtensionDeclarationManifest {
  /**
   * @deprecated The runtime supplies the extension's id when it loads the
   * bundle, and files everything the bundle declares under that. Leave it out;
   * a different value is ignored, with a console warning.
   */
  id?: string
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
  /** The handle types this extension declares, bare. */
  handleTypes?: ExtensionHandleType[]
  /** @deprecated Declare `handleTypes`. Read only when `handleTypes` is absent. */
  contexts?: ExtensionHandleType[]
  nodes?: NodeDefinition[]
  commandModes?: CommandModeDefinition[]
  settings?: SettingsPageDefinition[]
  /** Generic, feature-defined provider points (e.g. `apps`). */
  provides?: Record<string, unknown[]>
}

export interface HandlePinProps {
  /** The handle type: bare for one of this extension's own, qualified for another's. Also the default `id`. */
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
/** The extension's own id, `<owner>.<extension>`. Never hard-code it. */
export declare const extensionId: string
/**
 * Where the host serves this extension: `/api/ext/<extensionId>`. Extensions
 * never build their own URLs — use this, `assetUrl`, `routeUrl` and
 * `absoluteUrl`.
 */
export declare const urlBase: string
/** The URL of a static file under the extension's `assets/` folder. */
export declare const assetUrl: (path: string) => string
/** The URL of one of the extension's declared HTTP `routes`. */
export declare const routeUrl: (path: string) => string
/**
 * An instance-relative URL (`urlBase`, or what `assetUrl` / `routeUrl` return)
 * in absolute form, resolved against the page's origin — for a link handed
 * outside the instance. Defaults to `urlBase`.
 */
export declare const absoluteUrl: (url?: string) => string
export declare const invoke: <T = unknown>(name: string, ...args: unknown[]) => Promise<T>
export declare const dispatch: (nodeId: string, actionId: string, params?: Record<string, unknown>) => Promise<unknown>
export declare const createStorage: (namespace?: string) => ExtensionStorage

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
  setTab: (nodeId: string, tab: string) => void
  setInstance: (nodeId: string, instanceId: string | undefined) => void
  subscribe: (cb: () => void) => () => void
  onOpen: (cb: (nodeId: string) => void) => () => void
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
   * preference of the reader rather than a property of what is selected:
   * publishing a selection does not touch it, and it can be set with nothing
   * selected at all. Kept per browser, so every scope starts from the reader's
   * last answer.
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

// Whatever this is, it reaches Monaco verbatim, and Monaco registers around
// forty languages and accepts every one of them at run time. So this union was
// never the set that works — it was a ceiling on the set you were allowed to
// ask for, and the six below are simply the ones the host's own surfaces
// happened to need.
//
// `(string & {})` opens it to the other thirty-odd while keeping the six as
// autocomplete. The alternative — naming all forty — was rejected twice over.
// It would put a copy of Monaco's registry in a file that does not own it, so
// every entry is either a lie until the next Monaco upgrade or a truth nobody
// re-checked. And it buys nothing for the callers that need the width, because
// they compute the language at run time from something that is already a
// string: an extension mapping a file path to a language has a `string` in
// hand, so a closed union would meet it with a cast at every call site and
// throw away the only thing a closed union is for.
//
// Kept identical to the host component's own declaration in
// apps/opencroft/components/code-editor.tsx — the two are the same type
// written twice, because this package deliberately declares rather than
// imports the runtime it describes.
export type CodeEditorLanguage = 'typescript' | 'javascript' | 'python' | 'shell' | 'json' | 'plaintext' | (string & {})

/** Which of the two renderings of the same pair of documents is on screen. */
export type CodeEditorDiffMode = 'unified' | 'split'

/**
 * Handed the editor and the `monaco` namespace once the editor is live —
 * @monaco-editor/react's own mount signature, passed straight through.
 *
 * The editor is a union because the two modes are two different editors, and
 * which one arrives follows `original`: given -> a diff editor, omitted -> an
 * ordinary one. A caller that takes both narrows at run time on the method
 * only the diff has — `'getModifiedEditor' in editor`.
 *
 * `monaco` is the second argument for a reason beyond convenience. Reaching
 * the namespace is the only way to construct the values its own APIs take
 * (`new monaco.Range(...)` for a decoration, say), and an extension bundle is
 * a browser ESM bundle with no runtime module resolver, so importing
 * `monaco-editor` for it is not open to you. Receiving it here is what lets an
 * extension install the `window.monaco` shim it would otherwise have no way to
 * obtain — and it is the host's one namespace, not a second copy.
 */
export type MonacoNamespace = typeof import('monaco-editor')
/** What `onMount` hands over when `original` is omitted. */
export type MonacoCodeEditor = import('monaco-editor').editor.IStandaloneCodeEditor
/** What `onMount` hands over when `original` is given. */
export type MonacoDiffEditor = import('monaco-editor').editor.IStandaloneDiffEditor

export type CodeEditorOnMount = (editor: MonacoCodeEditor | MonacoDiffEditor, monaco: MonacoNamespace) => void

/**
 * Monaco's folding of long runs of untouched context, in diff mode.
 *
 * Every field is optional and what is left out keeps the host's default, so a
 * caller that cares about one number does not have to restate the other two.
 */
export interface CodeEditorHideUnchangedRegions {
  /** Fold at all. Defaults to true. */
  enabled?: boolean
  /** Runs shorter than this are never folded — folding them saves nothing. Defaults to 4. */
  minimumLineCount?: number
  /** Unchanged lines kept either side of a change. Defaults to 3. */
  contextLineCount?: number
}

export interface CodeEditorProps {
  /** In diff mode (`original` given) this is the modified side. */
  value: string
  /**
   * The unchanged side of a diff. Given -> this renders a diff; omitted -> an
   * ordinary editor.
   *
   * Note that the two modes are two different components underneath
   * (@monaco-editor/react's `Editor` and `DiffEditor`), so flipping `original`
   * between undefined and defined remounts the editor and drops its undo
   * history. That is acceptable for the intended use — a file does not turn
   * into a diff mid-edit — but nothing in the type says so, so it is said here.
   */
  original?: string
  language?: CodeEditorLanguage
  /** Applies to the editable side only; `original` is always read-only. */
  readOnly?: boolean
  onChange?: (value: string) => void
  /** Reveal and place the cursor on this 1-based line once, on mount. */
  line?: number
  /**
   * Defaults to filling its container, which must have a definite height — in
   * diff mode it instead defaults to the content's own height, bounded, because
   * diffs are meant to sit inline in a column of other content.
   */
  height?: string | number
  /**
   * The escape hatch out of these props and into Monaco itself, for the things
   * no prop here can express: decorations, diff-change enumeration, mouse and
   * cursor and scroll subscriptions, pixel positions for an overlay. Without
   * it, an extension that needs any of those has to mount its own editor —
   * which is the one thing sharing this component exists to prevent.
   *
   * See `CodeEditorOnMount` for which editor arrives and how to tell.
   */
  onMount?: CodeEditorOnMount
  /**
   * Which diff rendering to show. Omitted, the mode is the component's own
   * state and its overlaid toggle drives it; given, you own it and this
   * becomes an ordinary controlled prop.
   *
   * For a surface whose diff mode is not the reader's private business but
   * part of a larger state — one already persisted, shared across several
   * diffs at once, or driven from a toolbar that belongs to you.
   */
  diffMode?: CodeEditorDiffMode
  /**
   * Fired when the component's own toggle is pressed. The way to keep that
   * toggle working while `diffMode` is controlled — without it a controlled
   * caller's toggle renders and does nothing, since the state it writes is not
   * the state being displayed.
   */
  onDiffModeChange?: (mode: CodeEditorDiffMode) => void
  /**
   * Draw the overlaid unified/split toggle. Defaults to true.
   *
   * Set false when you already have this control in your own toolbar —
   * otherwise `diffMode` gets you a second toggle sitting on top of the diff,
   * competing with the one you drew yourself.
   */
  showModeToggle?: boolean
  /**
   * Folding of long runs of untouched context, in diff mode. Defaults to
   * `{ enabled: true, minimumLineCount: 4, contextLineCount: 3 }`; an object
   * given here is merged over that, so naming one field keeps the others.
   *
   * `false` is the shorthand for showing the whole file, which is what a
   * caller offering its own "show full file" control needs — and also what a
   * caller revealing a deep-linked `line` needs, because folding can close
   * over the very line being revealed.
   */
  hideUnchangedRegions?: false | CodeEditorHideUnchangedRegions
}
/**
 * The host's code editor, in either of two modes: an ordinary editor, or —
 * given `original` — a diff against it, with a unified/split toggle of its own
 * that `diffMode` / `showModeToggle` let you take over.
 *
 * Provided here rather than imported from an editor package so every surface
 * shares one editor runtime — an extension bundle has no runtime module
 * resolver, so its own copy would initialise a second one.
 *
 * `onMount` is the way out of these props when they run out: it hands over the
 * editor and the `monaco` namespace, which between them reach everything
 * Monaco can do without a second editor being mounted to get at it.
 */
export declare const CodeEditor: FC<CodeEditorProps>
