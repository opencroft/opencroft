'use client'

import type { Node, NodeProps } from '@xyflow/react'
import { memo } from 'react'

import { NodeAccentProvider } from '@/app/_authed/(dashboard)/_canvas/node-frame'
import { extensionRegistry, type ResolvedNode } from '@/app/_authed/(extension-runtime)/_client/registry'
import type { NodeData } from '@/app/_authed/(extension-runtime)/_types'
import { RenderBoundary } from '@/components/render-boundary'

interface NodeWrapperProps extends NodeProps<Node<NodeData>> {
  type: string
}

function NodeWrapperImpl(props: NodeWrapperProps) {
  const resolved = extensionRegistry.resolveNode(props.type)
  if (!resolved) {
    return (
      <div className='rounded-md border border-destructive bg-destructive/10 text-destructive px-2 py-1 text-xs'>
        Unknown extension: {props.type}
      </div>
    )
  }
  const Component = resolved.component
  return (
    <NodeAccentProvider accent={resolved.accent}>
      <RenderBoundary scope='ext' label={props.type} resetKey={props.type} className='max-w-60'>
        <Component {...props} />
      </RenderBoundary>
    </NodeAccentProvider>
  )
}

export function buildNodeTypes(nodes: ResolvedNode[]) {
  const entries: Record<string, React.ComponentType<NodeProps<Node<NodeData>>>> = {}
  for (const resolved of nodes) {
    const typeId = resolved.typeId
    const Wrapped = (props: NodeProps<Node<NodeData>>) => <NodeWrapperImpl {...props} type={typeId} />
    Wrapped.displayName = `ExtensionNode(${typeId})`
    entries[typeId] = memo(Wrapped)
  }
  return entries
}
