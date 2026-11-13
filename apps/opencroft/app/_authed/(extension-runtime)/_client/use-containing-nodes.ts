'use client'

import { useMemo } from 'react'

import { useCanvasGraph } from '@/app/_authed/(extension-runtime)/_client/canvas-graph'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { resolveCodeTypeRef } from '@/app/_authed/(extension-runtime)/_declared-types'
import { extensionIdOfType } from '@/app/_authed/(extension-runtime)/_extension-id'
import { absolutePosition, ancestors, byIdOf } from '@/app/_authed/(extension-runtime)/_frame-tree'
import type { NodeActionCtxNode } from '@/app/_authed/(extension-runtime)/_types'

/**
 * The frames `nodeId` is inside, innermost first, as the open canvas has
 * them: what a node action's `containingNodes` answers for the same node, with
 * the same `type` narrowing (bare names resolve against the extension of
 * `nodeId`'s own type). Positions are absolute. Re-renders as nodes change.
 */
export function useContainingNodes(nodeId: string, type?: string): NodeActionCtxNode[] {
  // The stored tree: on a subgraph's canvas React Flow holds its members without their parent.
  const { nodes } = useCanvasGraph()
  return useMemo(() => {
    const node = nodes.find((n) => n.id === nodeId)
    if (!node) {
      return []
    }
    const extensionId = node.type ? extensionIdOfType(node.type) : null
    const wanted =
      type && extensionId
        ? resolveCodeTypeRef(extensionId, type, (qualified) => extensionRegistry.resolveNode(qualified) !== undefined)
        : type
    const byId = byIdOf(nodes)
    return ancestors(nodeId, byId)
      .filter((n) => !wanted || n.type === wanted)
      .map((n) => ({ id: n.id, type: n.type, position: absolutePosition(n, byId), data: n.data }))
  }, [nodes, nodeId, type])
}
