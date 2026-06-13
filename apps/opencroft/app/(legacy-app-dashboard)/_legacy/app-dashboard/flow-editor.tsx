'use client'

import {
  addEdge,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type Node,
  type OnConnect,
  type OnEdgesChange,
  type OnNodesChange,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from '@xyflow/react'
import { SelectionMode } from '@xyflow/system'
import '@xyflow/react/dist/style.css'
import { useTheme } from 'next-themes'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { loadGraph, saveGraph } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/actions'
import { CommentNode } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/bubble-hint-node'
import { FlowContextMenu } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/context-menu'
import { useCustomTemplates } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/custom-templates-context'
import '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/flow-editor.css'
import { useGraphEvents } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/hooks/use-graph-events'
import { NodeSettingsPanel } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/node-settings-panel'
import { buildNodeTypes } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/registry'
import { TemplateEditorDialog } from '@/app/(legacy-app-dashboard)/_legacy/app-dashboard/template-editor-dialog'
import { nodeDefinitions } from '@/app/(legacy-app-dashboard)/_legacy/nodes'
import type { CustomTemplate } from '@/app/(legacy-app-dashboard)/_legacy/nodes/custom/types'
import { WindowNodeComponent } from '@/app/(legacy-app-dashboard)/_legacy/nodes/window'
import { useSSEEventsDispatch } from '@/app/(sse)/_lib/sse-events-store'

interface MenuState {
  screen: { x: number; y: number }
  flow: { x: number; y: number }
}

function useDebouncedSave(delay: number) {
  const timer = useRef<NodeJS.Timeout>(undefined)
  const save = useCallback(
    (nodes: Node[], edges: Edge[]) => {
      clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        saveGraph({ data: { nodes: nodes.filter((n) => n.type !== 'window' && n.type !== 'comment'), edges } })
      }, delay)
    },
    [delay],
  )

  useEffect(() => () => clearTimeout(timer.current), [])
  return save
}

