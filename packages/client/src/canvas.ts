/**
 * `@opencroft/client/canvas` — graph nodes as an extension declares and draws
 * them: node definitions, handles and their pins, the inspector, context
 * menus, the canvas hooks, and command-bar modes.
 */
import type { NodeError } from '@opencroft/core'
import type { InlineValueFields, PrimitiveValue } from '@opencroft/core/values'
import type { ComponentType, CSSProperties, FC, ReactNode } from 'react'

/** A resolved context flowing through a connected edge. */
export interface ResolvedContext<V = unknown> {
  sourceNodeId: string
  sourceHandleId: string
  type: string
  value: V
}

/**
 * A handle a node declares. A target handle of a primitive type
 * (`builtin.core.string`, `.number`, `.boolean`, see `@opencroft/client/values`)
 * takes a value typed on the node's card while nothing is wired into it: the
 * host's `InputHandle` draws the field, stores it at `data.inputs.<id>`, and
 * `useInputValue` / the server's `ctx.input` read it. `InlineValueFields`
 * shapes that field (`default`, `integer`, `min`, `max`, `step`, `options`,
 * `multiline`, or `inline: false` for an input that must be wired). Declare
 * them the same in `extension.json`, which the server reads.
 */
export interface ExtensionHandle extends InlineValueFields {
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
  /**
   * For a target handle: it takes any number of edges. Without it a target
   * handle takes one edge, and connecting another, on the canvas or through
   * `connectNodes`, replaces the one there. Declare it the same in
   * `extension.json`, which the server reads.
   */
  multiple?: boolean
}

/**
 * A handle type this extension declares, by its bare id; the host qualifies
 * it with the extension's id. One with `cases` is an enum: a value of it is
 * one case's `value`, and an input of it gets a dropdown of the cases. Declare
 * it the same in `extension.json`, which the server reads.
 */
export interface ExtensionHandleType {
  id: string
  label: string
  color: string
  /** An enum's cases, in order: each `value` (`[A-Za-z0-9_.-]{1,64}`, unique) and the `label` shown for it. */
  cases?: { value: string; label?: string }[]
}

/** @deprecated Renamed `ExtensionHandleType`. */
export type ExtensionContextType = ExtensionHandleType

export interface ExtensionComponentProps<D = Record<string, unknown>> {
  id: string
  data: D
  selected?: boolean
}

/**
 * What an inspector tab is given. The tab renders again when `data` or `updateData` changes
 * identity, not when the node only moves or is resized. A tab that calls a hook reading the
 * graph (`useGraphNodes`, `useGraphEdges`, `useNodeContext`, `useInputValue`,
 * `useLiveNodeData`, `useContainingNodes`) renders on every move or resize of any node on the
 * canvas, through that hook's subscription.
 */
export interface ExtensionInspectorProps<D = Record<string, unknown>> {
  nodeId: string
  data: D
  /** Merges `patch` into the node's data. Keeps one identity while the inspector shows this node. */
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
  /**
   * The data a new node starts with, from the palette and from the graph's
   * createNodes alike; what a creator gives replaces it field by top-level
   * field. Plain JSON data: the server reads it off the built bundle, and a
   * value holding anything else (a host value, a function) is not applied to
   * nodes created there, which the build log says.
   */
  defaultData?: D
  /**
   * The node's body on the canvas. The canvas decides who takes the mouse
   * wheel and a one-finger drag over it: the body's content, only while the
   * node is selected and an element under the pointer can scroll; otherwise
   * the canvas, which zooms on the wheel and pans on the drag. A pinch, by
   * touchpad or two fingers, always zooms. An element can scroll when it
   * overflows on the wheel's or the drag's axis, or while it carries the
   * `data-scrolls-itself` attribute: content that handles the wheel itself
   * with no native scroll container (such as a terminal app reading it as
   * keys) sets that attribute for as long as it does. A one-finger drag that
   * lands on an element declaring `touch-action: none` (or inside one), such
   * as a slider's handle, is that element's too while the node is selected.
   * A tap and a long press reach the body as usual. The body needs no `nowheel` or `nopan` class,
   * and no wheel or touch handler of its own, for this. While the node is
   * unselected, the canvas's stylesheet gives every element of the body
   * `touch-action: none`, so nothing in it scrolls natively by touch, and on
   * a device with a touchscreen a kit `ScrollArea`'s scrollbar takes no
   * pointer, so a finger on it pans the canvas too.
   */
  component: ComponentType<ExtensionComponentProps<D>>
  inspector?: ComponentType<ExtensionInspectorProps<D>>
  /**
   * The `inspector` fills the inspector's body, below its tab strip, instead
   * of being wrapped in a scroll area that grows with it: the same choice as
   * an `InspectorTab`'s `fullHeight`. For an inspector holding something that
   * should take the height left to it and scroll inside itself, such as an
   * editor. It gets no padding there and lays out its own.
   */
  inspectorFullHeight?: boolean
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
  /**
   * What is wrong with the node that the open canvas can tell from its data
   * and wiring alone, such as a required output left unconnected. Shown with
   * the errors stored on the node (its card's indicator, its Errors tab), and
   * only on the canvas: an agent reading the node does not see these. One the
   * node already has stored (an action refused for the same reason) shows once.
   *
   * @deprecated Export a check from the server module's `nodeChecks`
   * (`NodeCheck` in `@opencroft/server/graph`) instead. It is told the same
   * node and edges, and its findings are stored on the node, so agents see
   * them too. Report anything an action finds with `graph.setNodeErrors`
   * (`@opencroft/server/graph`).
   */
  errors?: (node: { id: string; data: D }, edges: readonly NodeErrorEdge[]) => NodeError[]
}

