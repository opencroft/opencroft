'use client'

import { Background, BackgroundVariant, type Node, ReactFlow, ReactFlowProvider } from '@xyflow/react'
import { useMemo } from 'react'

import '@/app/_authed/(dashboard)/_canvas/flow-editor.css'
import { buildNodeTypes } from '@/app/_authed/(dashboard)/_canvas/node-wrapper'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { newNodeData } from '@/app/_authed/(extension-runtime)/_node-defaults'

interface PreviewPanelProps {
  /** The qualified type of the node to preview. */
  previewType: string | null
  version: number
}

export function PreviewPanel({ previewType, version }: PreviewPanelProps) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the registry is mutable module state that no render can see change; `version` is bumped when it is reloaded, so it is what makes the node resolve again
  const resolved = useMemo(
    () => (previewType ? extensionRegistry.resolveNode(previewType) : undefined),
    [previewType, version],
  )

  // The preview graph holds exactly one node, of this type — so the map covers
  // the graph, same rule as the canvas.
  const nodeTypes = useMemo(() => (resolved ? buildNodeTypes([resolved.type]) : {}), [resolved])

  const nodes: Node[] = useMemo(() => {
    if (!resolved) {
      return []
    }
    return [
      {
        id: 'preview',
        type: resolved.type,
        position: { x: 0, y: 0 },
        data: newNodeData(resolved.defaultData),
        selected: true,
        draggable: false,
      },
    ]
  }, [resolved])

  if (!resolved) {
    return (
      <div className='h-full w-full flex items-center justify-center text-xs text-muted-foreground'>
        Compile to preview
      </div>
    )
  }

  return (
    <div className='h-full w-full dashboard-mvp-flow'>
      {/* Each compile draws its code from scratch: a node type keeps one
          component across compiles, so without a new key the node would keep
          its state, and its error card after a render that threw. */}
      <ReactFlowProvider key={version}>
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          selectionOnDrag={false}
          fitView
          fitViewOptions={{ padding: 0.6, maxZoom: 1 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={10} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  )
}
