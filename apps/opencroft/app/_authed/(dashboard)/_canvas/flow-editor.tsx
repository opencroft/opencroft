'use client'

import {
  addEdge,
  Background,
  BackgroundVariant,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type IsValidConnection,
  type Node,
  type NodeTypes,
  type OnEdgesChange,
  type OnNodesChange,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import { SelectionMode } from '@xyflow/system'
import '@xyflow/react/dist/style.css'
import { Box, GripVertical, Move, PanelLeft } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { useSeedPendingRequests } from '@/app/_authed/(approvals)/_components/mcp-request-list'
import { McpRequestNotifications } from '@/app/_authed/(approvals)/_components/mcp-request-notifications'
import type { CommandNodeEntry } from '@/app/_authed/(dashboard)/_canvas/canvas-command-bar'
import { CanvasOverlay } from '@/app/_authed/(dashboard)/_canvas/canvas-overlay'
import { recordReloadClear, recordReloadSettled } from '@/app/_authed/(dashboard)/_canvas/ctrlg-debug'
import { isCanvasMenuTouchTarget } from '@/app/_authed/(dashboard)/_canvas/canvas-touch-guard'
import { CommentNode } from '@/app/_authed/(dashboard)/_canvas/comment-node'
import { FlowContextMenu } from '@/app/_authed/(dashboard)/_canvas/flow-context-menu'
import '@/app/_authed/(dashboard)/_canvas/flow-editor.css'

import { useIsMobile } from 'ui/hooks/use-mobile'
import { useSidebar } from 'ui/sidebar'
import { Spinner } from 'ui/spinner'

import { ExtensionsStateContext } from '@/app/_authed/(dashboard)/_canvas/extensions-ready-context'
import { InspectorContext, useInspectorState } from '@/app/_authed/(dashboard)/_canvas/inspector-context'
import { NodeContextMenu } from '@/app/_authed/(dashboard)/_canvas/node-context-menu'
import { subscribeNodeDataUpdates } from '@/app/_authed/(dashboard)/_canvas/node-data-events'
import { type BrowserTab, NodeInspector } from '@/app/_authed/(dashboard)/_canvas/node-inspector'
import { graphNodeTypes, nodeTypesKey, typesFromKey } from '@/app/_authed/(dashboard)/_canvas/node-type-keys'
import { buildNodeTypes } from '@/app/_authed/(dashboard)/_canvas/node-wrapper'
import { useBackIntercept, useOverlay } from '@/app/_authed/(dashboard)/_canvas/overlay-context'
import { coalesceReload, type ReloadCoalesceState } from '@/app/_authed/(dashboard)/_canvas/reload-coalesce'
import { useClipboard } from '@/app/_authed/(dashboard)/_canvas/use-clipboard'
import { useGraphEvents } from '@/app/_authed/(dashboard)/_canvas/use-graph-events'
import { installExtensionApi } from '@/app/_authed/(dashboard)/_extension-system/extension-api'
import { loadAllExtensions } from '@/app/_authed/(extension-runtime)/_client/loader'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { findExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { fetchSpaceGraph, saveSpaceGraph } from '@/app/_authed/(space)/_components/space-client'
import { useSSEEvents, useSSEEventsDispatch } from '@/app/_authed/(sse)/_lib/sse-events-store'
import { cn } from '@/lib/utils'

installExtensionApi()

interface PendingConnection {
  fromNodeId: string
  fromHandleId: string
  fromHandleType: 'source' | 'target'
  contextType: string
}

interface MenuState {
  screen: { x: number; y: number }
  flow: { x: number; y: number }
  pending?: PendingConnection
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function snap(v: number): number {
  return Math.round(v / 10) * 10
}

function stripVirtualNodes(nodes: Node[]): Node[] {
  return nodes.filter((n) => n.type !== 'comment').map(({ selectable, ...rest }) => rest)
}

function nodeFrameDefaults(category?: string): Partial<Node> {
  if (category === 'Organization') {
    return { zIndex: -1, style: { width: 400, height: 300 } }
  }
  if (category === 'Windows') {
    return { style: { width: 800, height: 480 } }
  }
  return {}
}

function useDebouncedSave(
  slug: string,
  delay: number,
  versionRef: React.MutableRefObject<string | null>,
  onConflict: () => void,
) {
  const timer = useRef<NodeJS.Timeout>(undefined)
  const save = useCallback(
    (nodes: Node[], edges: Edge[]) => {
      clearTimeout(timer.current)
      timer.current = setTimeout(async () => {
        const result = await saveSpaceGraph(slug, { nodes: stripVirtualNodes(nodes), edges }, versionRef.current)
        if (result.ok) {
          versionRef.current = result.updatedAt
        } else if (result.conflict) {
          onConflict()
        } else {
          // Leave versionRef untouched — we don't know whether the write landed, so
          // asserting a version we didn't confirm could mask a real future conflict.
          toast.error('Failed to save changes. Your next edit will retry.')
        }
      }, delay)
    },
    [slug, delay, versionRef, onConflict],
  )
  useEffect(() => () => clearTimeout(timer.current), [])
  return save
}

async function loadLocalExtensions(): Promise<void> {
  try {
    await loadAllExtensions()
  } catch (err) {
    console.error('Failed to load extensions', err)
    toast.error('Some extensions failed to load')
  }
}

export function FlowEditor({ slug, spaceName }: { slug: string; spaceName: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  // Two independent readiness flags, not one. The graph decides whether there is
  // anything to paint; the extensions decide only how completely each node can
  // be drawn. Collapsing them into a single flag is what held the whole canvas
  // behind the slower of the two.
  const [graphReady, setGraphReady] = useState(false)
  const [extensionsSettled, setExtensionsSettled] = useState(false)
  const [extensionsVersion, setExtensionsVersion] = useState(0)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [inspectorWidth, setInspectorWidth] = useState(420)
  const [resizing, setResizing] = useState(false)
  const [inspectorExpanded, setInspectorExpanded] = useState(false)
  const [browserTab, setBrowserTab] = useState<BrowserTab>('outline')
  const inspector = useInspectorState()
  const overlay = useOverlay()
  const isMobile = useIsMobile()
  const [mobileInspectorVisible, setMobileInspectorVisible] = useState(false)
  const [nodesMovable, setNodesMovable] = useState(false)
  const [nodeMenu, setNodeMenu] = useState<{ screen: { x: number; y: number }; nodeId: string } | null>(null)
  const [overlayActive, setOverlayActive] = useState(false)
  const { toggleSidebar } = useSidebar()

  // Back button closes inspector on mobile
  useBackIntercept(isMobile && mobileInspectorVisible, () => setMobileInspectorVisible(false))
  const { resolvedTheme } = useTheme()
  const { screenToFlowPosition, setCenter, deleteElements } = useReactFlow()
  // Tracks the `updatedAt` this tab last saw for the space's graph row, so
  // saves can assert they're not overwriting a newer write from another tab
  // or an MCP tool call (see GraphConflictError in _server/store.ts).
  const graphVersionRef = useRef<string | null>(null)
  // Single-flight guard for the SSE-triggered extension reload effect below --
  // see its own comment for why concurrent reloads can't just run independently.
  const extensionsReloadRef = useRef<ReloadCoalesceState>({ inFlight: false, pending: false, nextRun: null })
  const handleSaveConflict = useCallback(() => {
    toast.warning('This space changed elsewhere — refreshed to the latest version. Redo your last change if needed.')
    fetchSpaceGraph(slug).then(({ graph, updatedAt }) => {
      setNodes(graph.nodes as Node[])
      setEdges(graph.edges as Edge[])
      graphVersionRef.current = updatedAt
    })
  }, [slug, setNodes, setEdges])
  const debouncedSave = useDebouncedSave(slug, 500, graphVersionRef, handleSaveConflict)
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
  // Load-bearing dependency array — do not "complete" it with `nodes`, and do
  // not add `allNodes` or `extensionsVersion` back.
  //
  // Replacing this object remounts every node on the canvas: the flow library
  // treats a new `nodeTypes` as a new set of components. The only thing that
  // legitimately changes which entries exist is the set of types in the graph.
  //
  // The registered extensions are deliberately absent. An entry does not hold a
  // component, it holds a wrapper that resolves one during render, so an entry
  // does not need rebuilding when its extension registers — it starts resolving
  // on the next render, which the readiness context triggers. Depending on the
  // registry here is what made the map change at the exact moment extensions
  // settled, remounting every node just as the canvas was meant to quietly fill
  // in, and raising the flow library's "new nodeTypes object" warning once per
  // load.
  //
  // `comment` is assigned after the spread so it keeps its own component even
  // though the graph's types feed the map.
  const nodeTypes = useMemo(
    () =>
      ({
        ...buildNodeTypes(typesFromKey(graphTypesKey)),
        comment: CommentNode,
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
  const nodesForFlow = useMemo(
    () => (isMobile ? nodes.map((n) => ({ ...n, className: cn(n.className, 'nopan') })) : nodes),
    [nodes, isMobile],
  )
  const selected = nodes.find((n) => n.selected && n.type !== 'comment') ?? null
  // The MCP Requests browser tab is visible only when no node is selected and
  // nothing overrides the inspector; the ask-user overlay is gated on it.
  const mcpRequestsActive =
    !selected && browserTab === 'mcp' && !inspector.inspectorNode && (!isMobile || mobileInspectorVisible)

  const commandNodes = useMemo<CommandNodeEntry[]>(() => {
    void extensionsVersion
    return nodes
      .filter((n) => n.type !== 'comment')
      .map((n) => {
        const resolved = n.type ? extensionRegistry.resolveNode(n.type) : undefined
        const data = (n.data ?? {}) as Record<string, unknown>
        const label = (data.name as string) || (data.title as string) || resolved?.name || n.id
        return {
          id: n.id,
          label,
          subtitle: resolved?.name ?? n.type ?? '',
          data,
          icon: resolved?.icon ?? Box,
          accent: resolved?.accent ?? 'var(--muted-foreground)',
        }
      })
  }, [nodes, extensionsVersion])

  const focusNode = useCallback(
    (nodeId: string) => {
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) {
        return
      }
      const w = Number(node.measured?.width ?? node.width ?? node.style?.width ?? 0)
      const h = Number(node.measured?.height ?? node.height ?? node.style?.height ?? 0)
      setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1, duration: 300 })
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })))
    },
    [nodes, setCenter, setNodes],
  )

  const dispatchSSEEvent = useSSEEventsDispatch()

  useGraphEvents({
    setNodes,
    onDismissComment: (nodeId) => {
      dispatchSSEEvent({ type: 'clear_comment', nodeId })
    },
  })

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
    graphResult.then(({ graph, updatedAt }) => {
      // Two results settling separately means two chances for a previous
      // space's response to arrive after the slug changed, where there used to
      // be one. Drop anything belonging to a space already navigated away from.
      if (!current) {
        return
      }
      setNodes(graph.nodes as Node[])
      setEdges(graph.edges as Edge[])
      graphVersionRef.current = updatedAt
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

  useEffect(() => {
    if (!graphReady || sse.graphVersion === 0) {
      return
    }
    // Same stale-slug hazard as the extension-reload effect below: navigating
    // away before this resolves must not apply a since-abandoned space's graph
    // onto the canvas now showing a different one.
    let current = true
    fetchSpaceGraph(slug).then(({ graph, updatedAt }) => {
      if (!current) {
        return
      }
      // graph_updated now also fires from this tab's own saves, so this resync
      // fetch is frequently a self-echo. Skip applying it when we already have
      // this exact version — otherwise it clobbers anything typed in the
      // save-broadcast-fetch window with the (identical, but stale-by-now) data
      // we just saved.
      if (updatedAt === graphVersionRef.current) {
        return
      }
      setNodes(graph.nodes as Node[])
      setEdges(graph.edges as Edge[])
      graphVersionRef.current = updatedAt
    })
    return () => {
      current = false
    }
  }, [slug, sse.graphVersion, graphReady, setNodes, setEdges])

  useEffect(() => {
    if (!graphReady || sse.extensionsVersion === 0) {
      return
    }
    // `current` guards only the space-graph portion below, not the extension
    // reload above it: extensions are global, not scoped to this space, so a
    // stale effect run still owes the app a fresh registry. Only applying a
    // FETCHED GRAPH under a slug this effect run no longer owns is the actual
    // cross-space bleed -- the late completion would otherwise
    // paint the old space's nodes, and stamp its `updatedAt` into
    // `graphVersionRef`, onto the canvas now showing the space navigated to,
    // and a subsequent save could then persist one space's content under
    // another space's slug.
    let current = true
    void coalesceReload(extensionsReloadRef.current, async () => {
      recordReloadClear() // TEMPORARY diagnostic
      extensionRegistry.clear()
      await loadLocalExtensions()
      setExtensionsVersion((v) => {
        recordReloadSettled(v + 1) // TEMPORARY diagnostic
        return v + 1
      })
      const { graph, updatedAt } = await fetchSpaceGraph(slug)
      if (!current) {
        return
      }
      setNodes(graph.nodes as Node[])
      setEdges(graph.edges as Edge[])
      graphVersionRef.current = updatedAt
    })
    return () => {
      current = false
    }
  }, [slug, sse.extensionsVersion, graphReady, setNodes, setEdges])

  const scheduleSave = useCallback(
    (n: Node[], e: Edge[]) => {
      if (graphReady) {
        debouncedSave(n, e)
      }
    },
    [graphReady, debouncedSave],
  )

  useEffect(() => {
    return subscribeNodeDataUpdates((nodeId, data) => {
      setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data } : n)))
    })
  }, [setNodes])

  const {
    copy: copySelectedNodes,
    paste: pasteNodes,
    hasCopiedNodes,
  } = useClipboard({ nodes, edges, setNodes, setEdges, onChange: scheduleSave })

  const sectionDrag = useRef<{
    sectionId: string
    startPos: { x: number; y: number }
    childStart: Map<string, { x: number; y: number }>
  } | null>(null)

  const isSectionNode = useCallback((n: Node): boolean => {
    if (!n.type) {
      return false
    }
    const resolved = extensionRegistry.resolveNode(n.type)
    return resolved?.category === 'Organization'
  }, [])

  const captureChildren = useCallback(
    (section: Node): Map<string, { x: number; y: number }> => {
      const positions = new Map<string, { x: number; y: number }>()
      const w = Number(section.style?.width ?? 0)
      const h = Number(section.style?.height ?? 0)
      if (!w || !h) {
        return positions
      }
      const x1 = section.position.x
      const y1 = section.position.y
      const x2 = x1 + w
      const y2 = y1 + h
      for (const n of nodes) {
        if (n.id === section.id || n.selected) {
          continue
        }
        const nw = Number(n.measured?.width ?? n.width ?? n.style?.width ?? 0)
        const nh = Number(n.measured?.height ?? n.height ?? n.style?.height ?? 0)
        const nx1 = n.position.x
        const ny1 = n.position.y
        const nx2 = nx1 + nw
        const ny2 = ny1 + nh
        if (nx1 >= x1 && nx2 <= x2 && ny1 >= y1 && ny2 <= y2) {
          positions.set(n.id, { ...n.position })
        }
      }
      return positions
    },
    [nodes],
  )

  const onNodeDragStart = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!isSectionNode(node)) {
        sectionDrag.current = null
        return
      }
      sectionDrag.current = {
        sectionId: node.id,
        startPos: { ...node.position },
        childStart: captureChildren(node),
      }
    },
    [isSectionNode, captureChildren],
  )

  const onNodeDrag = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const snap = sectionDrag.current
      if (!snap || snap.sectionId !== node.id || snap.childStart.size === 0) {
        return
      }
      const dx = node.position.x - snap.startPos.x
      const dy = node.position.y - snap.startPos.y
      setNodes((nds) =>
        nds.map((n) => {
          const start = snap.childStart.get(n.id)
          if (!start) {
            return n
          }
          return { ...n, position: { x: start.x + dx, y: start.y + dy } }
        }),
      )
    },
    [setNodes],
  )

  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, _node: Node, dragged: Node[]) => {
      const sectionSnap = sectionDrag.current
      const ids = new Set(dragged.map((n) => n.id))
      if (sectionSnap) {
        for (const id of sectionSnap.childStart.keys()) {
          ids.add(id)
        }
      }
      sectionDrag.current = null
      setNodes((nds) => {
        const next = nds.map((n) => {
          if (!ids.has(n.id)) {
            return n
          }
          return { ...n, position: { x: snap(n.position.x), y: snap(n.position.y) } }
        })
        scheduleSave(next, edges)
        return next
      })
    },
    [setNodes, scheduleSave, edges],
  )

  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes)
      const shouldSave = changes.some((c) => {
        if (c.type === 'position') {
          return c.dragging === false
        }
        if (c.type === 'dimensions' || c.type === 'select') {
          return false
        }
        return true
      })
      if (!shouldSave) {
        return
      }
      setNodes((current) => {
        scheduleSave(current, edges)
        return current
      })
    },
    [onNodesChange, setNodes, scheduleSave, edges],
  )

  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes)
      setEdges((current) => {
        scheduleSave(nodes, current)
        return current
      })
    },
    [onEdgesChange, setEdges, scheduleSave, nodes],
  )

  const isValidConnection: IsValidConnection = useCallback(
    (conn) => {
      if (!conn.source || !conn.target || conn.source === conn.target) {
        return false
      }
      if (!conn.sourceHandle || !conn.targetHandle) {
        return false
      }
      const src = nodes.find((n) => n.id === conn.source)
      const tgt = nodes.find((n) => n.id === conn.target)
      if (!src?.type || !tgt?.type) {
        return false
      }
      const srcResolved = extensionRegistry.resolveNode(src.type)
      const tgtResolved = extensionRegistry.resolveNode(tgt.type)
      if (!srcResolved || !tgtResolved) {
        return false
      }
      const srcHandle = findExtensionHandle(srcResolved.handles, conn.sourceHandle, 'source')
      const tgtHandle = findExtensionHandle(tgtResolved.handles, conn.targetHandle, 'target')
      if (!srcHandle || !tgtHandle) {
        return false
      }
      return srcHandle.contextType === tgtHandle.contextType
    },
    [nodes],
  )

  const onConnect = useCallback(
    (conn: Connection) => {
      setEdges((eds) => {
        const next = addEdge(conn, eds)
        scheduleSave(nodes, next)
        return next
      })
    },
    [nodes, setEdges, scheduleSave],
  )

  const styledEdges = useMemo(() => {
    return edges.map((edge) => {
      const tgt = nodes.find((n) => n.id === edge.target)
      const tgtResolved = tgt?.type ? extensionRegistry.resolveNode(tgt.type) : undefined
      const tgtHandle =
        tgtResolved && edge.targetHandle
          ? findExtensionHandle(tgtResolved.handles, edge.targetHandle, 'target')
          : undefined
      const ctxType = tgtHandle?.contextType ? extensionRegistry.getContextType(tgtHandle.contextType) : undefined
      const stroke = ctxType?.color ?? 'var(--muted-foreground)'
      return {
        ...edge,
        animated: true,
        style: { ...edge.style, stroke },
      }
    })
  }, [edges, nodes])

  const addNodeAt = useCallback(
    (typeId: string, flow: { x: number; y: number }) => {
      const resolved = extensionRegistry.resolveNode(typeId)
      if (!resolved) {
        return
      }
      const node: Node = {
        id: newId(typeId),
        type: typeId,
        position: { x: snap(flow.x), y: snap(flow.y) },
        data: { ...resolved.defaultData },
        ...nodeFrameDefaults(resolved.category),
      }
      setNodes((nds) => {
        const next = [...nds, node]
        scheduleSave(next, edges)
        return next
      })
    },
    [setNodes, scheduleSave, edges],
  )

  const addNodeWithConnection = useCallback(
    (typeId: string, flow: { x: number; y: number }, pending: PendingConnection) => {
      const resolved = extensionRegistry.resolveNode(typeId)
      if (!resolved) {
        return
      }
      const oppositeRole = pending.fromHandleType === 'source' ? 'target' : 'source'
      const matchingHandle = resolved.handles.find(
        (h) => h.role === oppositeRole && h.contextType === pending.contextType,
      )
      if (!matchingHandle) {
        addNodeAt(typeId, flow)
        return
      }
      const nodeId = newId(typeId)
      const node: Node = {
        id: nodeId,
        type: typeId,
        position: { x: snap(flow.x), y: snap(flow.y) },
        data: { ...resolved.defaultData },
        ...nodeFrameDefaults(resolved.category),
      }
      const newEdge: Edge =
        pending.fromHandleType === 'source'
          ? {
              id: newId('edge'),
              source: pending.fromNodeId,
              sourceHandle: pending.fromHandleId,
              target: nodeId,
              targetHandle: matchingHandle.id,
            }
          : {
              id: newId('edge'),
              source: nodeId,
              sourceHandle: matchingHandle.id,
              target: pending.fromNodeId,
              targetHandle: pending.fromHandleId,
            }
      const nextNodes = [...nodes, node]
      const nextEdges = [...edges, newEdge]
      setNodes(() => nextNodes)
      setEdges(() => nextEdges)
      scheduleSave(nextNodes, nextEdges)
    },
    [nodes, edges, setNodes, setEdges, scheduleSave, addNodeAt],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const typeId = e.dataTransfer.getData('application/dashboard-extension')
      if (!typeId) {
        return
      }
      addNodeAt(typeId, screenToFlowPosition({ x: e.clientX, y: e.clientY }))
    },
    [addNodeAt, screenToFlowPosition],
  )

  const startInspectorResize = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      const startX = e.clientX
      const startWidth = inspectorWidth
      setResizing(true)
      const onMove = (ev: PointerEvent) => {
        const next = Math.max(320, Math.min(window.innerWidth - 320, startWidth + (startX - ev.clientX)))
        setInspectorWidth(next)
      }
      const onUp = () => {
        setResizing(false)
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [inspectorWidth],
  )

  const updateNodeData = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      setNodes((nds) => {
        const next = nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n))
        scheduleSave(next, edges)
        return next
      })
    },
    [setNodes, scheduleSave, edges],
  )

  const deselect = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })))
  }, [setNodes])

  // Open the MCP Requests inspector tab (e.g. from a corner notification):
  // clear any docked chat, deselect so the node browser is visible.
  const openMcpRequests = useCallback(() => {
    overlay.slots.setSlot('content', null)
    overlay.slots.setSlot('menu', null)
    deselect()
    setBrowserTab('mcp')
    if (isMobile) {
      setMobileInspectorVisible(true)
    }
  }, [overlay.slots.setSlot, deselect, isMobile])

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
      setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })))
      setMobileInspectorVisible(true)
    },
    [setNodes],
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
      const resolved = extensionRegistry.resolveNode(fromNode.type)
      const handle = resolved ? findExtensionHandle(resolved.handles, fromHandle.id, fromHandle.type) : undefined
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
          fromHandleType: fromHandle.type,
          contextType: handle.contextType,
        },
      })
    },
    [screenToFlowPosition],
  )

  const closeMenu = useCallback(() => setMenu(null), [])

  const onMenuSelect = useCallback(
    (typeId: string) => {
      if (!menu) {
        return
      }
      if (menu.pending) {
        addNodeWithConnection(typeId, menu.flow, menu.pending)
      } else {
        addNodeAt(typeId, menu.flow)
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
    const oppositeRole = pending.fromHandleType === 'source' ? 'target' : 'source'
    return allNodes.filter((n) =>
      n.handles.some((h) => h.role === oppositeRole && h.contextType === pending.contextType),
    )
  }, [allNodes, menu])

  const openEditor = useCallback((_extensionId: string | null) => {
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
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
          cancelLongPress()
        }
      }
    },
    [isMobile, cancelLongPress],
  )

  const colorMode = resolvedTheme === 'dark' ? 'dark' : 'light'

  if (!graphReady) {
    return (
      <div className='flex flex-col items-center justify-center h-full gap-3 text-muted-foreground'>
        <Spinner className='size-12' />
        <p className='text-lg font-medium'>Loading space</p>
      </div>
    )
  }

  return (
    // Provided here rather than folded into `nodeTypes`: the node component map
    // is memoised on the set of node types, so feeding either of these through
    // it would replace the map the instant loading settled and remount every
    // node — a visible jolt at exactly the moment the canvas is meant to
    // quietly fill in.
    //
    // This is also how a node picks up its component. Changing this value is
    // the only thing that re-renders the node wrappers when the registry has
    // been written to, and a wrapper resolves its component during render.
    <ExtensionsStateContext.Provider value={extensionsState}>
      <InspectorContext.Provider value={{ setNode: inspector.setNode }}>
        <div className='flex h-full w-full'>
          <div className='flex-1 relative min-w-0'>
            <div
              role='application'
              className='dashboard-mvp-flow absolute inset-0'
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
              onTouchMove={handleTouchMove}
            >
              <ReactFlow
                nodes={nodesForFlow}
                edges={styledEdges}
                nodeTypes={nodeTypes}
                onNodesChange={handleNodesChange}
                onEdgesChange={handleEdgesChange}
                onNodeDragStart={onNodeDragStart}
                onNodeDrag={onNodeDrag}
                onNodeDragStop={onNodeDragStop}
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
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background variant={BackgroundVariant.Dots} gap={10} />
              </ReactFlow>
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
                      onCopy={() => copySelectedNodes()}
                      onDelete={onDeleteSelected}
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
              {/* Mobile overlay toolbar */}
              {isMobile && !overlayActive && (
                <div className='absolute top-3 left-3 z-40 flex flex-col gap-2'>
                  <button
                    type='button'
                    className='size-10 flex items-center justify-center rounded-lg bg-background/80 backdrop-blur border shadow-sm active:bg-accent'
                    onClick={() => toggleSidebar()}
                    title='Toggle sidebar'
                  >
                    <PanelLeft className='size-5' />
                  </button>
                  <button
                    type='button'
                    className={`size-10 flex items-center justify-center rounded-lg border shadow-sm active:bg-accent ${nodesMovable ? 'bg-primary/20 border-primary' : 'bg-background/80 backdrop-blur'}`}
                    onClick={() => setNodesMovable((v) => !v)}
                    title={nodesMovable ? 'Pan canvas' : 'Move nodes'}
                    aria-pressed={nodesMovable}
                  >
                    <Move className='size-5' />
                  </button>
                </div>
              )}
            </div>
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
            <CanvasOverlay
              nodes={commandNodes}
              spaceName={spaceName}
              spaceSlug={slug}
              selectedNodeId={selected?.id ?? null}
              mcpRequestsActive={mcpRequestsActive}
              onFocusNode={focusNode}
              onActiveChange={isMobile ? setOverlayActive : undefined}
              extensionsVersion={extensionsVersion}
            />
            <McpRequestNotifications onOpen={openMcpRequests} />
          </div>
          {(!isMobile || mobileInspectorVisible) && !inspectorExpanded && (
            <div
              onPointerDown={startInspectorResize}
              role='separator'
              aria-orientation='vertical'
              aria-label='Resize inspector'
              className={`relative w-px bg-border cursor-col-resize flex items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 hover:bg-primary/60 transition-colors ${resizing ? 'bg-primary/80' : ''}`}
            >
              <div className='bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border'>
                <GripVertical className='size-2.5' />
              </div>
            </div>
          )}
          {(!isMobile || mobileInspectorVisible || inspectorExpanded) && (
            <div
              className={
                inspectorExpanded || (isMobile && mobileInspectorVisible)
                  ? 'fixed inset-0 z-50'
                  : 'h-full border-l shrink-0 max-w-6xl min-w-md'
              }
              style={inspectorExpanded || (isMobile && mobileInspectorVisible) ? undefined : { width: inspectorWidth }}
            >
              <NodeInspector
                node={selected}
                browserTab={browserTab}
                expanded={inspectorExpanded}
                extensions={allNodes}
                graphNodes={nodes}
                override={inspector.inspectorNode}
                updateNodeData={updateNodeData}
                onBrowserTabChange={setBrowserTab}
                onDeselect={() => {
                  deselect()
                  if (isMobile) {
                    setMobileInspectorVisible(false)
                  }
                }}
                onEditExtension={openEditor}
                onNewExtension={() => openEditor(null)}
                onExpandedChange={setInspectorExpanded}
                onFocusNode={focusNode}
              />
            </div>
          )}
        </div>
      </InspectorContext.Provider>
    </ExtensionsStateContext.Provider>
  )
}
