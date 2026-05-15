'use client';

import {
  ReactFlow,
  Background,
  BackgroundVariant,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Connection,
  type Edge,
  type FinalConnectionState,
  type IsValidConnection,
  type Node,
  type OnEdgesChange,
  type OnNodesChange,
} from '@xyflow/react';
import { SelectionMode } from '@xyflow/system';
import '@xyflow/react/dist/style.css';
import '@xterm/xterm/css/xterm.css';
import { Box, GripVertical, Lock, LockOpen, PanelLeft, Trash2, Wrench } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';


import { ApprovalList } from '@/app/(approvals)/_components/approval-list';
import { type CommandNodeEntry } from '@/app/(dashboard)/_canvas/canvas-command-bar';
import { CanvasOverlay } from '@/app/(dashboard)/_canvas/canvas-overlay';
import { CommentNode } from '@/app/(dashboard)/_canvas/comment-node';
import { FlowContextMenu } from '@/app/(dashboard)/_canvas/flow-context-menu';
import '@/app/(dashboard)/_canvas/flow-editor.css';
import { InspectorContext, useInspectorState } from '@/app/(dashboard)/_canvas/inspector-context';
import { subscribeNodeDataUpdates } from '@/app/(dashboard)/_canvas/node-data-events';
import { NodeInspector } from '@/app/(dashboard)/_canvas/node-inspector';
import { buildNodeTypes } from '@/app/(dashboard)/_canvas/node-wrapper';
import { useBackIntercept } from '@/app/(dashboard)/_canvas/overlay-context';
import { useClipboard } from '@/app/(dashboard)/_canvas/use-clipboard';
import { useGraphEvents } from '@/app/(dashboard)/_canvas/use-graph-events';
import { installExtensionApi } from '@/app/(dashboard)/extension-system/extension-api';
import { loadAllExtensions } from '@/app/(extension-runtime)/_client/loader';
import { extensionRegistry } from '@/app/(extension-runtime)/_client/registry';
import { findExtensionHandle } from '@/app/(extension-runtime)/_types';
import { fetchSpaceGraph, saveSpaceGraph } from '@/app/(space)/space/_components/space-client';
import { useSSEEvents, useSSEEventsDispatch } from '@/app/(sse)/stores/sse-events-store';
import { useSidebar } from '@/components/ui/sidebar';
import { Spinner } from '@/components/ui/spinner';
import { useIsMobile } from '@/hooks/use-mobile';

installExtensionApi();

interface PendingConnection {
  fromNodeId: string;
  fromHandleId: string;
  fromHandleType: 'source' | 'target';
  contextType: string;
}

interface MenuState {
  screen: { x: number; y: number };
  flow: { x: number; y: number };
  pending?: PendingConnection;
}

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function snap(v: number): number {
  return Math.round(v / 10) * 10;
}

function stripVirtualNodes(nodes: Node[]): Node[] {
  return nodes
    .filter((n) => n.type !== 'comment')
    .map(({ selectable, ...rest }) => rest);
}

function nodeFrameDefaults(category?: string): Partial<Node> {
  if (category === 'Organization') {
    return { zIndex: -1, style: { width: 400, height: 300 } };
  }
  if (category === 'Windows') {
    return { style: { width: 800, height: 480 } };
  }
  return {};
}

function useDebouncedSave(slug: string, delay: number) {
  const timer = useRef<NodeJS.Timeout>(undefined);
  const save = useCallback((nodes: Node[], edges: Edge[]) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      saveSpaceGraph(slug, { nodes: stripVirtualNodes(nodes), edges });
    }, delay);
  }, [slug, delay]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return save;
}

async function loadLocalExtensions(): Promise<void> {
  try {
    await loadAllExtensions();
  } catch (err) {
    console.error('Failed to load extensions', err);
    toast.error('Some extensions failed to load');
  }
}

