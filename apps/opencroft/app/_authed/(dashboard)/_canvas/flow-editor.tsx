'use client'

import {
  handleTakes,
  inputValue,
  isEnumHandle,
  isPrimitiveValue,
  type PrimitiveValue,
  takesSeveralTypes,
} from '@opencroft/core/values'
import {
  addEdge,
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type IsValidConnection,
  type Node,
  type NodeChange,
  type NodeTypes,
  type OnBeforeDelete,
  type OnEdgesChange,
  type OnNodesChange,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useStoreApi,
} from '@xyflow/react'
import { SelectionMode } from '@xyflow/system'
import '@xyflow/react/dist/style.css'

import { useNavigate, useSearch } from '@tanstack/react-router'
import { cn } from 'cn'
import { Box, Move } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useSeedPendingRequests } from '@/app/_authed/(approvals)/_components/mcp-request-list'
import { McpRequestNotifications } from '@/app/_authed/(approvals)/_components/mcp-request-notifications'
import { type ArrangeAction, arrangeSelected } from '@/app/_authed/(dashboard)/_canvas/arrange-layout'
import type { CommandNodeEntry } from '@/app/_authed/(dashboard)/_canvas/canvas-command-bar'
import { CanvasOverlay } from '@/app/_authed/(dashboard)/_canvas/canvas-overlay'
import { isCanvasMenuTouchTarget } from '@/app/_authed/(dashboard)/_canvas/canvas-touch-guard'
import { TOUCH_SLOP_PX } from '@/app/_authed/(dashboard)/_canvas/click-cycle'
import { CommentNode } from '@/app/_authed/(dashboard)/_canvas/comment-node'
import { recordReloadClear, recordReloadSettled } from '@/app/_authed/(dashboard)/_canvas/ctrlg-debug'
import { clientPointOf } from '@/app/_authed/(dashboard)/_canvas/drag-pointer'
import {
  DropTargetContext,
  NO_DROP_TARGETS,
  updatedTargets,
} from '@/app/_authed/(dashboard)/_canvas/drop-target-context'
import { FlowContextMenu } from '@/app/_authed/(dashboard)/_canvas/flow-context-menu'
import { stackedFrame } from '@/app/_authed/(dashboard)/_canvas/frame-stacking'
import '@/app/_authed/(dashboard)/_canvas/flow-editor.css'

import { nodeName } from '@opencroft/core/values'
import { useIsMobile } from 'ui/hooks/use-mobile'
import { LogoLoader } from 'ui/logo-loader'
import type { GraphOutlineDrop } from 'ui/nodes/graph-outline'
import { GraphPath } from 'ui/nodes/graph-path'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from 'ui/resizable'
import { useSidebar } from 'ui/sidebar'

