'use client'

import { useEdges, useNodes } from '@xyflow/react'
import { useMemo } from 'react'

import { resolveSourceContext } from '@/app/_authed/(dashboard)/_extension-system/context-resolver'
import { feedingEdges } from '@/app/_authed/(extension-runtime)/_input-edges'
import type { ResolvedContext } from '@/app/_authed/(extension-runtime)/_types'

export function useNodeContext<V = unknown>(nodeId: string, targetHandleId: string): ResolvedContext<V> | null {
  const nodes = useNodes()
  const edges = useEdges()

  const edge = feedingEdges(edges).find((e) => e.target === nodeId && e.targetHandle === targetHandleId)
  const sourceNode = edge ? nodes.find((n) => n.id === edge.source) : undefined
  const ctx =
    sourceNode && edge?.sourceHandle ? resolveSourceContext(sourceNode, edge.sourceHandle, { nodes, edges }) : null

  // The context can be built from anywhere upstream of the source, so it is
  // resolved against the whole graph on every change. Keyed on its content,
  // so moving an unrelated node does not hand consumers a new context object.
  const key = ctx ? JSON.stringify(ctx) : ''
  return useMemo(() => (key ? (JSON.parse(key) as ResolvedContext<V>) : null), [key])
}
