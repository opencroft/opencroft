'use client'

import type { Node, NodeProps } from '@xyflow/react'
import { memo } from 'react'

import { useExtensionsSettled } from '@/app/_authed/(dashboard)/_canvas/extensions-ready-context'
import { NODE_CARD_MAX_WIDTH } from '@/app/_authed/(dashboard)/_canvas/node-card'
import { NodeAccentProvider } from '@/app/_authed/(dashboard)/_canvas/node-frame'
import { UnresolvedNode } from '@/app/_authed/(dashboard)/_canvas/unresolved-node'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
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
      <RenderBoundary scope='ext' label={props.type} resetKey={props.type} style={{ maxWidth: NODE_CARD_MAX_WIDTH }}>
        <Component {...props} />
      </RenderBoundary>
    </NodeAccentProvider>
  )
}

// One entry per node type PRESENT IN THE GRAPH, including types whose extension
// has not registered yet or never will. Without an entry the flow library
// substitutes its own default node and logs once per node, and the unresolved
// case never reaches the wrapper above at all — so both the loading state and
// the missing-extension state would be unreachable exactly when they are needed.
//
// Deliberately NOT the registered extensions, and that is the whole trick: an
// entry is a wrapper that resolves its component during render, so it does not
// have to be rebuilt when its extension arrives, and a registered type with no
// node on the canvas is never looked up. Building from the graph's types alone
// means this map does not change when extensions settle — which is what stops
// the flow library discarding and recreating every node at that moment.
export function buildNodeTypes(typeIds: readonly string[]) {
  const entries: Record<string, React.ComponentType<NodeProps<Node<NodeData>>>> = {}
  for (const typeId of typeIds) {
    const Wrapped = (props: NodeProps<Node<NodeData>>) => <NodeWrapperImpl {...props} type={typeId} />
    Wrapped.displayName = `ExtensionNode(${typeId})`
    entries[typeId] = memo(Wrapped)
  }
  return entries
}
