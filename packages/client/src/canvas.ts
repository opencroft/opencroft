/**
 * `@opencroft/client/canvas` — graph nodes as an extension declares and draws
 * them: node definitions, handles and their pins, the inspector, context
 * menus, the canvas hooks, and command-bar modes.
 */
import type { ComponentType, FC, ReactNode } from 'react'

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
  /**
   * Stay mounted while the inspector shows this node, so leaving the tab and coming back finds it
   * as it was. It unmounts when the inspector closes or moves to another node.
   */
  keepMounted?: boolean
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
   * Consumers on the canvas get the value as returned, so it may be live, such
   * as a stream. They get a new context only when the value changes: plain
   * objects and arrays by content, anything else by identity, so an unchanged
   * live value must be the same instance each call.
   */
  exposeOutput?: (
    handleId: string,
    data: D,
    type: string,
    nodeId: string,
    contexts: Record<string, ResolvedContext>,
  ) => unknown
}

export interface HandlePinProps {
  /** The handle type: bare for one of this extension's own, qualified for another's. Also the default `id`. */
  type: string
  id?: string
  color?: string
  children?: ReactNode
}

/** An input pin on the node's left edge, with optional inline content; double-click disconnects it. */
export declare const InputHandle: FC<HandlePinProps>
/** An output pin on the node's right edge, with optional inline content; double-click disconnects it. */
export declare const OutputHandle: FC<HandlePinProps>

export declare const Handle: typeof import('@xyflow/react').Handle
export declare const Position: typeof import('@xyflow/react').Position
export declare const NodeResizer: typeof import('@xyflow/react').NodeResizer
export declare const useReactFlow: typeof import('@xyflow/react').useReactFlow
export declare const useUpdateNodeInternals: typeof import('@xyflow/react').useUpdateNodeInternals
export declare const useGraphNodes: typeof import('@xyflow/react').useNodes
export declare const useGraphEdges: typeof import('@xyflow/react').useEdges

export declare const NodeFrame: ComponentType<Record<string, unknown>>
export declare const NodeCard: ComponentType<Record<string, unknown>>
export declare const NodeCardHeader: ComponentType<Record<string, unknown>>
export declare const NodeCardContent: ComponentType<Record<string, unknown>>
export declare const useNodeAccent: () => string

/** The value wired into `targetHandleId` on `nodeId`, as the open canvas has it; null when nothing is wired. */
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

/**
 * The full canvas surface behind a Graph App instance -- editor, chat and
 * providers, pointed at the instance's graph. What the builtin Graph App's
 * component renders, and all it renders.
 */
export declare const GraphCanvas: FC<{ instanceId: string }>

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

/** Overlay control returned by useOverlay; activate(modeId, params?) opens a registered command mode. */
export interface OverlayControl {
  activate: (modeId: string, params?: unknown) => void
  dismiss: () => void
}
export declare const useOverlay: (slots?: Record<string, unknown>) => OverlayControl

export declare const CommandBar: ComponentType<Record<string, unknown>>
export declare const CommandBarMenu: ComponentType<Record<string, unknown>>
export declare const CommandBarMenuItem: ComponentType<Record<string, unknown>>