export function FlowEditor({ slug, spaceName }: { slug: string; spaceName: string }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loaded, setLoaded] = useState(false);
  const [extensionsVersion, setExtensionsVersion] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(420);
  const [resizing, setResizing] = useState(false);
  const [inspectorExpanded, setInspectorExpanded] = useState(false);
  const inspector = useInspectorState();
  const isMobile = useIsMobile();
  const [mobileInspectorVisible, setMobileInspectorVisible] = useState(false);
  const [nodesLocked, setNodesLocked] = useState(false);
  const [mobileNodeMenu, setMobileNodeMenu] = useState<{ screen: { x: number; y: number }; nodeId: string } | null>(null);
  const [overlayActive, setOverlayActive] = useState(false);
  const { toggleSidebar } = useSidebar();

  // Back button closes inspector on mobile
  useBackIntercept(isMobile && mobileInspectorVisible, () => setMobileInspectorVisible(false));
  const { resolvedTheme } = useTheme();
  const { screenToFlowPosition, setCenter } = useReactFlow();
  const debouncedSave = useDebouncedSave(slug, 500);
  const sse = useSSEEvents();

  const allNodes = useMemo(() => {
    void extensionsVersion;
    return extensionRegistry.allNodes();
  }, [extensionsVersion]);
  const nodeTypes = useMemo(() => ({
    ...buildNodeTypes(allNodes),
    'comment': CommentNode,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any, [allNodes]);
  const selected = nodes.find((n) => n.selected && n.type !== 'comment') ?? null;

  const commandNodes = useMemo<CommandNodeEntry[]>(() => {
    void extensionsVersion;
    return nodes
      .filter((n) => n.type !== 'comment')
      .map((n) => {
        const resolved = n.type ? extensionRegistry.resolveNode(n.type) : undefined;
        const data = (n.data ?? {}) as Record<string, unknown>;
        const label = (data.name as string) || (data.title as string) || resolved?.name || n.id;
        return {
          id: n.id,
          label,
          subtitle: resolved?.name ?? n.type ?? '',
          data,
          icon: resolved?.icon ?? Box,
          accent: resolved?.accent ?? 'var(--muted-foreground)',
        };
      });
  }, [nodes, extensionsVersion]);

  const focusNode = useCallback((nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) {
      return;
    }
    const w = Number(node.measured?.width ?? node.width ?? node.style?.width ?? 0);
    const h = Number(node.measured?.height ?? node.height ?? node.style?.height ?? 0);
    setCenter(node.position.x + w / 2, node.position.y + h / 2, { zoom: 1, duration: 300 });
    setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })));
  }, [nodes, setCenter, setNodes]);

  const dispatchSSEEvent = useSSEEventsDispatch();

  useGraphEvents({
    setNodes,
    onDismissComment: (nodeId) => {
      dispatchSSEEvent({ type: 'clear_comment', nodeId });
    },
  });

  useEffect(() => {
    async function boot() {
      await loadLocalExtensions();
      const graph = await fetchSpaceGraph(slug);
      setNodes(graph.nodes as Node[]);
      setEdges(graph.edges as Edge[]);
      setExtensionsVersion((v) => v + 1);
      setLoaded(true);
    }
    setLoaded(false);
    boot();
  }, [slug, setNodes, setEdges]);

  useEffect(() => {
    if (!loaded || sse.graphVersion === 0) {
      return;
    }
    fetchSpaceGraph(slug).then((graph) => {
      setNodes(graph.nodes as Node[]);
      setEdges(graph.edges as Edge[]);
    });
  }, [slug, sse.graphVersion, loaded, setNodes, setEdges]);

  useEffect(() => {
    if (!loaded || sse.extensionsVersion === 0) {
      return;
    }
    async function reload() {
      extensionRegistry.clear();
      await loadLocalExtensions();
      setExtensionsVersion((v) => v + 1);
      const graph = await fetchSpaceGraph(slug);
      setNodes(graph.nodes as Node[]);
      setEdges(graph.edges as Edge[]);
    }
    reload();
  }, [slug, sse.extensionsVersion, loaded, setNodes, setEdges]);

  const scheduleSave = useCallback((n: Node[], e: Edge[]) => {
    if (loaded) {
      debouncedSave(n, e);
    }
  }, [loaded, debouncedSave]);

  useEffect(() => {
    return subscribeNodeDataUpdates((nodeId, data) => {
      setNodes((nds) => nds.map((n) => (n.id === nodeId ? { ...n, data } : n)));
    });
  }, [setNodes]);

  useClipboard({ nodes, edges, setNodes, setEdges, onChange: scheduleSave });

  const sectionDrag = useRef<{
    sectionId: string;
    startPos: { x: number; y: number };
    childStart: Map<string, { x: number; y: number }>;
  } | null>(null);

  const isSectionNode = useCallback((n: Node): boolean => {
    if (!n.type) {
      return false;
    }
    const resolved = extensionRegistry.resolveNode(n.type);
    return resolved?.category === 'Organization';
  }, []);

  const captureChildren = useCallback((section: Node): Map<string, { x: number; y: number }> => {
    const positions = new Map<string, { x: number; y: number }>();
    const w = Number(section.style?.width ?? 0);
    const h = Number(section.style?.height ?? 0);
    if (!w || !h) {
      return positions;
    }
    const x1 = section.position.x;
    const y1 = section.position.y;
    const x2 = x1 + w;
    const y2 = y1 + h;
    for (const n of nodes) {
      if (n.id === section.id || n.selected) {
        continue;
      }
      const nw = Number(n.measured?.width ?? n.width ?? n.style?.width ?? 0);
      const nh = Number(n.measured?.height ?? n.height ?? n.style?.height ?? 0);
      const nx1 = n.position.x;
      const ny1 = n.position.y;
      const nx2 = nx1 + nw;
      const ny2 = ny1 + nh;
      if (nx1 >= x1 && nx2 <= x2 && ny1 >= y1 && ny2 <= y2) {
        positions.set(n.id, { ...n.position });
      }
    }
    return positions;
  }, [nodes]);

  const onNodeDragStart = useCallback((_event: React.MouseEvent, node: Node) => {
    if (!isSectionNode(node)) {
      sectionDrag.current = null;
      return;
    }
    sectionDrag.current = {
      sectionId: node.id,
      startPos: { ...node.position },
      childStart: captureChildren(node),
    };
  }, [isSectionNode, captureChildren]);

  const onNodeDrag = useCallback((_event: React.MouseEvent, node: Node) => {
    const snap = sectionDrag.current;
    if (!snap || snap.sectionId !== node.id || snap.childStart.size === 0) {
      return;
    }
    const dx = node.position.x - snap.startPos.x;
    const dy = node.position.y - snap.startPos.y;
    setNodes((nds) => nds.map((n) => {
      const start = snap.childStart.get(n.id);
      if (!start) {
        return n;
      }
      return { ...n, position: { x: start.x + dx, y: start.y + dy } };
    }));
  }, [setNodes]);

  const onNodeDragStop = useCallback((_event: React.MouseEvent, _node: Node, dragged: Node[]) => {
    const sectionSnap = sectionDrag.current;
    const ids = new Set(dragged.map((n) => n.id));
    if (sectionSnap) {
      for (const id of sectionSnap.childStart.keys()) {
        ids.add(id);
      }
    }
    sectionDrag.current = null;
    setNodes((nds) => {
      const next = nds.map((n) => {
        if (!ids.has(n.id)) {
          return n;
        }
        return { ...n, position: { x: snap(n.position.x), y: snap(n.position.y) } };
      });
      scheduleSave(next, edges);
      return next;
    });
  }, [setNodes, scheduleSave, edges]);

  const handleNodesChange: OnNodesChange = useCallback((changes) => {
    onNodesChange(changes);
    const shouldSave = changes.some((c) => {
      if (c.type === 'position') {
        return c.dragging === false;
      }
      if (c.type === 'dimensions' || c.type === 'select') {
        return false;
      }
      return true;
    });
    if (!shouldSave) {
      return;
    }
    setNodes((current) => {
      scheduleSave(current, edges);
      return current;
    });
  }, [onNodesChange, setNodes, scheduleSave, edges]);

  const handleEdgesChange: OnEdgesChange = useCallback((changes) => {
    onEdgesChange(changes);
    setEdges((current) => {
      scheduleSave(nodes, current);
      return current;
    });
  }, [onEdgesChange, setEdges, scheduleSave, nodes]);

  const isValidConnection: IsValidConnection = useCallback((conn) => {
    if (!conn.source || !conn.target || conn.source === conn.target) {
      return false;
    }
    if (!conn.sourceHandle || !conn.targetHandle) {
      return false;
    }
    const src = nodes.find((n) => n.id === conn.source);
    const tgt = nodes.find((n) => n.id === conn.target);
    if (!src?.type || !tgt?.type) {
      return false;
    }
    const srcResolved = extensionRegistry.resolveNode(src.type);
    const tgtResolved = extensionRegistry.resolveNode(tgt.type);
    if (!srcResolved || !tgtResolved) {
      return false;
    }
    const srcHandle = findExtensionHandle(srcResolved.handles, conn.sourceHandle, 'source');
    const tgtHandle = findExtensionHandle(tgtResolved.handles, conn.targetHandle, 'target');
    if (!srcHandle || !tgtHandle) {
      return false;
    }
    return srcHandle.contextType === tgtHandle.contextType;
  }, [nodes]);

  const onConnect = useCallback((conn: Connection) => {
    setEdges((eds) => {
      const next = addEdge(conn, eds);
      scheduleSave(nodes, next);
      return next;
    });
  }, [nodes, setEdges, scheduleSave]);

  const styledEdges = useMemo(() => {
    return edges.map((edge) => {
      const tgt = nodes.find((n) => n.id === edge.target);
      const tgtResolved = tgt?.type ? extensionRegistry.resolveNode(tgt.type) : undefined;
      const tgtHandle = tgtResolved && edge.targetHandle
        ? findExtensionHandle(tgtResolved.handles, edge.targetHandle, 'target')
        : undefined;
      const ctxType = tgtHandle?.contextType
        ? extensionRegistry.getContextType(tgtHandle.contextType)
        : undefined;
      const stroke = ctxType?.color ?? 'var(--muted-foreground)';
      return {
        ...edge,
        animated: true,
        style: { ...edge.style, stroke },
      };
    });
  }, [edges, nodes]);

  const addNodeAt = useCallback((typeId: string, flow: { x: number; y: number }) => {
    const resolved = extensionRegistry.resolveNode(typeId);
    if (!resolved) {
      return;
    }
    const node: Node = {
      id: newId(typeId),
      type: typeId,
      position: { x: snap(flow.x), y: snap(flow.y) },
      data: { ...resolved.defaultData },
      ...nodeFrameDefaults(resolved.category),
    };
    setNodes((nds) => {
      const next = [...nds, node];
      scheduleSave(next, edges);
      return next;
    });
  }, [setNodes, scheduleSave, edges]);

  const addNodeWithConnection = useCallback((typeId: string, flow: { x: number; y: number }, pending: PendingConnection) => {
    const resolved = extensionRegistry.resolveNode(typeId);
    if (!resolved) {
      return;
    }
    const oppositeRole = pending.fromHandleType === 'source' ? 'target' : 'source';
    const matchingHandle = resolved.handles.find((h) => h.role === oppositeRole && h.contextType === pending.contextType);
    if (!matchingHandle) {
      addNodeAt(typeId, flow);
      return;
    }
    const nodeId = newId(typeId);
    const node: Node = {
      id: nodeId,
      type: typeId,
      position: { x: snap(flow.x), y: snap(flow.y) },
      data: { ...resolved.defaultData },
      ...nodeFrameDefaults(resolved.category),
    };
    const newEdge: Edge = pending.fromHandleType === 'source'
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
      };
    const nextNodes = [...nodes, node];
    const nextEdges = [...edges, newEdge];
    setNodes(() => nextNodes);
    setEdges(() => nextEdges);
    scheduleSave(nextNodes, nextEdges);
  }, [nodes, edges, setNodes, setEdges, scheduleSave, addNodeAt]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const typeId = e.dataTransfer.getData('application/dashboard-extension');
    if (!typeId) {
      return;
    }
    addNodeAt(typeId, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  }, [addNodeAt, screenToFlowPosition]);

  const startInspectorResize = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = inspectorWidth;
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      const next = Math.max(320, Math.min(window.innerWidth - 320, startWidth + (startX - ev.clientX)));
      setInspectorWidth(next);
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [inspectorWidth]);

  const updateNodeData = useCallback((nodeId: string, patch: Record<string, unknown>) => {
    setNodes((nds) => {
      const next = nds.map((n) => (
        n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n
      ));
      scheduleSave(next, edges);
      return next;
    });
  }, [setNodes, scheduleSave, edges]);

  const deselect = useCallback(() => {
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
  }, [setNodes]);

  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    event.preventDefault();
    const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    setMenu({ screen: { x: event.clientX, y: event.clientY }, flow });
  }, [screenToFlowPosition]);

  const onConnectEnd = useCallback((event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid) {
      return;
    }
    const fromHandle = state.fromHandle;
    const fromNode = state.fromNode;
    if (!fromHandle?.id || !fromHandle.type || !fromNode?.type) {
      return;
    }
    const resolved = extensionRegistry.resolveNode(fromNode.type);
    const handle = resolved
      ? findExtensionHandle(resolved.handles, fromHandle.id, fromHandle.type)
      : undefined;
    if (!handle) {
      return;
    }
    const point = 'clientX' in event
      ? { x: event.clientX, y: event.clientY }
      : { x: event.changedTouches[0]?.clientX ?? 0, y: event.changedTouches[0]?.clientY ?? 0 };
    const flow = screenToFlowPosition(point);
    setMenu({
      screen: point,
      flow,
      pending: {
        fromNodeId: fromNode.id,
        fromHandleId: fromHandle.id,
        fromHandleType: fromHandle.type,
        contextType: handle.contextType,
      },
    });
  }, [screenToFlowPosition]);

  const closeMenu = useCallback(() => setMenu(null), []);

  const onMenuSelect = useCallback((typeId: string) => {
    if (!menu) {
      return;
    }
    if (menu.pending) {
      addNodeWithConnection(typeId, menu.flow, menu.pending);
    } else {
      addNodeAt(typeId, menu.flow);
    }
    setMenu(null);
  }, [menu, addNodeAt, addNodeWithConnection]);

  const menuExtensions = useMemo(() => {
    if (!menu?.pending) {
      return allNodes;
    }
    const pending = menu.pending;
    const oppositeRole = pending.fromHandleType === 'source' ? 'target' : 'source';
    return allNodes.filter((n) => (
      n.handles.some((h) => h.role === oppositeRole && h.contextType === pending.contextType)
    ));
  }, [allNodes, menu]);

  const openEditor = useCallback((_extensionId: string | null) => {
    // Navigate to /extensions page
    window.location.href = '/extensions';
  }, []);


  // Mobile long-press handling
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);
  const touchTargetRef = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null);

  const cancelLongPress = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (!isMobile) {
      return;
    }
    longPressFired.current = false;
    const touch = e.touches[0];
    touchTargetRef.current = { x: touch.clientX, y: touch.clientY, target: touch.target };
    cancelLongPress();
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      const { x, y, target } = touchTargetRef.current ?? {};
      // Use saved target first, fallback to elementFromPoint
      const el = (target instanceof Element ? target : null) ?? document.elementFromPoint(x ?? 0, y ?? 0);
      const nodeEl = el?.closest('.react-flow__node');
      if (nodeEl) {
        // Long press on node -> show mobile context menu
        const nodeId = nodeEl.getAttribute('data-id');
        if (nodeId) {
          setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === nodeId })));
          setMobileNodeMenu({ screen: { x: x ?? 0, y: y ?? 0 }, nodeId });
        }
      } else {
        // Long press on empty pane -> open context menu
        const flow = screenToFlowPosition({ x: x ?? 0, y: y ?? 0 });
        setMenu({ screen: { x: x ?? 0, y: y ?? 0 }, flow });
      }
    }, 500);
  }, [isMobile, cancelLongPress, setNodes, screenToFlowPosition]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!isMobile) {
      return;
    }
    cancelLongPress();
    if (!longPressFired.current) {
      // Short tap on empty space -> deselect and hide inspector
      const touch = e.changedTouches[0];
      const el = (touch.target instanceof Element ? touch.target as Element : null) ?? document.elementFromPoint(touch.clientX, touch.clientY);
      const nodeEl = el?.closest('.react-flow__node');
      if (!nodeEl) {
        deselect();
        setMobileInspectorVisible(false);
      }
    }
    longPressFired.current = false;
  }, [isMobile, cancelLongPress, deselect]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!isMobile) {
      return;
    }
    // Cancel long press if finger moved too far
    const touch = e.touches[0];
    const start = touchTargetRef.current;
    if (start) {
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
        cancelLongPress();
      }
    }
  }, [isMobile, cancelLongPress]);

  const colorMode = resolvedTheme === 'dark' ? 'dark' : 'light';

  if (!loaded) {
    return (
      <div className='flex flex-col items-center justify-center h-full gap-3 text-muted-foreground'>
        <Spinner className='size-12' />
        <p className='text-lg font-medium'>Loading space</p>
      </div>
    );
  }

  return (
    <InspectorContext.Provider value={{ setNode: inspector.setNode }}>
      <div className="flex h-full w-full">
        <div className="flex-1 relative min-w-0">
          <div
            className="dashboard-mvp-flow absolute inset-0"
            onDragOver={handleDragOver}
            onDrop={handleDrop}
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
            onTouchMove={handleTouchMove}
          >
            <ReactFlow
              nodes={nodes}
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
              onNodeContextMenu={isMobile
                ? (e: React.MouseEvent, node: Node) => {
                  e.preventDefault();
                  setNodes((nds) => nds.map((n) => ({ ...n, selected: n.id === node.id })));
                  setMobileNodeMenu({ screen: { x: e.clientX, y: e.clientY }, nodeId: node.id });
                }
                : onPaneContextMenu}
              onPaneClick={() => {
                closeMenu(); setMobileNodeMenu(null); if (isMobile) {
                  deselect(); setMobileInspectorVisible(false);
                }
              }}
              deleteKeyCode={['Backspace', 'Delete']}
              multiSelectionKeyCode='Shift'
              selectionKeyCode='Shift'
              nodesDraggable={isMobile ? !nodesLocked : undefined}
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
            {/* Mobile node context menu */}
            {isMobile && mobileNodeMenu && (
              <div
                className="fixed inset-0 z-50"
                onClick={() => setMobileNodeMenu(null)}
                onTouchEnd={() => setMobileNodeMenu(null)}
              >
                <div
                  className="absolute bg-popover border rounded-lg shadow-lg py-1 min-w-[140px]"
                  style={{
                    left: Math.min(mobileNodeMenu.screen.x, window.innerWidth - 160),
                    top: Math.min(mobileNodeMenu.screen.y, window.innerHeight - 100),
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onTouchEnd={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm hover:bg-accent/50 transition-colors"
                    onClick={() => {
                      setMobileInspectorVisible(true);
                      setMobileNodeMenu(null);
                    }}
                  >
                    <Wrench className="size-4" />
                    Details
                  </button>
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm text-destructive hover:bg-accent/50 transition-colors"
                    onClick={() => {
                      setNodes((nds) => nds.filter((n) => !n.selected));
                      setMobileNodeMenu(null);
                    }}
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </button>
                </div>
              </div>
            )}
            {/* Mobile overlay toolbar */}
            {isMobile && !overlayActive && (
              <div className="absolute top-3 left-3 z-40 flex flex-col gap-2">
                <button
                  type="button"
                  className="size-10 flex items-center justify-center rounded-lg bg-background/80 backdrop-blur border shadow-sm active:bg-accent"
                  onClick={() => toggleSidebar()}
                  title="Toggle sidebar"
                >
                  <PanelLeft className="size-5" />
                </button>
                <button
                  type="button"
                  className={`size-10 flex items-center justify-center rounded-lg border shadow-sm active:bg-accent ${nodesLocked ? 'bg-primary/20 border-primary' : 'bg-background/80 backdrop-blur'}`}
                  onClick={() => setNodesLocked((v) => !v)}
                  title={nodesLocked ? 'Unlock nodes' : 'Lock nodes'}
                >
                  {nodesLocked ? <Lock className="size-5" /> : <LockOpen className="size-5" />}
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
            />
          )}
          <CanvasOverlay
            nodes={commandNodes}
            spaceName={spaceName}
            spaceSlug={slug}
            selectedNodeId={selected?.id ?? null}
            onFocusNode={focusNode}
            onActiveChange={isMobile ? setOverlayActive : undefined}
          />
          <ApprovalList spaceId={slug} />
        </div>
        {(!isMobile || mobileInspectorVisible) && !inspectorExpanded && (
          <div
            onPointerDown={startInspectorResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize inspector"
            className={`relative w-px bg-border cursor-col-resize flex items-center justify-center after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 hover:bg-primary/60 transition-colors ${resizing ? 'bg-primary/80' : ''}`}
          >
            <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
              <GripVertical className="size-2.5" />
            </div>
          </div>
        )}
        {(!isMobile || mobileInspectorVisible || inspectorExpanded) && (
          <div
            className={inspectorExpanded || (isMobile && mobileInspectorVisible)
              ? 'fixed inset-0 z-50'
              : 'h-full border-l shrink-0 max-w-6xl min-w-md'}
            style={inspectorExpanded || (isMobile && mobileInspectorVisible) ? undefined : { width: inspectorWidth }}
          >
            <NodeInspector
              node={selected}
              expanded={inspectorExpanded}
              extensions={allNodes}
              graphNodes={nodes}
              override={inspector.inspectorNode}
              updateNodeData={updateNodeData}
              onDeselect={() => {
                deselect(); if (isMobile) {
                  setMobileInspectorVisible(false);
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
  );
}
