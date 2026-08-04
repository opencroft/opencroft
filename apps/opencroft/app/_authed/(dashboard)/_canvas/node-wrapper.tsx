'use client'

import type { Node, NodeProps } from '@xyflow/react'
import { memo } from 'react'

import { useExtensionsSettled } from '@/app/_authed/(dashboard)/_canvas/extensions-ready-context'
import { NodeAccentProvider } from '@/app/_authed/(dashboard)/_canvas/node-frame'
import { nodeTypeIds } from '@/app/_authed/(dashboard)/_canvas/node-type-keys'
import { UnresolvedNode } from '@/app/_authed/(dashboard)/_canvas/unresolved-node'
import { extensionRegistry, type ResolvedNode } from '@/app/_authed/(extension-runtime)/_client/registry'
import type { NodeData } from '@/app/_authed/(extension-runtime)/_types'
import { RenderBoundary } from '@/components/render-boundary'

interface NodeWrapperProps extends NodeProps<Node<NodeData>> {
  type: string
}

// Node data is an open record, so the name is read defensively rather than
// assumed: a node whose extension has not loaded is exactly the case where
// nothing has validated its shape.
function nodeName(data: NodeData | undefined): string | undefined {
  const name = data?.name
  return typeof name === 'string' && name.length > 0 ? name : undefined
}

function NodeWrapperImpl(props: NodeWrapperProps) {
  const resolved = extensionRegistry.resolveNode(props.type)
  const extensionsSettled = useExtensionsSettled()
  if (!resolved) {
    return <UnresolvedNode type={props.type} name={nodeName(props.data)} settled={extensionsSettled} />
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

// Every type the canvas may be asked to draw needs an entry here, which is more
// than the types that currently resolve: `graphTypes` carries the types present
// in the graph, including those whose extension has not registered yet or never
// will. Without them the flow library substitutes its own default node and logs
// once per node, and the unresolved case never reaches the wrapper above at all
// — so both the loading state and the missing-extension state would be
// unreachable exactly when they are needed.
export function buildNodeTypes(nodes: ResolvedNode[], graphTypes: readonly string[] = []) {
  const entries: Record<string, React.ComponentType<NodeProps<Node<NodeData>>>> = {}
  const typeIds = nodeTypeIds(
    nodes.map((resolved) => resolved.typeId),
    graphTypes,
  )
  for (const typeId of typeIds) {
    const Wrapped = (props: NodeProps<Node<NodeData>>) => <NodeWrapperImpl {...props} type={typeId} />
    Wrapped.displayName = `ExtensionNode(${typeId})`
    entries[typeId] = memo(Wrapped)
  }
  return entries
}