export function FlowEditor() {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<CustomTemplate | null | undefined>(undefined)
  const { definitions: customDefinitions } = useCustomTemplates()
  const { screenToFlowPosition } = useReactFlow()
  const { resolvedTheme } = useTheme()

  const colorMode = resolvedTheme === 'dark' ? 'dark' : 'light'
  const allDefinitions = useMemo(() => [...nodeDefinitions, ...customDefinitions], [customDefinitions])

  const nodeTypes = useMemo(
    () =>
      ({
        ...buildNodeTypes(allDefinitions),
        window: WindowNodeComponent,
        comment: CommentNode,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    [allDefinitions],
  )
  const debouncedSave = useDebouncedSave(500)

  const dispatchSSEEvent = useSSEEventsDispatch()

  useGraphEvents({
    setNodes,
    onDismissComment: (nodeId) => {
      dispatchSSEEvent({ type: 'clear_comment', nodeId })
    },
  })

  const selected = nodes.find((n) => n.selected)

  useEffect(() => {
    loadGraph().then((data) => {
      setNodes(data.nodes as Node[])
      setEdges(data.edges as Edge[])
      setLoaded(true)
    })
  }, [setNodes, setEdges])

  const scheduleAutoSave = useCallback(
    (n: Node[], e: Edge[]) => {
      if (loaded) {
        debouncedSave(n, e)
      }
    },
    [loaded, debouncedSave],
  )

  const handleNodesChange: OnNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes)
      setNodes((current) => {
        scheduleAutoSave(current, edges)
        return current
      })
    },
    [onNodesChange, setNodes, scheduleAutoSave, edges],
  )

  const handleEdgesChange: OnEdgesChange = useCallback(
    (changes) => {
      onEdgesChange(changes)
      setEdges((current) => {
        scheduleAutoSave(nodes, current)
        return current
      })
    },
    [onEdgesChange, setEdges, scheduleAutoSave, nodes],
  )

  const onConnect: OnConnect = useCallback(
    (params) => {
      setEdges((eds) => {
        const next = addEdge(params, eds)
        scheduleAutoSave(nodes, next)
        return next
      })
    },
    [setEdges, scheduleAutoSave, nodes],
  )

  const isValidConnection = useCallback((connection: Edge | Connection) => {
    if (connection.source === connection.target) {
      return false
    }
    return (connection.sourceHandle ?? null) === (connection.targetHandle ?? null)
  }, [])

  const isSectionType = (type: string | undefined): boolean => type === 'section' || type === 'domain'

  const sectionDrag = useRef<{ x: number; y: number; childIds: Set<string> } | null>(null)

  const onNodeDragStart = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!isSectionType(node.type)) {
        return
      }
      const sw = (node.style?.width as number) ?? 400
      const sh = (node.style?.height as number) ?? 300
      const childIds = new Set<string>()
      for (const n of nodes) {
        if (n.id === node.id) {
          continue
        }
        const nw = (isSectionType(n.type) ? (n.style?.width as number) : n.measured?.width) ?? 200
        const nh = (isSectionType(n.type) ? (n.style?.height as number) : n.measured?.height) ?? 60
        if (
          n.position.x >= node.position.x &&
          n.position.x + nw <= node.position.x + sw &&
          n.position.y >= node.position.y &&
          n.position.y + nh <= node.position.y + sh
        ) {
          childIds.add(n.id)
        }
      }
      sectionDrag.current = { x: node.position.x, y: node.position.y, childIds }
    },
    [nodes],
  )

  const onNodeDrag = useCallback(
    (_event: React.MouseEvent, node: Node) => {
      if (!isSectionType(node.type) || !sectionDrag.current || sectionDrag.current.childIds.size === 0) {
        return
      }
      const dx = node.position.x - sectionDrag.current.x
      const dy = node.position.y - sectionDrag.current.y
      if (dx === 0 && dy === 0) {
        return
      }
      sectionDrag.current.x = node.position.x
      sectionDrag.current.y = node.position.y

      setNodes((nds) =>
        nds.map((n) => {
          if (!sectionDrag.current?.childIds.has(n.id)) {
            return n
          }
          return { ...n, position: { x: n.position.x + dx, y: n.position.y + dy } }
        }),
      )
    },
    [setNodes],
  )

  const onPaneContextMenu = useCallback(
    (event: React.MouseEvent | MouseEvent) => {
      event.preventDefault()
      const flow = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      setMenu({
        screen: { x: event.clientX, y: event.clientY },
        flow,
      })
    },
    [screenToFlowPosition],
  )

  const onAddNode = useCallback(
    (type: string) => {
      if (!menu) {
        return
      }
      const def = allDefinitions.find((d) => d.type === type)
      if (!def) {
        return
      }
      const isSection = isSectionType(type)
      const snap = (v: number) => Math.round(v / 10) * 10
      const node: Node = {
        id: crypto.randomUUID(),
        type,
        position: { x: snap(menu.flow.x), y: snap(menu.flow.y) },
        data: def.defaultData(),
        ...(isSection ? { style: { width: 400, height: 300 }, zIndex: -1 } : {}),
      }
      setNodes((nds) => {
        const next = isSection ? [node, ...nds] : [...nds, node]
        scheduleAutoSave(next, edges)
        return next
      })
      setMenu(null)
    },
    [menu, allDefinitions, setNodes, scheduleAutoSave, edges],
  )

  const closeMenu = useCallback(() => setMenu(null), [])

  if (!loaded) {
    return null
  }

  return (
    <div className='h-full w-full flex'>
      <div className='flex-1'>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onPaneContextMenu}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onPaneClick={closeMenu}
          deleteKeyCode={['Backspace', 'Delete']}
          selectionOnDrag
          panOnDrag={[1]}
          selectionMode={SelectionMode.Partial}
          colorMode={colorMode}
          zIndexMode='manual'
          snapToGrid
          snapGrid={[10, 10]}
          maxZoom={1}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={10} />
          <Controls />
        </ReactFlow>
        {menu && (
          <FlowContextMenu
            position={menu.screen}
            definitions={allDefinitions}
            onSelect={onAddNode}
            onNewCustomType={() => {
              setEditingTemplate(null)
              setMenu(null)
            }}
            onClose={closeMenu}
          />
        )}
      </div>
      {selected && selected.type !== 'window' && (
        <NodeSettingsPanel node={selected} onEditTemplate={setEditingTemplate} />
      )}
      <TemplateEditorDialog
        open={editingTemplate !== undefined}
        template={editingTemplate ?? null}
        onClose={() => setEditingTemplate(undefined)}
      />
    </div>
  )
}
