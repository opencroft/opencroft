'use client'

import { type Edge, type Node, useEdges, useNodes } from '@xyflow/react'
import { createContext, useContext } from 'react'

import { wiredEdges } from '@/app/_authed/(extension-runtime)/_wired-edges'

/** A graph as it is stored: its nodes with their parents, its edges between them. */
export interface CanvasGraph {
  nodes: Node[]
  edges: Edge[]
}

/**
 * The open canvas's graph as it is stored. React Flow is handed the open
 * level's view of it (see `subgraph-level.ts`): a subgraph's members without
 * their parent, and edges to its ports drawn to boundary nodes. Whatever
 * reads wiring or frames reads this instead, so it sees the same graph the
 * server does on every level.
 */
export const CanvasGraphContext = createContext<CanvasGraph | null>(null)

/** The open canvas's stored graph; React Flow's own nodes and edges where no canvas provides it. */
export function useCanvasGraph(): CanvasGraph {
  const provided = useContext(CanvasGraphContext)
  const nodes = useNodes()
  const edges = useEdges()
  return provided ?? { nodes, edges }
}

/** Extensions' `useGraphNodes`: the stored nodes of every level, each with its parent (see `useCanvasGraph`). */
export function useGraphNodes(): Node[] {
  return useCanvasGraph().nodes
}

/**
 * Extensions' `useGraphEdges`: the edges as wired, a chain through subgraph
 * ports read as one edge from its source to its target (see `wiredEdges`), as
 * the server's `listEdges` gives them.
 */
export function useGraphEdges(): Edge[] {
  return wiredEdges(useCanvasGraph())
}