import {
  focusCanvasOnDrop,
  focusCanvasOnPress,
  keepFocusOnCanvas,
} from '@/app/_authed/(dashboard)/_canvas/canvas-key-scope'
import { routeCanvasTouch } from '@/app/_authed/(dashboard)/_canvas/canvas-touch'
import { undoKeyAction } from '@/app/_authed/(dashboard)/_canvas/canvas-undo-keys'
import { routeCanvasWheel } from '@/app/_authed/(dashboard)/_canvas/canvas-wheel'
import { ExtensionsStateContext } from '@/app/_authed/(dashboard)/_canvas/extensions-ready-context'
import { captureFieldDragSelect } from '@/app/_authed/(dashboard)/_canvas/field-drag-select'
import { fitViewOnOpen, useFitWhenMeasured } from '@/app/_authed/(dashboard)/_canvas/fit-view-on-open'
import { withCurrentSelection } from '@/app/_authed/(dashboard)/_canvas/graph-view-state'
import { revealViewport, selectOnly } from '@/app/_authed/(dashboard)/_canvas/inspect-node'
import { InspectorContext, useInspectorState } from '@/app/_authed/(dashboard)/_canvas/inspector-context'
import { inspectorIntent, registerNodeTypes } from '@/app/_authed/(dashboard)/_canvas/inspector-intent'
import { inspectorPlacement } from '@/app/_authed/(dashboard)/_canvas/inspector-placement'
import { useLevelViewports } from '@/app/_authed/(dashboard)/_canvas/level-viewports'
import { NodeContextMenu } from '@/app/_authed/(dashboard)/_canvas/node-context-menu'
import { subscribeNodeDataUpdates } from '@/app/_authed/(dashboard)/_canvas/node-data-events'
import { type BrowserTab, NodeBrowser, NodeInspector } from '@/app/_authed/(dashboard)/_canvas/node-inspector'
import { nodeSelection } from '@/app/_authed/(dashboard)/_canvas/node-selection'
import { graphNodeTypes, nodeTypesKey, typesFromKey } from '@/app/_authed/(dashboard)/_canvas/node-type-keys'
import { buildNodeTypes } from '@/app/_authed/(dashboard)/_canvas/node-wrapper'
import { moveFromOutline } from '@/app/_authed/(dashboard)/_canvas/outline-move'
import { useBackIntercept, useOverlay } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { viewportCentre } from '@/app/_authed/(dashboard)/_canvas/paste-layout'
import { coalesceReload, type ReloadCoalesceState } from '@/app/_authed/(dashboard)/_canvas/reload-coalesce'
import { SubgraphBoundary, SubgraphDataWriterContext } from '@/app/_authed/(dashboard)/_canvas/subgraph-boundary'
import {
  boundaryOf,
  canvasHandles,
  edgesKeptByPorts,
  edgesOnCanvas,
  handlesConnect,
  INPUTS_BOUNDARY_TYPE,
  levelName,
  levelPath,
  levelsChanged,
  NEW_PORT_HANDLE,
  narrowedInput,
  nodesOnLevel,
  OUTPUTS_BOUNDARY_TYPE,
  slotConnection,
  storedConnection,
} from '@/app/_authed/(dashboard)/_canvas/subgraph-level'
import { MoveModeContext } from '@/app/_authed/(dashboard)/_canvas/touch-move-mode'
import { useClickCycle } from '@/app/_authed/(dashboard)/_canvas/use-click-cycle'
import { useClipboard } from '@/app/_authed/(dashboard)/_canvas/use-clipboard'
import { useGraphEvents } from '@/app/_authed/(dashboard)/_canvas/use-graph-events'
import { describeUndoResult, type LiveGraphStart, useLiveGraph } from '@/app/_authed/(dashboard)/_canvas/use-live-graph'
import { useSectionAutolayout } from '@/app/_authed/(dashboard)/_canvas/use-section-autolayout'
import { useStoreDelete } from '@/app/_authed/(dashboard)/_canvas/use-store-delete'
import { useSubgraphDoubleClick } from '@/app/_authed/(dashboard)/_canvas/use-subgraph-double-click'
import { type Area, areaWithin, centreViewport, fitViewport } from '@/app/_authed/(dashboard)/_canvas/visible-area'
import { sectionBoxAround, wrapInSection } from '@/app/_authed/(dashboard)/_canvas/wrap-in-section'
import { resolveInputContexts } from '@/app/_authed/(dashboard)/_extension-system/context-resolver'
import { installExtensionApi } from '@/app/_authed/(dashboard)/_extension-system/extension-api'
import { valueHandleOf } from '@/app/_authed/(dashboard)/_extension-system/use-node-context'
import {
  isAutolayoutSection,
  SECTION_TYPE,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import { isSubgraph, SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { choicesFeeding } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/value-nodes-shared'
import { CanvasGraphContext } from '@/app/_authed/(extension-runtime)/_client/canvas-graph'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { CanvasWriters } from '@/app/_authed/(extension-runtime)/_client/node-data-writer'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import {
  absolutePositions,
  askedToDelete,
  byIdOf,
  deletedWithContents,
  deleteKeepingChildren,
  depthOf,
  dragDropTarget,
  dropAtPoint,
  dropPlaced,
  edgesAskedToDelete,
  growToHold,
  levelOf,
  membersStayDrawn,
  parentsFirst,
  placedRoots,
} from '@/app/_authed/(extension-runtime)/_frame-tree'
import { isFrameType, newNodeLayout } from '@/app/_authed/(extension-runtime)/_frames'
import {
  drawnSize,
  GRID_STEP,
  snapMovedNode,
  snapResizedNode,
  snapToGrid,
} from '@/app/_authed/(extension-runtime)/_grid'
import { edgesReplacedBy } from '@/app/_authed/(extension-runtime)/_input-edges'
import { dataOnConnect } from '@/app/_authed/(extension-runtime)/_input-types'
import { newNodeData } from '@/app/_authed/(extension-runtime)/_node-defaults'
import { expandSubgraph, makeSubgraph } from '@/app/_authed/(extension-runtime)/_subgraph-gestures'
import { type ExtensionHandle, findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { loopRefusal, valueLoop } from '@/app/_authed/(extension-runtime)/_value-loops'
import { fetchSpaceGraph } from '@/app/_authed/(space)/_components/space-client'
import { findTakenGraphIds } from '@/app/_authed/(space)/_server/actions'
import { useSSEEvents, useSSEEventsDispatch } from '@/app/_authed/(sse)/_lib/sse-events-store'
import { useRememberedLayout } from '@/app/_lib/layout-storage'
import { AppSidebar } from '@/app/_shell/app-sidebar'
import { AppViewport } from '@/app/_shell/app-viewport'
import { newGraphId } from '@/lib/graph-id'

installExtensionApi()

interface PendingConnection {
  fromNodeId: string
  fromHandleId: string
  fromRole: 'source' | 'target'
  /** The qualified handle type the dragged handle carries. */
  handleType: string
  /** The types the dragged handle takes, when it is an input that takes several. */
  accepts?: string[]
  /** The dragged handle takes every enum too, when it is an input that takes several. */
  acceptsEnums?: boolean
}

interface MenuState {
  screen: { x: number; y: number }
  flow: { x: number; y: number }
  pending?: PendingConnection
}

/**
 * Runs `run` two frames on, for a view framed after a selection: selecting can
 * open the docked inspector, which narrows the visible area, and the flow
 * learns the pane's new size from a resize observer that runs after the next
 * frame's layout.
 */
function afterLayout(run: () => void) {
  requestAnimationFrame(() => requestAnimationFrame(run))
}

/** Whether `n` is a frame, which holds other nodes by area (see `isFrameType`). */
function isFrameNode(n: Node): boolean {
  const resolved = n.type ? extensionRegistry.resolveNode(n.type) : undefined
  return resolved ? isFrameType(resolved) : false
}

/** The handles a node type declares, as its extension registered them. */
function declaredHandles(type: string) {
  return extensionRegistry.resolveNode(type)?.handles ?? []
}

/** Whether `type` is an enum a loaded extension declares. */
function isEnumType(type: string): boolean {
  return extensionRegistry.enumCasesOf(type) !== undefined
}

/** The id an edge being drawn is checked under, before it has one of its own. */
const CANDIDATE_EDGE = 'candidate'

/**
 * Whether a handle of the opposite role to a pending connection's takes it
 * (see `handleTakes`): `pending.handleType` is the type at the end being
 * dragged from, and `pending.accepts` and `acceptsEnums` what that end takes
 * when it is an input that takes several types.
 */
function takesPending(pending: PendingConnection, handle: ExtensionHandle): boolean {
  if (handle.role === pending.fromRole) {
    return false
  }
  if (pending.fromRole === 'source') {
    return handleTakes(handle, pending.handleType, { isEnum: isEnumType(pending.handleType) })
  }
  const dragged = { handleType: pending.handleType, accepts: pending.accepts, acceptsEnums: pending.acceptsEnums }
  return handleTakes(dragged, handle.handleType, { isEnum: isEnumType(handle.handleType) })
}

// The top level's segment id in the path, where a subgraph's level is its id.
const TOP_LEVEL = ''

async function loadLocalExtensions(): Promise<void> {
  try {
    await loadAllExtensions()
  } catch (err) {
    console.error('Failed to load extensions', err)
    toast.error('Some extensions failed to load')
  }
}

export function FlowEditor({
  slug,
  spaceName,
  graphName,
}: {
  slug: string
  spaceName: string
  /** The graph's name, the first segment of an open subgraph's path; the space's name when left out. */
  graphName?: string
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  // The open level: a subgraph's canvas, named by `?subgraph=<id>` in the URL,
  // or the top level. An id that names no subgraph opens the top level.
  const search = useSearch({ strict: false }) as { subgraph?: unknown }
  const navigate = useNavigate()
  const requestedLevel = typeof search.subgraph === 'string' ? search.subgraph : undefined
  const level = requestedLevel && isSubgraph(nodes.find((n) => n.id === requestedLevel)) ? requestedLevel : undefined
  // Each opening is a history entry, so browser Back goes up a level.
  const openLevel = useCallback(
    (id: string | undefined, { replace = false }: { replace?: boolean } = {}) => {
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, subgraph: id }),
        replace,
      } as unknown as Parameters<typeof navigate>[0])
    },
    [navigate],
  )
  // The boundaries' sizes as React Flow measured them: they are not in the graph.
  const [boundarySizes, setBoundarySizes] = useState<ReadonlyMap<string, { width: number; height: number }>>(
    () => new Map(),
  )
  const storedGraph = useMemo(() => ({ nodes, edges }), [nodes, edges])
  // Two independent readiness flags, not one. The graph decides whether there is
  // anything to paint; the extensions decide only how completely each node can
  // be drawn. Collapsing them into a single flag is what held the whole canvas
  // behind the slower of the two.
  const [graphReady, setGraphReady] = useState(false)
  // A fit waiting for measured nodes: decided once per graph, from the nodes it
  // opened with (see fitViewOnOpen), and asked for on arriving at a level for
  // the first time (see useLevelViewports).
  const [fitView, setFitView] = useState(false)
  const [extensionsSettled, setExtensionsSettled] = useState(false)
  const [extensionsVersion, setExtensionsVersion] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [inspectorExpanded, setInspectorExpanded] = useState(false)
  const [browserTab, setBrowserTab] = useState<BrowserTab>('outline')
  const inspector = useInspectorState()
  const overlay = useOverlay()
  const isMobile = useIsMobile()
  const [mobileInspectorVisible, setMobileInspectorVisible] = useState(false)
  const [nodesMovable, setNodesMovable] = useState(false)
  const [nodeMenu, setNodeMenu] = useState<{ screen: { x: number; y: number }; nodeId: string } | null>(null)
  const [overlayActive, setOverlayActive] = useState(false)
  const { setOpen: setSidebarOpen, setOpenMobile: setSidebarOpenMobile } = useSidebar()

  // Back button closes inspector on mobile
  useBackIntercept(isMobile && mobileInspectorVisible, () => setMobileInspectorVisible(false))
  const { resolvedTheme } = useTheme()
  const { screenToFlowPosition, deleteElements, getInternalNode, getNodesBounds, setViewport } = useReactFlow()
  const flowStore = useStoreApi()
  const storeDelete = useStoreDelete()
  // Set once the graph is fetched; the canvas writes through the graph's
  // document from then on.
  const [liveStart, setLiveStart] = useState<LiveGraphStart | null>(null)
  const { live, requestWrite, layoutWriter } = useLiveGraph({
    slug,
    start: liveStart,
    nodes,
    edges,
    setNodes,
    setEdges,
  })
  useSectionAutolayout({ nodes, edges, setNodes, requestWrite, layoutWriter })
  // The editor (canvas and inspector) and the canvas element, for focus to
  // return to the canvas when the element holding it is deleted.
  const [editorElement, setEditorElement] = useState<HTMLDivElement | null>(null)
  const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null)
  useEffect(
    () => (editorElement && canvasElement ? keepFocusOnCanvas(editorElement, canvasElement) : undefined),
    [editorElement, canvasElement],
  )
  useEffect(() => (canvasElement ? routeCanvasWheel(canvasElement) : undefined), [canvasElement])
  // The canvas fills the App's viewport, under the sidebar and the docked
  // panels; the canvas panel is the part of it nothing lies over, and what a
  // framed view aims at (see visible-area).
  const [canvasPanel, setCanvasPanel] = useState<HTMLDivElement | null>(null)
  const visibleArea = useCallback((): Area => {
    if (canvasElement && canvasPanel) {
      return areaWithin(canvasElement.getBoundingClientRect(), canvasPanel.getBoundingClientRect())
    }
    const { width, height } = flowStore.getState()
    return { left: 0, top: 0, width, height }
  }, [canvasElement, canvasPanel, flowStore])
  /** Fits the view to these nodes, or to all of them, in the visible area. */
  const frameNodes = useCallback(
    (nodeIds: string[] | undefined, { padding, duration }: { padding: number; duration?: number }) => {
      const { nodeLookup, minZoom, maxZoom } = flowStore.getState()
      // All of them is all on the open level: the others are hidden.
      const framed = nodeIds ?? [...nodeLookup.values()].filter((n) => !n.hidden).map((n) => n.id)
      if (framed.length === 0) {
        return
      }
      setViewport(fitViewport(getNodesBounds(framed), visibleArea(), { minZoom, maxZoom, padding }), { duration })
    },
    [flowStore, getNodesBounds, setViewport, visibleArea],
  )
  // Single-flight guard for the SSE-triggered extension reload effect below --
  // see reload-coalesce.ts for why concurrent reloads can't just run independently.
  const extensionsReloadRef = useRef<ReloadCoalesceState>({ inFlight: false, pending: false, nextRun: null })
  const sse = useSSEEvents()
  useSeedPendingRequests()

  const allNodes = useMemo(() => {
    void extensionsVersion
    return extensionRegistry.allNodes()
  }, [extensionsVersion])
  // Both readiness facts in one value, so the node wrappers re-render once when
  // extensions settle rather than twice. `version` is here for its identity
  // alone — a wrapper resolves its component from the registry during render,
  // and the registry is not reactive, so a write to it has to reach React as a
  // changed context value or the node keeps drawing its old answer.
  const extensionsState = useMemo(
    () => ({ settled: extensionsSettled, version: extensionsVersion }),
    [extensionsSettled, extensionsVersion],
  )
  // The set of node types the graph contains, flattened to one string.
  //
  // Keyed on the SET rather than on `nodes` on purpose: this recomputes on every
  // graph change, including each frame of a drag, but its VALUE only moves when
  // a type first appears or the last node of a type goes away.
  const graphTypesKey = useMemo(() => nodeTypesKey(graphNodeTypes(nodes)), [nodes])
  // Deliberately narrow dependency array: not `nodes`, `allNodes` or
  // `extensionsVersion`.
  //
  // The only thing that changes which entries exist is the set of types in the
  // graph. A new map keeps each shared type's component (see buildNodeTypes), so
  // the nodes already drawn stay mounted; building it once per set rather than
  // per render keeps the flow library's "new nodeTypes object" warning to the
  // moments a type comes or goes.
  //
  // The registered extensions are deliberately absent. An entry does not hold a
  // component, it holds a wrapper that resolves one during render, so an entry
  // does not need rebuilding when its extension registers — it starts resolving
  // on the next render, which the readiness context triggers.
  //
  // `comment` is assigned after the spread so it keeps its own component even
  // though the graph's types feed the map.
  const nodeTypes = useMemo(
    () =>
      ({
        ...buildNodeTypes(typesFromKey(graphTypesKey)),
        comment: CommentNode,
        [INPUTS_BOUNDARY_TYPE]: SubgraphBoundary,
        [OUTPUTS_BOUNDARY_TYPE]: SubgraphBoundary,
      }) as unknown as NodeTypes,
    [graphTypesKey],
  )
  // On mobile, xyflow's own pane-pan gesture (d3-zoom, driven by
  // panOnDrag={true} below) claims a touchstart the instant it lands --
  // including one that starts on a node -- via event.stopImmediatePropagation()
  // in its touchstarted handler (d3-zoom's own touchstarted, before any
  // movement is known, so a stationary tap or hold is claimed exactly the
  // same as an actual pan). xyflow's own escape hatch for this is the 'nopan'
  // class, which it only applies itself to a node when that node is
  // draggable. Without it, our own long-press handling below
  // (handleTouchStart) never even sees the touchstart, because propagation
  // never reaches the wrapper div it's attached to -- which is the actual
  // mechanism behind the context menu never opening on a phone.
  //
  // This is not a restoration of behavior mobile ever actually had. Before
  // nodesDraggable/nodesMovable defaulted off (nodes draggable by default,
  // no lock), a node's OWN drag handler (XYDrag, from the same @xyflow/react
  // + d3-drag stack, attached directly to the node whenever it's draggable)
  // called the identical stopImmediatePropagation on touchstart, for the
  // same reason -- confirmed directly, against byte-identical
  // @xyflow/react/d3-drag/d3-zoom versions to the ones running today, going
  // back to the mobile long-press handling's own original introduction.
  // Node-drag and pane-pan are mutually exclusive on the same touch by
  // construction (whichever is enabled preempts the touch before the other
  // ever sees it) -- so "pan starting on a node" never coexisted with a
  // working long-press menu either, in any configuration this app has run.
  // 'nopan' on every mobile node is the first configuration where a touch
  // landing on a node reaches this handler at all.
  //
  // A frame stays below the nodes it holds while selected, and above the
  // frames it is in (see stackedFrame). React Flow needs every parent before
  // its children; a node dropped into a frame later in the list is moved.
  //
  // React Flow holds the open level's view of the graph (see nodesOnLevel and
  // edgesOnCanvas): the graph's own `nodes` and `edges` stay as stored.
  const nodesForFlow = useMemo(() => {
    const byId = byIdOf(nodes)
    return parentsFirst(nodesOnLevel(nodes, level, boundarySizes)).map((n) => {
      const stacked = isFrameNode(n) ? stackedFrame(n, depthOf(n.id, byId)) : n
      return isMobile ? { ...stacked, className: cn(n.className, 'nopan') } : stacked
    })
  }, [nodes, level, boundarySizes, isMobile])
  const edgesForFlow = useMemo(() => edgesOnCanvas(edges, nodes), [edges, nodes])
  // A node's handles as the canvas has them: a subgraph's and a boundary's from the ports.
  const handlesOfCanvasNode = useCallback(
    (nodeId: string) =>
      canvasHandles(
        boundaryOf(nodeId) ? ({ id: nodeId } as Node) : nodes.find((n) => n.id === nodeId),
        nodes,
        declaredHandles,
        extensionRegistry.enumCasesOf,
      ),
    [nodes],
  )
  const selected = nodes.find((n) => n.selected && n.type !== 'comment') ?? null
  // The right-hand panel exists only for something to inspect.
  const inspectorOpen = selected !== null || Boolean(inspector.inspectorNode)
  // Docked, resized by the same handle as a docked chat and remembered per
  // browser, or covering the screen (see inspectorPlacement).
  const {
    expanded,
    docked: inspectorDocked,
    covers: inspectorCovers,
  } = inspectorPlacement({
    open: inspectorOpen,
    isMobile,
    expanded: inspectorExpanded,
    mobileVisible: mobileInspectorVisible,
  })
  const inspectorLayout = useRememberedLayout('graph-inspector', inspectorDocked ? ['canvas', 'inspector'] : ['canvas'])

  // Hand the selected node to the surrounding selection scope, when there is
  // one. A dashboard mounts none, and `useOptionalSelection` answering null
  // there is the design rather than missing wiring -- the scope belongs to the
  // surface, and only a space has a chat to read it.
  //
  // What is disclosed, and why it is narrow, lives in `nodeSelection` beside
  // its own tests rather than here.
  const selectionScope = useOptionalSelection()
  const publishSelection = selectionScope?.setSelection
  const selectedId = selected?.id ?? null
  const selectedType = selected?.type ?? null
  const selectedData = selected?.data

  // Keyed on the parts rather than on `selected`, which is a fresh object on
  // most renders: keying on it would republish an unchanged selection
  // continuously.
  useEffect(() => {
    if (!publishSelection) {
      return
    }
    publishSelection(
      selectedId ? nodeSelection({ id: selectedId, type: selectedType ?? undefined, data: selectedData }) : null,
    )
  }, [publishSelection, selectedId, selectedType, selectedData])
  // Every node of the graph, at every level; one off the open level carries where it is.
  const commandNodes = useMemo<CommandNodeEntry[]>(() => {
    void extensionsVersion
    const byId = byIdOf(nodes)
    const paths = new Map<string | undefined, string>()
    const pathOf = (nodeLevel: string | undefined) => {
      if (!paths.has(nodeLevel)) {
        paths.set(nodeLevel, levelName(nodeLevel, byId, graphName ?? spaceName))
      }
      return paths.get(nodeLevel)
    }
    return nodes
      .filter((n) => n.type !== 'comment')
      .map((n) => {
        const resolved = n.type ? extensionRegistry.resolveNode(n.type) : undefined
        const data = (n.data ?? {}) as Record<string, unknown>
        const nodeLevel = levelOf(n.id, byId)
        return {
          id: n.id,
          label: nodeName(data, resolved?.name, n.id),
          subtitle: resolved?.name ?? n.type ?? '',
          data,
          icon: resolved?.icon ?? Box,
          accent: resolved?.accent ?? 'var(--muted-foreground)',
          ...(nodeLevel !== level ? { path: pathOf(nodeLevel) } : {}),
        }
      })
  }, [nodes, extensionsVersion, level, graphName, spaceName])

  // A node to focus once its level, opened for it, is on the canvas.
  const focusAfterOpen = useRef<string | null>(null)
  const focusNode = useCallback(
    (nodeId: string) => {
      if (!getInternalNode(nodeId)) {
        return
      }
      const nodeLevel = levelOf(nodeId, byIdOf(nodes))
      if (nodeLevel !== level) {
        focusAfterOpen.current = nodeId
        openLevel(nodeLevel)
        return
      }
      setNodes((nds) => selectOnly(nds, nodeId))
      // Centred in the visible area as it is once the selection has opened the
      // docked inspector, if it does.
      afterLayout(() => {
        const node = getInternalNode(nodeId)
        if (!node) {
          return
        }
        const { x, y } = node.internals.positionAbsolute
        const centre = { x: x + (node.measured.width ?? 0) / 2, y: y + (node.measured.height ?? 0) / 2 }
        setViewport(centreViewport(centre, 1, visibleArea()), { duration: 300 })
      })
    },
    [getInternalNode, setViewport, setNodes, visibleArea, nodes, level, openLevel],
  )

  const dispatchSSEEvent = useSSEEventsDispatch()

  useGraphEvents({
    setNodes,
    onDismissComment: (nodeId) => {
      dispatchSSEEvent({ type: 'clear_comment', nodeId })
    },
    onFocusNode: (nodeId) => frameNodes([nodeId], { padding: 0.4, duration: 400 }),
  })

  const fitOnOpen = useCallback(() => {
    setFitView(false)
    frameNodes(undefined, { padding: 0.1 })
  }, [frameNodes])
  useFitWhenMeasured(fitView, fitOnOpen)

  // An id in the URL that names no subgraph of this graph (deleted, or never
  // one) opens the top level, in place of the entry that named it.
  useEffect(() => {
    if (graphReady && requestedLevel && !level) {
      openLevel(undefined, { replace: true })
    }
  }, [graphReady, requestedLevel, level, openLevel])

  // Arriving at a level focuses the node it was opened for, if any, or else
  // fits a level shown for the first time. Only one of them moves the canvas:
  // a fit still waiting for measured nodes would land after the focus. Nothing
  // stays selected across levels: the inspector would show a node no longer
  // drawn.
  const arriveOnLevel = useCallback(
    (fit: boolean) => {
      setNodes((nds) => (nds.some((n) => n.selected) ? nds.map((n) => ({ ...n, selected: false })) : nds))
      const pending = focusAfterOpen.current
      if (pending) {
        focusAfterOpen.current = null
        afterLayout(() => focusNode(pending))
      } else if (fit) {
        setFitView(true)
      }
    },
    [setNodes, focusNode],
  )
  useLevelViewports({ ready: graphReady, level, arrived: arriveOnLevel })

  useEffect(() => {
    // The graph and the extensions are independent, and now they are applied
    // independently too. Fetching them together already stopped time to first
    // paint being their sum; applying them separately makes it the graph's
    // alone, with each node filling in when its extension registers.
    let current = true
    setGraphReady(false)
    setExtensionsSettled(false)
    const extensions = loadLocalExtensions()
    const graphResult = fetchSpaceGraph(slug)
    setLiveStart(null)
    graphResult.then(({ graph, live: session }) => {
      // Two results settling separately means two chances for a previous
      // space's response to arrive after the slug changed, where there used to
      // be one. Drop anything belonging to a space already navigated away from.
      if (!current) {
        return
      }
      setNodes((current) => withCurrentSelection(graph.nodes as Node[], current))
      setEdges(graph.edges as Edge[])
      setFitView(fitViewOnOpen(graph.nodes))
      if (session) {
        setLiveStart({ session, graph })
      } else {
        toast.error('Could not open this graph. Changes made here will not be saved.')
      }
      setGraphReady(true)
    })
    // loadLocalExtensions reports its own failures and always resolves, so this
    // is a real "finished, either way" edge. That is what lets a node still
    // waiting for its extension be told apart from one whose extension is never
    // coming, without inferring it from how long it has taken.
    extensions.then(() => {
      if (!current) {
        return
      }
      setExtensionsVersion((v) => v + 1)
      setExtensionsSettled(true)
    })
    return () => {
      current = false
    }
  }, [slug, setNodes, setEdges])

  // The graph's own changes arrive through its document; an extension change
  // only reloads the registry the nodes are drawn from.
  useEffect(() => {
    if (!graphReady || sse.extensionsVersion === 0) {
      return
    }
    void coalesceReload(extensionsReloadRef.current, async () => {
      recordReloadClear() // TEMPORARY diagnostic
      extensionRegistry.clear()
      await loadLocalExtensions()
      setExtensionsVersion((v) => {
        recordReloadSettled(v + 1) // TEMPORARY diagnostic
        return v + 1
      })
    })
  }, [sse.extensionsVersion, graphReady])

  // The graph is written from the nodes and edges a render committed, never
  // from the arrays a handler passes: a multi-delete removes nodes and edges in
  // separate handlers, each holding a stale copy of the other half, and this
  // way both land as one step (see useLiveGraph).
  const scheduleSave = useCallback(
    (_nodes: Node[], _edges: Edge[], mergeKey?: string) => {
      if (graphReady) {
        requestWrite({ mergeKey })
      }
    },
    [graphReady, requestWrite],
  )

  useEffect(() => {
    return subscribeNodeDataUpdates((nodeId, data) => {
      setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data } : n)))
    })
  }, [setNodes])

  // Ids another graph already holds, for paste to keep ids only where they are free.
  const findTakenIds = useCallback((ids: string[]) => findTakenGraphIds({ data: { ids, exceptAddress: slug } }), [slug])

  // The centre of the visible area, not of the whole canvas, is where a paste
  // lands.
  const currentView = useCallback(() => {
    const { transform } = flowStore.getState()
    const [x, y, zoom] = transform
    const area = visibleArea()
    return { centre: viewportCentre(area.width, area.height, [x - area.left, y - area.top, zoom]), transform }
  }, [flowStore, visibleArea])

  const {
    copy: copySelectedNodes,
    paste: pasteNodes,
    hasCopiedNodes,
    onKeyDown: onClipboardKeyDown,
  } = useClipboard({
    findTakenIds,
    nodes,
    edges,
    setNodes,
    setEdges,
    onChange: scheduleSave,
    view: currentView,
    isFrame: isFrameNode,
    level,
  })

  // Undo and redo take this tab's own steps; until the graph's document is
  // open there is no history to take them from, and the keys do nothing.
  const onCanvasKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const action = live ? undoKeyAction(event.nativeEvent, event.currentTarget) : null
      if (!live || !action) {
        onClipboardKeyDown(event)
        return
      }
      event.preventDefault()
      const result = action === 'undo' ? live.undo() : live.redo()
      // A step made on another level opens that level, so what it did is seen.
      const changedOn = result ? levelsChanged(result.before, result.after) : []
      if (changedOn.length > 0 && !changedOn.includes(level)) {
        openLevel(changedOn[0])
      }
      const message = describeUndoResult(
        result,
        action,
        (nodeId) => commandNodes.find((n) => n.id === nodeId)?.label ?? nodeId,
      )
      if (message) {
        toast.info(message)
      }
    },
    [live, onClipboardKeyDown, commandNodes, level, openLevel],
  )

  // While a drag is on, the moves it reports are left to its end, which
  // places what was dragged; a move with no drag on is a keyboard nudge.
  const dragging = useRef(false)
  // Where the pointer or finger of the drag in progress last was, on the
  // canvas: a touch that ends may not say where it lifted.
  const dragPointer = useRef<{ x: number; y: number } | null>(null)
  const pointerOnCanvas = useCallback(
    (event: unknown) => {
      const client = clientPointOf(event)
      if (client) {
        dragPointer.current = screenToFlowPosition(client)
      }
      return dragPointer.current
    },
    [screenToFlowPosition],
  )

  const onDragStart = useCallback(
    (event: React.MouseEvent) => {
      dragging.current = true
      dragPointer.current = null
      pointerOnCanvas(event)
    },
    [pointerOnCanvas],
  )

  // While a drag is on, the frame it would drop into is highlighted: the one
  // under the pointer, as placeDragged decides.
  const [dropTargetIds, setDropTargetIds] = useState(NO_DROP_TARGETS)
  // Read from the stored graph, whose tree the drop is placed in: React Flow
  // holds an open subgraph's members without their parent.
  const nodesNow = useRef(nodes)
  nodesNow.current = nodes
  const showDropTarget = useCallback(
    (event: React.MouseEvent, dragged: Node[]) => {
      const pointer = pointerOnCanvas(event)
      const ids = new Set(dragged.filter((n) => !boundaryOf(n.id)).map((n) => n.id))
      const target = pointer && ids.size > 0 && dragDropTarget(nodesNow.current, ids, pointer, isFrameNode)
      const next = target ? new Set([target]) : NO_DROP_TARGETS
      setDropTargetIds((current) => updatedTargets(current, next))
    },
    [pointerOnCanvas],
  )
  const onNodeDrag = useCallback(
    (event: React.MouseEvent, _node: Node, dragged: Node[]) => showDropTarget(event, dragged),
    [showDropTarget],
  )
  const onSelectionDrag = useCallback(
    (event: React.MouseEvent, dragged: Node[]) => showDropTarget(event, dragged),
    [showDropTarget],
  )

  // A frame drag carries what is inside it: its members are its children, at
  // positions relative to it. What was dragged lands on the grid, where it was
  // dropped, in the frame under the pointer or at the top level (see
  // dropAtPoint), and the frame grows to hold it: one write, one undo step.
  const placeDragged = useCallback(
    (event: React.MouseEvent, dragged: Node[]) => {
      dragging.current = false
      setDropTargetIds(NO_DROP_TARGETS)
      const pointer = pointerOnCanvas(event)
      // A boundary is not in the graph: its place is its subgraph's data (see handleNodesChange).
      const ids = new Set(dragged.filter((n) => !boundaryOf(n.id)).map((n) => n.id))
      if (ids.size === 0) {
        return
      }
      setNodes((nds) => {
        const snapped = nds.map((n) => (ids.has(n.id) ? snapMovedNode(n) : n))
        // A drag that never said where its pointer was places by the corner.
        const placed = pointer ? dropAtPoint(snapped, ids, pointer, isFrameNode) : dropPlaced(snapped, ids, isFrameNode)
        const next = growToHold(
          placed,
          placedRoots(placed, ids).map((n) => n.id),
          isAutolayoutSection,
        )
        scheduleSave(next, edges)
        return next
      })
    },
    [setNodes, scheduleSave, edges, pointerOnCanvas],
  )
  const onNodeDragStop = useCallback(
    (event: React.MouseEvent, _node: Node, dragged: Node[]) => placeDragged(event, dragged),
    [placeDragged],
  )
  const onSelectionDragStop = useCallback(
    (event: React.MouseEvent, dragged: Node[]) => placeDragged(event, dragged),
    [placeDragged],
  )

  // A boundary's changes are not the graph's: its size is the canvas's own,
  // and where it was put is its subgraph's `inputsAt` or `outputsAt`, saved
  // on release on the grid.
  const placeBoundaries = useCallback(
    (changes: NodeChange[]) => {
      const sizes = changes.flatMap((c) =>
        c.type === 'dimensions' && c.dimensions ? [[c.id, c.dimensions] as const] : [],
      )
      if (sizes.length > 0) {
        setBoundarySizes((current) => new Map([...current, ...sizes]))
      }
      const moves = changes.flatMap((c) => (c.type === 'position' && c.position ? [c] : []))
      if (moves.length === 0) {
        return
      }
      const released = moves.some((c) => c.dragging === false)
      setNodes((nds) => {
        let next = nds
        for (const move of moves) {
          const boundary = boundaryOf(move.id)
          const at = move.position as { x: number; y: number }
          const place = move.dragging === false ? { x: snapToGrid(at.x), y: snapToGrid(at.y) } : at
          const key = boundary?.side === 'inputs' ? 'inputsAt' : 'outputsAt'
          next = next.map((n) => (n.id === boundary?.subgraphId ? { ...n, data: { ...n.data, [key]: place } } : n))
        }
        if (released) {
          scheduleSave(next, edges)
        }
        return next
      })
    },
    [setNodes, scheduleSave, edges],
  )

  const handleNodesChange: OnNodesChange = useCallback(
    (allChanges) => {
      placeBoundaries(allChanges.filter((c) => 'id' in c && boundaryOf(c.id)))
      const changes = allChanges.filter((c) => !('id' in c && boundaryOf(c.id)))
      onNodesChange(changes)
      // A node nudged with the keyboard keeps its frame, which grows to hold
      // it; moving it to another frame takes a drag.
      const nudged = new Set(
        dragging.current
          ? []
          : changes.flatMap((c) => (c.type === 'position' && c.position && c.dragging === false ? [c.id] : [])),
      )
      if (nudged.size > 0) {
        setNodes((current) => growToHold(current, nudged, isAutolayoutSection))
      }
      // A resize follows the pointer freely and snaps to the grid once, on
      // release (the resizer's last change says `resizing: false`); that one
      // write is the resize's single undo step. A frame's members stay where
      // they are drawn when its left or top edge snaps, and the frame a
      // resized node is in grows to hold it.
      const resized = new Set(changes.flatMap((c) => (c.type === 'dimensions' && c.resizing === false ? [c.id] : [])))
      if (resized.size > 0) {
        setNodes((current) =>
          growToHold(
            membersStayDrawn(
              current,
              current.map((n) => (resized.has(n.id) ? snapResizedNode(n) : n)),
            ),
            resized,
            isAutolayoutSection,
          ),
        )
      }
      const shouldSave = changes.some((c) => {
        if (c.type === 'position') {
          return c.dragging === false
        }
        if (c.type === 'dimensions') {
          return resized.has(c.id)
        }
        return c.type !== 'select'
      })
      if (!shouldSave) {
        return
      }
      setNodes((current) => {
        scheduleSave(current, edges)
        return current
      })
    },
    [onNodesChange, setNodes, scheduleSave, edges, placeBoundaries],
  )

  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes)
      // Selecting an edge changes nothing to save, as for nodes above.
      if (changes.every((c) => c.type === 'select')) {
        return
      }
      setEdges((current) => {
        scheduleSave(nodes, current)
        return current
      })
    },
    [onEdgesChange, setEdges, scheduleSave, nodes],
  )

  // The loop of values `conn` would close with what is wired already, in place
  // of the edge it would replace (see `valueLoop`); null when it closes none.
  const loopOf = useCallback(
    (conn: Connection): string[] | null => {
      const stored = storedConnection(conn)
      const replaced = edgesReplacedBy(edges, stored, handlesOfCanvasNode(conn.target))
      const next = [...edges.filter((e) => !replaced.includes(e)), { ...stored, id: CANDIDATE_EDGE }]
      return valueLoop(
        { nodes, edges: next },
        new Set([CANDIDATE_EDGE]),
        (nodeId, handleId) => findExtensionHandle(handlesOfCanvasNode(nodeId), handleId, 'source')?.handleType,
      )
    },
    [nodes, edges, handlesOfCanvasNode],
  )

  const isValidConnection: IsValidConnection = useCallback(
    (conn) => {
      if (!conn.source || !conn.target || conn.source === conn.target) {
        return false
      }
      if (!conn.sourceHandle || !conn.targetHandle) {
        return false
      }
      const srcHandle = findExtensionHandle(handlesOfCanvasNode(conn.source), conn.sourceHandle, 'source')
      const tgtHandle = findExtensionHandle(handlesOfCanvasNode(conn.target), conn.targetHandle, 'target')
      if (!srcHandle || !tgtHandle) {
        return false
      }
      // Qualified on both ends, so two extensions' same-named handle types
      // never connect by accident; a boundary's empty slot takes any, and an
      // input that takes several types exactly those (see `onConnect`). This
      // is also what highlights the handles that take an edge being dragged.
      const { source, target, sourceHandle, targetHandle } = conn
      const targetEnd = { nodeId: conn.target, handle: tgtHandle, handles: handlesOfCanvasNode(conn.target) }
      if (!handlesConnect({ nodeId: conn.source, handle: srcHandle }, targetEnd, edges)) {
        return false
      }
      return loopOf({ source, target, sourceHandle, targetHandle }) === null
    },
    [handlesOfCanvasNode, loopOf, edges],
  )

  // An edge drawn to a boundary is stored on its subgraph. Drawn to a
  // boundary's empty slot, it makes a new port of the type of the handle at
  // its other end, in the same write: one undo step, and the port's handle is
  // on the subgraph's card at once.
  const onConnect = useCallback(
    (conn: Connection) => {
      const slot =
        (conn.sourceHandle === NEW_PORT_HANDLE && boundaryOf(conn.source)) ||
        (conn.targetHandle === NEW_PORT_HANDLE && boundaryOf(conn.target)) ||
        null
      const inputSide = boundaryOf(conn.source)?.side === 'inputs'
      // The handle the edge meets beyond the boundary: a node's inside, or,
      // for an input passed straight through to Outputs' slot, the input port.
      const innerIsTarget = slot ? slot.side === 'inputs' : inputSide
      const inner = innerIsTarget
        ? findExtensionHandle(handlesOfCanvasNode(conn.target), conn.targetHandle ?? '', 'target')
        : findExtensionHandle(handlesOfCanvasNode(conn.source), conn.sourceHandle ?? '', 'source')
      let stored: Connection = storedConnection(conn)
      let nextNodes = nodes
      const subgraphId = slot?.subgraphId ?? (inputSide ? boundaryOf(conn.source)?.subgraphId : undefined)
      const subgraph = nodes.find((n) => n.id === subgraphId)
      if (slot && subgraph && inner) {
        // An input port starts with what the inner input reads now, typed on the card.
        const innerNode = nodes.find((n) => n.id === conn.target)
        const innerValueHandle = slot.side === 'inputs' ? valueHandleOf(innerNode, conn.targetHandle ?? '') : undefined
        const read = innerValueHandle ? inputValue(innerNode?.data, innerValueHandle) : undefined
        const innerValue = isPrimitiveValue(read) ? read : undefined
        // ...and with a text Switch's cases as its choices, when it feeds a Switch's condition.
        const choices = slot.side === 'inputs' ? choicesFeeding(innerNode, conn.targetHandle) : undefined
        const made = slotConnection(conn, subgraph.data, inner, newGraphId().slice(0, 8), { innerValue, choices })
        if (made) {
          nextNodes = nodes.map((n) =>
            n.id === subgraph.id ? { ...n, data: { ...(made.data as unknown as Record<string, unknown>) } } : n,
          )
          stored = made.stored
        }
      } else if (subgraph && inner && conn.sourceHandle) {
        const data = narrowedInput(subgraph.data, conn.sourceHandle, inner)
        if (data !== subgraph.data) {
          nextNodes = nodes.map((n) => (n.id === subgraph.id ? { ...n, data: data as Record<string, unknown> } : n))
        }
      } else if (slot) {
        return
      }
      // An input that takes several types takes the type of what is connected into it.
      const from = findExtensionHandle(handlesOfCanvasNode(conn.source), conn.sourceHandle ?? '', 'source')
      const into = findExtensionHandle(handlesOfCanvasNode(conn.target), conn.targetHandle ?? '', 'target')
      const targetNode = nextNodes.find((n) => n.id === stored.target)
      if (targetNode) {
        const retyped = dataOnConnect(targetNode.data, into, from?.handleType, from !== undefined && isEnumHandle(from))
        if (retyped !== targetNode.data) {
          nextNodes = nextNodes.map((n) => (n.id === targetNode.id ? { ...n, data: retyped } : n))
        }
      }
      const replaced = edgesReplacedBy(edges, stored, handlesOfCanvasNode(conn.target))
      const nextEdges = addEdge(
        { ...stored, id: newGraphId() },
        edges.filter((e) => !replaced.includes(e)),
      )
      if (nextNodes !== nodes) {
        setNodes(() => nextNodes)
      }
      setEdges(() => nextEdges)
      scheduleSave(nextNodes, nextEdges)
    },
    [nodes, edges, setNodes, setEdges, scheduleSave, handlesOfCanvasNode],
  )

  const styledEdges = useMemo(() => {
    return edgesForFlow.map((edge) => {
      const tgtHandle = edge.targetHandle
        ? findExtensionHandle(handlesOfCanvasNode(edge.target), edge.targetHandle, 'target')
        : undefined
      // Into an input that takes several types, whose pin is neutral, an edge has its source's colour.
      const srcHandle =
        tgtHandle && takesSeveralTypes(tgtHandle) && edge.sourceHandle
          ? findExtensionHandle(handlesOfCanvasNode(edge.source), edge.sourceHandle, 'source')
          : undefined
      const colouring = srcHandle ?? tgtHandle
      const handleType = colouring ? extensionRegistry.getHandleType(colouring.handleType) : undefined
      const stroke = handleType?.color ?? 'var(--muted-foreground)'
      return {
        ...edge,
        animated: true,
        style: { ...edge.style, stroke },
      }
    })
  }, [edgesForFlow, handlesOfCanvasNode])

  const addNodeAt = useCallback(
    (type: string, flow: { x: number; y: number }) => {
      const resolved = extensionRegistry.resolveNode(type)
      if (!resolved) {
        return
      }
      const node: Node = {
        id: newGraphId(),
        type,
        position: { x: snapToGrid(flow.x), y: snapToGrid(flow.y) },
        data: newNodeData(resolved.defaultData),
        ...newNodeLayout(resolved),
        // On a subgraph's canvas a node is made inside it, where the canvas shows it.
        ...(level ? { parentId: level } : {}),
      }
      setNodes((nds) => {
        // Into the frame under its corner, the drop point, which grows to hold it.
        const next = growToHold(
          dropPlaced([...nds, node], new Set([node.id]), isFrameNode),
          [node.id],
          isAutolayoutSection,
        )
        scheduleSave(next, edges)
        return next
      })
    },
    [setNodes, scheduleSave, edges, level],
  )

  const addNodeWithConnection = useCallback(
    (type: string, flow: { x: number; y: number }, pending: PendingConnection) => {
      const resolved = extensionRegistry.resolveNode(type)
      if (!resolved) {
        return
      }
      const matchingHandle = resolved.handles.find((h) => takesPending(pending, h))
      if (!matchingHandle) {
        addNodeAt(type, flow)
        return
      }
      const nodeId = newGraphId()
      const data = newNodeData(resolved.defaultData)
      const node: Node = {
        id: nodeId,
        type,
        position: { x: snapToGrid(flow.x), y: snapToGrid(flow.y) },
        // An input that takes several types takes the type of the edge it is made with.
        data:
          pending.fromRole === 'source'
            ? dataOnConnect(data, matchingHandle, pending.handleType, isEnumType(pending.handleType))
            : data,
        ...newNodeLayout(resolved),
        // On a subgraph's canvas a node is made inside it, where the canvas shows it.
        ...(level ? { parentId: level } : {}),
      }
      const newEdge: Edge =
        pending.fromRole === 'source'
          ? {
              id: newGraphId(),
              source: pending.fromNodeId,
              sourceHandle: pending.fromHandleId,
              target: nodeId,
              targetHandle: matchingHandle.id,
            }
          : {
              id: newGraphId(),
              source: nodeId,
              sourceHandle: matchingHandle.id,
              target: pending.fromNodeId,
              targetHandle: pending.fromHandleId,
            }
      // Dragged out of an input that takes several types, that input takes the new node's type.
      const fromInput =
        pending.fromRole === 'target'
          ? findExtensionHandle(handlesOfCanvasNode(pending.fromNodeId), pending.fromHandleId, 'target')
          : undefined
      const typed = nodes.map((n) => {
        const retyped =
          n.id === pending.fromNodeId
            ? dataOnConnect(n.data, fromInput, matchingHandle.handleType, isEnumType(matchingHandle.handleType))
            : n.data
        return retyped === n.data ? n : { ...n, data: retyped }
      })
      const nextNodes = growToHold(
        dropPlaced([...typed, node], new Set([node.id]), isFrameNode),
        [node.id],
        isAutolayoutSection,
      )
      // Dragged out of an input that takes one edge, the new node's edge replaces the one there.
      const fromNode = nodes.find((n) => n.id === pending.fromNodeId)
      const fromHandles = (fromNode?.type && extensionRegistry.resolveNode(fromNode.type)?.handles) || []
      const replaced = pending.fromRole === 'target' ? edgesReplacedBy(edges, newEdge, fromHandles) : []
      const nextEdges = [...edges.filter((e) => !replaced.includes(e)), newEdge]
      setNodes(() => nextNodes)
      setEdges(() => nextEdges)
      scheduleSave(nextNodes, nextEdges)
    },
    [nodes, edges, setNodes, setEdges, scheduleSave, addNodeAt, level, handlesOfCanvasNode],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault()
      const type = e.dataTransfer.getData('application/dashboard-extension')
      if (!type) {
        return
      }
      focusCanvasOnDrop(e)
      addNodeAt(type, screenToFlowPosition({ x: e.clientX, y: e.clientY }))
    },
    [addNodeAt, screenToFlowPosition],
  )

  const updateNodeData = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      setNodes((nds) => {
        const next = nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n))
        // Typing into one field of one node is one undo step.
        scheduleSave(next, edges, `data:${nodeId}:${Object.keys(patch).sort().join(',')}`)
        return next
      })
    },
    [setNodes, scheduleSave, edges],
  )

  // A subgraph's data written from its Inputs or Outputs (see
  // `SubgraphBoundary`): each change its own undo step, and a port removed
  // takes its edges on both sides, committed in the same render and so in the
  // same write.
  const writeSubgraphData = useCallback(
    (subgraphId: string, data: Record<string, unknown>) => {
      setNodes((nds) => {
        const next = nds.map((n) => (n.id === subgraphId ? { ...n, data } : n))
        scheduleSave(next, edges)
        return next
      })
      setEdges((eds) => edgesKeptByPorts(eds, subgraphId, data))
    },
    [setNodes, setEdges, scheduleSave, edges],
  )

  // A value typed into a node's input (see `InlineValue`): merged into its
  // `data.inputs` as the nodes are now, each commit its own undo step.
  const writeTypedInput = useCallback(
    (nodeId: string, handleId: string, value: PrimitiveValue) => {
      setNodes((nds) => {
        const next = nds.map((n) => {
          if (n.id !== nodeId) {
            return n
          }
          const inputs = n.data.inputs
          const typed = inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs) ? inputs : {}
          return { ...n, data: { ...n.data, inputs: { ...typed, [handleId]: value } } }
        })
        scheduleSave(next, edges)
        return next
      })
    },
    [setNodes, scheduleSave, edges],
  )

  const deselect = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
  }, [setNodes])

  const selectNode = useCallback((nodeId: string) => setNodes((nds) => selectOnly(nds, nodeId)), [setNodes])
  const onNodeClick = useClickCycle({ canvas: canvasElement, select: selectNode, isFrame: isFrameNode })
  const onNodeDoubleClick = useSubgraphDoubleClick({ canvas: canvasElement, open: openLevel })

  // Open the MCP Requests inspector tab (e.g. from a corner notification):
  // clear any docked chat, deselect so the node browser is visible.
  const openMcpRequests = useCallback(() => {
    overlay.slots.setSlot('content', null)
    overlay.slots.setSlot('menu', null)
    deselect()
    setBrowserTab('mcp')
    if (isMobile) {
      setSidebarOpenMobile(true)
    } else {
      setSidebarOpen(true)
    }
  }, [overlay.slots.setSlot, deselect, isMobile, setSidebarOpen, setSidebarOpenMobile])

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault()
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      setMenu({ screen: { x: event.clientX, y: event.clientY }, flow })
    },
    [screenToFlowPosition],
  )

  // Right-click (desktop) or long-press (mobile) on a node: make it the sole
  // selection unless it's already part of a multi-selection, then open the
  // shared node context menu for it.
  //
  // Two independent gestures reach this on mobile: our own JS-timer
  // long-press (handleTouchStart) and the browser's native long-press ->
  // contextmenu gesture recognizer, which fires onNodeContextMenu below
  // entirely outside the touch pipeline. Neither needs to coordinate with
  // the menu's dismissal: the menu closes only on a pointerdown outside it
  // (use-outside-dismiss.ts), which the opening gesture -- whichever one it
  // was -- cannot produce.
  const openNodeMenu = useCallback(
    (nodeId: string, screen: { x: number; y: number }) => {
      setNodes((nds) =>
        nds.find((n) => n.id === nodeId)?.selected ? nds : nds.map((n) => ({ ...n, selected: n.id === nodeId })),
      )
      setNodeMenu({ screen, nodeId })
    },
    [setNodes],
  )

  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      event.preventDefault()
      openNodeMenu(node.id, { x: event.clientX, y: event.clientY })
    },
    [openNodeMenu],
  )

  // Details, chosen from a node's context menu, must show that specific node
  // — even when the menu was opened on a node that was already part of a
  // multi-selection. `openNodeMenu` deliberately leaves a multi-selection
  // intact (so Copy/Delete still act on the whole selection), which means
  // `selected` can resolve to a different member of it than the one the menu
  // was opened on. Selecting exactly this node makes the inspector's own
  // input (`selected`) the single source of truth for what Details shows,
  // rather than tracking the menu's target as a second, separate one.
  const openNodeDetails = useCallback(
    (nodeId: string) => {
      setNodes((nds) => selectOnly(nds, nodeId))
      setMobileInspectorVisible(true)
      // On a phone the inspector covers the screen, and the sidebar's sheet,
      // a modal above every page, steps aside for it.
      setSidebarOpenMobile(false)
    },
    [setNodes, setSidebarOpenMobile],
  )

  // The inspector remembers its tab per node type, and a request from a node
  // names only the node: this canvas answers for the nodes it holds.
  useEffect(
    () =>
      registerNodeTypes((nodeId) => {
        const type = getInternalNode(nodeId)?.type
        return type ? (extensionRegistry.resolveNode(type)?.type ?? type) : undefined
      }),
    [getInternalNode],
  )

  // Anything that asks the inspector for one of a node's tabs (a button on the
  // node, a context-menu item, a toast's Show) gets that node shown: selected
  // alone, as Details from the context menu does, and moved into view if it is
  // out of sight. On a phone that also brings the inspector up. A node another
  // canvas holds is left to that canvas.
  useEffect(
    () =>
      inspectorIntent.onOpen((nodeId) => {
        if (!getInternalNode(nodeId)) {
          return
        }
        openNodeDetails(nodeId)
        afterLayout(() => {
          const node = getInternalNode(nodeId)
          if (!node) {
            return
          }
          const box = {
            ...node.internals.positionAbsolute,
            width: node.measured.width ?? 0,
            height: node.measured.height ?? 0,
          }
          const view = revealViewport(box, visibleArea(), flowStore.getState().transform)
          if (view) {
            setViewport(view, { duration: 300 })
          }
        })
      }),
    [getInternalNode, openNodeDetails, flowStore, setViewport, visibleArea],
  )

  // React Flow deletes a frame's children with it; here they stay where they
  // are drawn, in a frame that holds them (see `deleteKeepingChildren`), in
  // the same write as the deletion. A child that was itself selected is
  // deleted.
  const onBeforeDelete = useCallback<OnBeforeDelete<Node, Edge>>(
    async ({ nodes: requested, edges: requestedEdges }) => {
      const asked = askedToDelete(requested)
      const deleted = new Set(asked.map((n) => n.id))
      const deletedEdges = edgesAskedToDelete(requestedEdges, requested, asked)
      // A deleted subgraph's contents go at every depth, read from the graph
      // rather than from what React Flow asked for, and a store among them is
      // confirmed as one deleted directly is.
      const gone = deletedWithContents(nodes, deleted)
      const goneNodes = nodes.filter((n) => gone.has(n.id))
      if (!(await storeDelete.onBeforeDelete({ nodes: goneNodes, edges: deletedEdges }))) {
        return false
      }
      setNodes((nds) => {
        const kept = byIdOf(deleteKeepingChildren(nds, deleted))
        return nds.filter((n) => !gone.has(n.id)).map((n) => kept.get(n.id) ?? n)
      })
      // Their edges go with them.
      setEdges((eds) => eds.filter((e) => !gone.has(e.source) && !gone.has(e.target)))
      return { nodes: asked, edges: deletedEdges }
    },
    [storeDelete.onBeforeDelete, setNodes, setEdges, nodes],
  )

  // Deletes the current node selection through the same path the built-in
  // Backspace/Delete key already uses, so there's one source of truth for
  // node deletion (including connected-edge cleanup and the debounced save).
  const onDeleteSelected = useCallback(() => {
    const targets = nodes.filter((n) => n.selected).map((n) => ({ id: n.id }))
    if (targets.length > 0) {
      deleteElements({ nodes: targets })
    }
  }, [nodes, deleteElements])

  // Align, arrange or tidy up the selection, as one write: one undo step, and
  // seen live by everyone on the graph as a drag is.
  const onArrangeSelected = useCallback(
    (action: ArrangeAction, columnGapSteps: number) => {
      const arranged = arrangeSelected(nodes, action, { links: edges, columnGapSteps })
      const moved = arranged.filter((n, i) => n !== nodes[i]).map((n) => n.id)
      const next = growToHold(arranged, moved, isAutolayoutSection)
      setNodes(next)
      scheduleSave(next, edges)
    },
    [nodes, edges, setNodes, scheduleSave],
  )

  // A new Section around the selection, as one write: one undo step, and seen
  // live by everyone on the graph as any added node is. The selected nodes
  // become its members, so it carries them when dragged.
  const onWrapInSection = useCallback(() => {
    const resolved = extensionRegistry.resolveNode(SECTION_TYPE)
    const picked = nodes.filter((n) => n.selected)
    const abs = absolutePositions(nodes)
    const box = sectionBoxAround(picked.map((n) => ({ ...(abs.get(n.id) ?? n.position), ...drawnSize(n) })))
    if (!resolved || !box) {
      return
    }
    const section: Node = {
      id: newGraphId(),
      type: SECTION_TYPE,
      position: { x: box.x, y: box.y },
      data: newNodeData(resolved.defaultData),
      ...newNodeLayout(resolved),
      style: { width: box.width, height: box.height },
    }
    const next = growToHold(
      wrapInSection(nodes, new Set(picked.map((n) => n.id)), section),
      [section.id],
      isAutolayoutSection,
    )
    setNodes(next)
    scheduleSave(next, edges)
  }, [nodes, edges, setNodes, scheduleSave])

  // The selection moved into a new subgraph, its crossing edges made ports
  // (see makeSubgraph), as one write: one undo step. The subgraph is left
  // selected, to be renamed or opened at once.
  const onMakeSubgraph = useCallback(() => {
    const resolved = extensionRegistry.resolveNode(SUBGRAPH_TYPE)
    const picked = nodes.filter((n) => n.selected && n.type !== 'comment').map((n) => n.id)
    if (!resolved || picked.length === 0) {
      return
    }
    const subgraph: Node = {
      id: newGraphId(),
      type: SUBGRAPH_TYPE,
      position: { x: 0, y: 0 },
      data: newNodeData(resolved.defaultData),
      ...newNodeLayout(resolved),
    }
    const result = makeSubgraph({ nodes, edges }, new Set(picked), {
      subgraph,
      newId: newGraphId,
      declared: declaredHandles,
      enumCasesOf: extensionRegistry.enumCasesOf,
      fitsItself: isAutolayoutSection,
    })
    if ('refused' in result) {
      toast.error('Could not make a subgraph', { description: result.refused })
      return
    }
    const next = selectOnly(result.nodes, subgraph.id)
    setNodes(next)
    setEdges(result.edges)
    scheduleSave(next, result.edges)
  }, [nodes, edges, setNodes, setEdges, scheduleSave])

  // A subgraph turned into a Section in place (see expandSubgraph), as one
  // write: one undo step.
  const onExpandSubgraph = useCallback(
    (subgraphId: string) => {
      const resolved = extensionRegistry.resolveNode(SECTION_TYPE)
      if (!resolved) {
        return
      }
      const { zIndex } = newNodeLayout(resolved)
      const result = expandSubgraph({ nodes, edges }, subgraphId, {
        section: { type: SECTION_TYPE, data: newNodeData(resolved.defaultData), zIndex },
        newId: newGraphId,
        fitsItself: isAutolayoutSection,
      })
      if ('refused' in result) {
        toast.error('Could not expand the subgraph', { description: result.refused })
        return
      }
      setNodes(result.nodes)
      setEdges(result.edges)
      scheduleSave(result.nodes, result.edges)
    },
    [nodes, edges, setNodes, setEdges, scheduleSave],
  )
  const selectedCount = nodes.filter((n) => n.selected).length

  // A row dragged in the Outline: a reparent, as one write (one undo step),
  // seen live by everyone on the graph as a canvas drop is.
  const onOutlineMove = useCallback(
    (nodeId: string, drop: GraphOutlineDrop) => {
      const result = moveFromOutline(nodes, nodeId, drop, isFrameNode, isAutolayoutSection)
      if (!result) {
        return
      }
      if ('refused' in result) {
        toast.error('Could not move the node', { description: result.refused })
        return
      }
      setNodes(result.nodes)
      scheduleSave(result.nodes, edges)
    },
    [nodes, edges, setNodes, scheduleSave],
  )

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (state.isValid) {
        return
      }
      const fromHandle = state.fromHandle
      const fromNode = state.fromNode
      if (!fromHandle?.id || !fromHandle.type || !fromNode?.type) {
        return
      }
      // Dropped on a handle that refuses it because it would close a loop of
      // values: say which, rather than nothing.
      if (state.toNode && state.toHandle?.id) {
        const fromSource = fromHandle.type === 'source'
        const conn: Connection = {
          source: fromSource ? fromNode.id : state.toNode.id,
          sourceHandle: fromSource ? fromHandle.id : state.toHandle.id,
          target: fromSource ? state.toNode.id : fromNode.id,
          targetHandle: fromSource ? state.toHandle.id : fromHandle.id,
        }
        const loop = loopOf(conn)
        if (loop) {
          const named = (id: string) => {
            const node = nodes.find((n) => n.id === id)
            return nodeName(node?.data, node?.type ? extensionRegistry.resolveNode(node.type)?.name : undefined, id)
          }
          toast.error('Not connected', { description: loopRefusal(loop, named) })
          return
        }
      }
      // As the node has it now: a value node's handles follow its data, and
      // an input its type now. A boundary is no node of the graph's to wire a new one to.
      const handle = boundaryOf(fromNode.id)
        ? undefined
        : findExtensionHandle(handlesOfCanvasNode(fromNode.id), fromHandle.id, fromHandle.type)
      if (!handle) {
        return
      }
      const point =
        'clientX' in event
          ? { x: event.clientX, y: event.clientY }
          : { x: event.changedTouches[0]?.clientX ?? 0, y: event.changedTouches[0]?.clientY ?? 0 }
      const flow = screenToFlowPosition(point)
      setMenu({
        screen: point,
        flow,
        pending: {
          fromNodeId: fromNode.id,
          fromHandleId: fromHandle.id,
          fromRole: fromHandle.type,
          handleType: handle.handleType,
          ...(fromHandle.type === 'target' && handle.accepts?.length ? { accepts: handle.accepts } : {}),
          ...(fromHandle.type === 'target' && handle.acceptsEnums ? { acceptsEnums: true } : {}),
        },
      })
    },
    [screenToFlowPosition, loopOf, nodes, handlesOfCanvasNode],
  )

  const closeMenu = useCallback(() => setMenu(null), [])

  const onMenuSelect = useCallback(
    (type: string) => {
      if (!menu) {
        return
      }
      if (menu.pending) {
        addNodeWithConnection(type, menu.flow, menu.pending)
      } else {
        addNodeAt(type, menu.flow)
      }
      setMenu(null)
    },
    [menu, addNodeAt, addNodeWithConnection],
  )

  const onPasteAtMenu = useCallback(() => {
    if (!menu) {
      return
    }
    pasteNodes(menu.flow)
    setMenu(null)
  }, [menu, pasteNodes])

  const menuExtensions = useMemo(() => {
    if (!menu?.pending) {
      return allNodes
    }
    const pending = menu.pending
    return allNodes.filter((n) => n.handles.some((h) => takesPending(pending, h)))
  }, [allNodes, menu])

  const openEditor = useCallback((_folder: string | null) => {
    // Navigate to /extensions page
    window.location.href = '/extensions'
  }, [])

  // Mobile long-press handling
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressFired = useRef(false)
  const touchTargetRef = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null)

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }, [])

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!isMobile) {
        return
      }
      // A tap that lands on an open canvas menu (NodeContextMenu,
      // FlowContextMenu) must not be treated as a canvas-surface gesture --
      // see canvas-touch-guard.ts.
      if (isCanvasMenuTouchTarget(e.target)) {
        return
      }
      longPressFired.current = false
      const touch = e.touches[0]
      touchTargetRef.current = { x: touch.clientX, y: touch.clientY, target: touch.target }
      cancelLongPress()
      longPressTimer.current = setTimeout(() => {
        longPressFired.current = true
        const { x, y, target } = touchTargetRef.current ?? {}
        // Use saved target first, fallback to elementFromPoint
        const el = (target instanceof Element ? target : null) ?? document.elementFromPoint(x ?? 0, y ?? 0)
        const nodeEl = el?.closest('.react-flow__node')
        if (nodeEl) {
          // Long press on node -> show node context menu
          const nodeId = nodeEl.getAttribute('data-id')
          if (nodeId) {
            openNodeMenu(nodeId, { x: x ?? 0, y: y ?? 0 })
          }
        } else {
          // Long press on empty pane -> open context menu
          const flow = screenToFlowPosition({ x: x ?? 0, y: y ?? 0 })
          setMenu({ screen: { x: x ?? 0, y: y ?? 0 }, flow })
        }
      }, 500)
    },
    [isMobile, cancelLongPress, openNodeMenu, screenToFlowPosition],
  )

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!isMobile) {
        return
      }
      if (isCanvasMenuTouchTarget(e.target)) {
        return
      }
      cancelLongPress()
      if (longPressFired.current) {
        // A menu just opened under the still-down finger (our JS timer knows
        // no better than to open it mid-hold, and the menu is positioned at
        // the touch point). The browser's trailing synthetic click for this
        // touch would land on whatever menu item now sits at those
        // coordinates and activate it -- preventDefault suppresses that
        // ghost click. The browser's own native long-press -> contextmenu
        // gesture needs no such help: it suppresses its trailing click
        // itself. Menu dismissal needs nothing here either way -- the menus
        // close only on a pointerdown outside them (use-outside-dismiss.ts),
        // which no release event is.
        e.preventDefault()
      } else {
        // Short tap on empty space -> deselect and hide inspector
        const touch = e.changedTouches[0]
        const el =
          (touch.target instanceof Element ? (touch.target as Element) : null) ??
          document.elementFromPoint(touch.clientX, touch.clientY)
        const nodeEl = el?.closest('.react-flow__node')
        if (!nodeEl) {
          deselect()
          setMobileInspectorVisible(false)
        }
      }
      longPressFired.current = false
    },
    [isMobile, cancelLongPress, deselect],
  )

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (!isMobile) {
        return
      }
      if (isCanvasMenuTouchTarget(e.target)) {
        return
      }
      // Cancel long press if finger moved too far
      const touch = e.touches[0]
      const start = touchTargetRef.current
      if (start) {
        const dx = touch.clientX - start.x
        const dy = touch.clientY - start.y
        if (Math.abs(dx) > TOUCH_SLOP_PX || Math.abs(dy) > TOUCH_SLOP_PX) {
          cancelLongPress()
        }
      }
    },
    [isMobile, cancelLongPress],
  )

  // A touch on a node's content that the canvas pans or zooms with never
  // reaches the handlers above again after it lands, so its long press is
  // dropped when the canvas takes it.
  useEffect(
    () => (canvasElement ? routeCanvasTouch(canvasElement, cancelLongPress) : undefined),
    [canvasElement, cancelLongPress],
  )

  const colorMode = resolvedTheme === 'dark' ? 'dark' : 'light'

  if (!graphReady) {
    return (
      // The same mark, at the same size, that a chat shows while it loads --
      // one loading visual for the product rather than one per surface. The
      // wording the old caption carried moves onto the mark's own label
      // instead of being drawn twice: the component already announces itself
      // to a screen reader, so a visible caption beside it was the only part
      // that differed from the chat.
      //
      // `h-full w-full` is what the ready canvas below claims too, and both
      // returns need it for the same reason: this component is rendered as a
      // FLEX ITEM, so without an explicit size it is laid out at the width of
      // whatever it contains. Centring inside a box the size of its own
      // contents does nothing, which is how a correctly centred loader ends up
      // against the left edge.
      <div className='flex h-full w-full items-center justify-center'>
        <LogoLoader size={40} className='text-foreground' aria-label='Loading space' />
      </div>
    )
  }

  const inspectorPanel = (
    <NodeInspector
      node={selected}
      expanded={expanded}
      override={inspector.inspectorNode}
      updateNodeData={updateNodeData}
      onDeselect={() => {
        deselect()
        if (isMobile) {
          setMobileInspectorVisible(false)
        }
      }}
      onEditExtension={openEditor}
      // A phone's inspector already covers the screen: nothing to expand.
      onExpandedChange={isMobile ? undefined : setInspectorExpanded}
    />
  )

  return (
    // Provided here rather than folded into `nodeTypes`: the node component map
    // holds one fixed wrapper per type (see buildNodeTypes), which cannot carry
    // a value that changes.
    //
    // This is also how a node picks up its component. Changing this value is
    // the only thing that re-renders the node wrappers when the registry has
    // been written to, and a wrapper resolves its component during render.
    <ExtensionsStateContext.Provider value={extensionsState}>
      <CanvasGraphContext.Provider value={storedGraph}>
        <InspectorContext.Provider value={{ setNode: inspector.setNode }}>
          <CanvasWriters typedInput={writeTypedInput} nodeData={updateNodeData}>
            <SubgraphDataWriterContext.Provider value={writeSubgraphData}>
              <div ref={setEditorElement} className='contents'>
                {/* The canvas fills the App's viewport, under the sidebar, the
              docked chat and the inspector, so nothing on it moves when any
              of them opens, closes or is resized. Everything else here is laid
              out in the panels below and stacks above it. */}
                <AppViewport>
                  {/* `touch-none`: every touch gesture on the canvas is xyflow's —
              one finger pans, two pinch. The panel groups and panels around
              it declare `touch-action: pan-y`, which hands vertical drags to
              the browser: its touchmoves arrive uncancelable, xyflow cannot
              stop them, and on a phone the pull runs on to the page's
              pull-to-refresh. touch-action is resolved only up to the nearest
              scroll container, so a scrollable area inside a node keeps its
              own native scrolling, which flow-editor.css turns off while the
              node is unselected and routeCanvasTouch lets it use only for a
              drag the content can scroll. */}
                  <div
                    ref={setCanvasElement}
                    role='application'
                    tabIndex={-1}
                    className='dashboard-mvp-flow absolute inset-0 outline-none touch-none'
                    onPointerDownCapture={(event) => {
                      focusCanvasOnPress(event)
                      captureFieldDragSelect(event)
                    }}
                    onKeyDown={onCanvasKeyDown}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                    onTouchStart={handleTouchStart}
                    onTouchEnd={handleTouchEnd}
                    onTouchMove={handleTouchMove}
                  >
                    <DropTargetContext.Provider value={dropTargetIds}>
                      <MoveModeContext.Provider value={isMobile ? nodesMovable : null}>
                        <ReactFlow
                          nodes={nodesForFlow}
                          edges={styledEdges}
                          nodeTypes={nodeTypes}
                          onNodesChange={handleNodesChange}
                          onEdgesChange={handleEdgesChange}
                          onNodeClick={onNodeClick}
                          onNodeDoubleClick={onNodeDoubleClick}
                          onNodeDragStart={onDragStart}
                          onNodeDrag={onNodeDrag}
                          onNodeDragStop={onNodeDragStop}
                          onSelectionDragStart={onDragStart}
                          onSelectionDrag={onSelectionDrag}
                          onSelectionDragStop={onSelectionDragStop}
                          onConnect={onConnect}
                          onConnectEnd={onConnectEnd}
                          isValidConnection={isValidConnection}
                          onPaneContextMenu={onPaneContextMenu}
                          onNodeContextMenu={onNodeContextMenu}
                          onPaneClick={() => {
                            closeMenu()
                            setNodeMenu(null)
                            if (isMobile) {
                              deselect()
                              setMobileInspectorVisible(false)
                            }
                          }}
                          onBeforeDelete={onBeforeDelete}
                          deleteKeyCode={['Backspace', 'Delete']}
                          multiSelectionKeyCode='Shift'
                          selectionKeyCode='Shift'
                          nodesDraggable={isMobile ? nodesMovable : undefined}
                          selectionOnDrag={!isMobile}
                          panOnDrag={isMobile ? true : [1]}
                          selectionMode={isMobile ? undefined : SelectionMode.Partial}
                          colorMode={colorMode}
                          maxZoom={1}
                          minZoom={0.25}
                          proOptions={{ hideAttribution: true }}
                        >
                          <Background variant={BackgroundVariant.Dots} gap={GRID_STEP} />
                        </ReactFlow>
                      </MoveModeContext.Provider>
                    </DropTargetContext.Provider>
                    {/* Node context menu: desktop right-click and mobile long-press */}
                    {nodeMenu &&
                      (() => {
                        const target = nodes.find((n) => n.id === nodeMenu.nodeId)
                        if (!target) {
                          return null
                        }
                        return (
                          <NodeContextMenu
                            position={nodeMenu.screen}
                            node={target}
                            resolvedNode={target.type ? extensionRegistry.resolveNode(target.type) : undefined}
                            contexts={resolveInputContexts(target.id, { nodes, edges })}
                            onCopy={() => copySelectedNodes()}
                            onDelete={onDeleteSelected}
                            onArrange={selectedCount >= 2 ? onArrangeSelected : undefined}
                            onWrapInSection={selectedCount >= 1 ? onWrapInSection : undefined}
                            onMakeSubgraph={selectedCount >= 1 ? onMakeSubgraph : undefined}
                            onExpandSubgraph={isSubgraph(target) ? () => onExpandSubgraph(target.id) : undefined}
                            onOpen={isSubgraph(target) ? () => openLevel(target.id) : undefined}
                            onDetails={
                              isMobile
                                ? () => {
                                    openNodeDetails(nodeMenu.nodeId)
                                  }
                                : undefined
                            }
                            onClose={() => setNodeMenu(null)}
                          />
                        )
                      })()}
                    {/* Mobile overlay toolbar. Stacked ABOVE the chat launcher in
                      the bottom right corner, centred on it, and fixed for the
                      same reason the launcher is: they belong to the viewport.
                      An open chat covers the viewport at a higher z, which is
                      what hides these while it is up. */}
                    {isMobile && !overlayActive && (
                      // The launcher (ChatLauncher, `right-4 size-14`) is centred
                      // 44px from the right edge: `right-5.5` centres the 44px
                      // (`size-11`, TOUCH_TARGET_PX) button on it.
                      <div className='fixed right-5.5 bottom-20 z-40 flex flex-col items-center gap-2'>
                        <button
                          type='button'
                          className={`size-11 flex items-center justify-center rounded-lg border shadow-sm active:bg-accent ${nodesMovable ? 'bg-primary/20 border-primary' : 'bg-background/80 backdrop-blur'}`}
                          onClick={() => setNodesMovable((v) => !v)}
                          title={nodesMovable ? 'Pan canvas' : 'Move nodes'}
                          aria-pressed={nodesMovable}
                        >
                          <Move className='size-5' />
                        </button>
                      </div>
                    )}
                  </div>
                </AppViewport>
                {menu && (
                  <FlowContextMenu
                    position={menu.screen}
                    extensions={menuExtensions}
                    onSelect={onMenuSelect}
                    onNewExtension={() => openEditor(null)}
                    onClose={closeMenu}
                    onPaste={onPasteAtMenu}
                    canPaste={hasCopiedNodes}
                  />
                )}
                <ResizablePanelGroup
                  className='h-full w-full'
                  defaultLayout={inspectorLayout.defaultLayout}
                  onLayoutChanged={inspectorLayout.onLayoutChanged}
                >
                  {/* The canvas's box in the layout: what lies over the canvas
                here, and the part of it a framed view aims at. Positioned for
                the overlays to fill it, and let through to the canvas
                underneath everywhere they do not catch the pointer
                themselves. */}
                  <ResizablePanel
                    id='canvas'
                    minSize='30%'
                    elementRef={setCanvasPanel}
                    className='pointer-events-none relative min-w-0'
                  >
                    <CanvasOverlay
                      nodes={commandNodes}
                      spaceName={spaceName}
                      selectedNodeId={selected?.id ?? null}
                      onFocusNode={focusNode}
                      onActiveChange={isMobile ? setOverlayActive : undefined}
                      extensionsVersion={extensionsVersion}
                    />
                    {/* On a subgraph's canvas, where it is and the way back up:
                  centred at the top, clear of the launchers in the left
                  corner and the overlay's close in the right. */}
                    {level && (
                      <div className='pointer-events-auto absolute top-3 left-1/2 z-20 max-w-[calc(100%-10rem)] -translate-x-1/2 rounded-md border bg-background/90 shadow-xs backdrop-blur-sm'>
                        <GraphPath
                          segments={levelPath(nodes, level, graphName ?? spaceName, TOP_LEVEL)}
                          onOpen={(id) => openLevel(id === TOP_LEVEL ? undefined : id)}
                        />
                      </div>
                    )}
                    <McpRequestNotifications onOpen={openMcpRequests} />
                    {storeDelete.dialog}
                  </ResizablePanel>
                  {/* Over the canvas rather than beside it: the canvas has no edge to push. */}
                  <AppSidebar mode='overlay'>
                    <NodeBrowser
                      tab={browserTab}
                      extensions={allNodes}
                      graphNodes={nodes}
                      level={level}
                      selectedNodeId={selected?.id ?? null}
                      isFrame={isFrameNode}
                      onTabChange={setBrowserTab}
                      onEditExtension={openEditor}
                      onFocusNode={(nodeId) => {
                        focusNode(nodeId)
                        // On a phone the sidebar covers the canvas; step aside for the node.
                        if (isMobile) {
                          setSidebarOpenMobile(false)
                        }
                      }}
                      onMoveNode={onOutlineMove}
                      onNodeMenu={(nodeId, point) => {
                        openNodeMenu(nodeId, point)
                        // The canvas's node menu, which a phone's sidebar sheet would cover.
                        if (isMobile) {
                          setSidebarOpenMobile(false)
                        }
                      }}
                    />
                  </AppSidebar>
                  {inspectorDocked && <ResizableHandle withHandle />}
                  {/* Positioned and opaque: it lies over the canvas, which reaches
                under it. */}
                  {inspectorDocked && (
                    <ResizablePanel
                      id='inspector'
                      defaultSize='420px'
                      minSize='20rem'
                      maxSize='70%'
                      className='relative min-w-0 bg-background'
                    >
                      {inspectorPanel}
                    </ResizablePanel>
                  )}
                </ResizablePanelGroup>
                {inspectorCovers && <div className='fixed inset-0 z-50'>{inspectorPanel}</div>}
              </div>
            </SubgraphDataWriterContext.Provider>
          </CanvasWriters>
        </InspectorContext.Provider>
      </CanvasGraphContext.Provider>
    </ExtensionsStateContext.Provider>
  )
}