/** An edge as `NodeDefinition.errors` is told it. */
export interface NodeErrorEdge {
  source: string
  target: string
  sourceHandle?: string | null
  targetHandle?: string | null
}

export interface HandlePinProps {
  /** The handle type: bare for one of this extension's own, qualified for another's. Also the default `id`. */
  type: string
  id?: string
  color?: string
  children?: ReactNode
  /**
   * What passes through the pin, shown as a tooltip on it: on hover, and on
   * touch from a press on the pin to the next press elsewhere.
   */
  tip?: ReactNode
}

/** An input pin on the node's left edge, with optional inline content; double-click disconnects it. */
export declare const InputHandle: FC<HandlePinProps>
/** An output pin on the node's right edge, with optional inline content; double-click disconnects it. */
export declare const OutputHandle: FC<HandlePinProps>

export declare const Handle: typeof import('@xyflow/react').Handle
export declare const Position: typeof import('@xyflow/react').Position
/**
 * React Flow's resizer. On a phone it follows the canvas's touch rules: only
 * while the canvas's move-nodes toggle is on, and then on the selected node,
 * as eight handles (corners and edge midpoints) a finger can hold at any zoom,
 * with the same size limits.
 */
export declare const NodeResizer: typeof import('@xyflow/react').NodeResizer
/**
 * The area a finger drags a node by, for a node that draws its own title bar:
 * put it in the bar, which must be `relative isolate`. On a phone, while the
 * canvas's move-nodes toggle is on, it keeps the bar's drag area at least 44
 * px tall on screen at any zoom, growing up from the bar's bottom edge, behind
 * the bar's controls. Otherwise it draws nothing. `NodeFrame` has one already.
 */
export declare const NodeDragArea: FC

export interface WindowShellProps {
  /** The node's id. */
  id: string
  selected?: boolean
  loading?: boolean
  icon: ComponentType<{ className?: string }>
  iconClassName?: string
  title: string
  /** Classes of the body, `bg-card` unless given. */
  bodyClassName?: string
  /** The input pin in the title bar, on the window's left edge. */
  input?: ReactNode
  /**
   * Input pins of their own, each with its label, in a column under the title bar, on the window's
   * left edge: for a window with more than one input.
   */
  inputs?: ReactNode
  /** Controls in the title bar, before its close. They take clicks, so each carries `nodrag nopan`. */
  actions?: ReactNode
  /** The body: it fills the window below the title bar, inset a little, and clips what overflows. */
  children: ReactNode
  /** The smallest the window is resized to: 300 wide and 200 high unless given. */
  minWidth?: number
  minHeight?: number
  /**
   * The size the window is drawn at on an axis its node holds no size of its own: a node created
   * with none, such as one from a palette category other than Windows or one an agent created
   * without a size. Resizing gives the node a size, which wins from then on. Unset, such a node is
   * as big as its content.
   */
  defaultSize?: { width: number; height: number }
  /**
   * Shows the title bar's close, which removes the node. On by default; off for a window whose
   * node holds content of its own, where one stray click would delete it.
   */
  closable?: boolean
}

/**
 * A node drawn as a window, as the Terminal Window and Markdown nodes are: a card resizable from
 * its edges and corners, snapping to the grid on release, with a title bar to drag it by and a body that fills
 * the rest. Its resizer and title bar follow the canvas's touch rules (see `NodeResizer` and
 * `NodeDragArea`), and its body the wheel and touch rules of `NodeDefinition.component`. Nodes of a
 * palette category other than Windows are created with no size, so such a window gives a
 * `defaultSize`.
 */
export declare const WindowShell: FC<WindowShellProps>
export declare const useReactFlow: typeof import('@xyflow/react').useReactFlow
export declare const useUpdateNodeInternals: typeof import('@xyflow/react').useUpdateNodeInternals
/**
 * The graph's nodes as stored, on every level. A node inside a frame or a
 * subgraph has its id as `parentId`. Its `position` is relative to the frame's
 * top-left corner, or to the canvas of the subgraph it is directly inside.
 * Where a node on the open level is drawn is
 * `useInternalNode(id).internals.positionAbsolute`.
 */
