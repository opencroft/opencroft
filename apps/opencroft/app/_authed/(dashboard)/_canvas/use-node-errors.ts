'use client'

import type { NodeErrorEntry } from '@opencroft/core'
import { useMemo } from 'react'

import { useCanvasGraph } from '@/app/_authed/(extension-runtime)/_client/canvas-graph'
import type { NodeErrorEdge } from '@/app/_authed/(extension-runtime)/_client/host'
import { extensionRegistry } from '@/app/_authed/(extension-runtime)/_client/registry'
import { readNodeErrors, withDerivedErrors } from '@/app/_authed/(extension-runtime)/_node-errors'
import { wiredEdges } from '@/app/_authed/(extension-runtime)/_wired-edges'

/** A node's errors: those stored on it, then those its type derives from its data and wiring. */
function nodeErrors(
  node: { id: string; type?: string; data?: Record<string, unknown> },
  edges: readonly NodeErrorEdge[],
): NodeErrorEntry[] {
  const stored = readNodeErrors(node.data)
  const derive = node.type ? extensionRegistry.resolveNode(node.type)?.errors : undefined
  if (!derive) {
    return stored
  }
  let derived: unknown[]
  try {
    derived = derive({ id: node.id, data: node.data ?? {} }, edges)
  } catch (err) {
    // An extension's check that throws says nothing about the node; the card
    // must still draw.
    console.error(`[node-errors] ${node.type} errors() threw for node ${node.id}:`, err)
    return stored
  }
  return withDerivedErrors(stored, Array.isArray(derived) ? derived : [])
}

/**
 * The errors of a node on the open canvas, what its card's indicator and its
 * inspector's Errors tab both show. Mount inside the canvas's ReactFlow
 * provider; `node` null reads as no errors.
 */
export function useNodeErrors(
  node: { id: string; type?: string; data?: Record<string, unknown> } | null,
): NodeErrorEntry[] {
  // As wiring reads them: through a subgraph's ports, to the real ends.
  const edges = wiredEdges(useCanvasGraph())
  const id = node?.id
  const type = node?.type
  const data = node?.data
  return useMemo(() => (id ? nodeErrors({ id, type, data }, edges) : []), [id, type, data, edges])
}
