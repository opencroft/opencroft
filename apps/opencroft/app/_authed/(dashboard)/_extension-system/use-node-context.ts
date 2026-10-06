'use client'

import { useEdges, useNodes } from '@xyflow/react'
import { useRef } from 'react'

import { resolveSourceContext, sameContext } from '@/app/_authed/(dashboard)/_extension-system/context-resolver'
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
  // resolved against the whole graph on every change. The previous context is
  // kept while the new one has the same content, so moving an unrelated node
  // does not hand consumers a new context object.
  const stable = useRef(ctx)
  if (!sameContext(stable.current, ctx)) {
    stable.current = ctx
  }
  return stable.current as ResolvedContext<V> | null
}