export declare const useGraphNodes: typeof import('@xyflow/react').useNodes
/**
 * The graph's edges as wired, as `listEdges` gives them on the server: a chain
 * through a subgraph's ports reads as one edge from its source to its target,
 * whichever levels they are on, and the stored edges to and from a port are
 * not listed on their own.
 */
export declare const useGraphEdges: typeof import('@xyflow/react').useEdges

export declare const NodeFrame: ComponentType<Record<string, unknown>>

export interface CanvasFrameProps {
  /** The frame node's id: resizing writes the new size to that node. */
  id: string
  selected?: boolean
  color: string
  icon: ComponentType<{ className?: string; style?: CSSProperties }>
  label: string
  /** Shown under the label. */
  children?: ReactNode
}

/**
 * The body of a frame node, one whose palette category is `Organization`: a
 * tinted, resizable area with its icon and label. The canvas draws such nodes
 * behind the others; the nodes placed in one are its children and move with
 * it, and it cannot be resized past their top-left corners.
 */
export declare const CanvasFrame: FC<CanvasFrameProps>

/** A frame a node is inside, as `useContainingNodes` returns it. */
export interface ContainingNode {
  id: string
  /** The node's stored, qualified type. */
  type?: string
  /** Where its top-left corner is drawn on the canvas. */
  position: { x: number; y: number }
  data: Record<string, unknown>
}

/**
 * The frames `nodeId` is inside, innermost first, as the open canvas has
 * them: what a node action's `containingNodes` answers on the server. `type`
 * narrows them: bare for one of the extension's own types, qualified for any
 * extension's.
 */
export declare const useContainingNodes: (nodeId: string, type?: string) => ContainingNode[]
export declare const NodeCard: ComponentType<Record<string, unknown>>
export declare const NodeCardHeader: ComponentType<Record<string, unknown>>
export declare const NodeCardContent: ComponentType<Record<string, unknown>>
export declare const useNodeAccent: () => string

/** The value wired into `targetHandleId` on `nodeId`, as the open canvas has it; null when nothing is wired. */
export declare const useNodeContext: <V = unknown>(nodeId: string, targetHandleId: string) => ResolvedContext<V> | null

/**
 * What the value input `targetHandleId` of `nodeId` reads on the open canvas,
 * as `inputValue` (`@opencroft/client/values`) gives it: the wired value, else
 * the value typed on the card, else the handle's `default`; undefined when
 * there is none, or while a wired source exposes nothing. A node action's
 * `ctx.input` reads the same on the server. Undefined for a handle that is not
 * one of the node's declared primitive inputs.
 */
export declare const useInputValue: (nodeId: string, targetHandleId: string) => PrimitiveValue | undefined

/**
 * `nodeId`'s data with its wired inputs as the open canvas has them, in the
 * shape the server's context resolution writes into a node's data and hands
 * `exposeOutput`: `__resolvedContexts` (each wired input's context, by target
 * handle id) and `__unresolvedInputs` (the wired inputs whose source exposes
 * nothing). What a card reads to show what its node computes now, with the
 * same function its `exposeOutput` computes it with. Undefined while the node
 * is not on the canvas.
 */
export declare const useLiveNodeData: (nodeId: string) => Record<string, unknown> | undefined

/**
 * A handle type an extension declares, by its qualified id
 * (`<owner>.<extension>.<type>`), as the loaded extensions declare it: an
 * enum's with its `cases`. Undefined for a type no loaded extension declares.
 */
export declare const handleTypeOf: (type: string) => ExtensionHandleType | undefined

/**
 * Every enum the loaded extensions declare: each handle type that declares
 * `cases`, by its qualified id. What a type picker offers beside the value
 * types.
 */
export declare const enumHandleTypes: () => ExtensionHandleType[]

/**
 * Writes `nodeId`'s data from its card: the patch is merged into the data, as
 * the inspector's `updateData` merges it, one undo step per field edited. For
 * a setting edited in place on the card. Outside a canvas it writes nothing.
 */
export declare const useUpdateNodeData: (nodeId: string) => (patch: Record<string, unknown>) => void

/**
 * What the inspector shows for a node. `tab` is remembered per node type, so every node of the
 * type opens on the tab last picked or opened on any of them (a node without that tab opens on
 * Details). `instanceId` is the node's own: which of its containers or terminals its tabs show.
 */
export interface InspectorIntent {
  tab?: string
  instanceId?: string
  tabRequestId?: number
}
export declare const inspectorIntent: {
  get: (nodeId: string) => InspectorIntent
  /**
   * Shows `nodeId` in the inspector on `tab`: the canvas selects that node alone and brings it into
   * view. The tab becomes the one remembered for the node's type.
   */
  open: (nodeId: string, tab: string, instanceId?: string) => void
  /** Remembers `tab` for the node's type. */
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
