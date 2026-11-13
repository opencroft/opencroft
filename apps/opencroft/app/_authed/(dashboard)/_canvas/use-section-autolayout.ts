// Keeps every autolayout Section laid out (section-autolayout.ts) on the
// canvas of the graph's layout writer, the one tab that writes it for every
// viewer (see LiveGraph.isLayoutWriter). Other tabs receive the result.

import type { Edge, Node } from '@xyflow/react'
import { useEffect } from 'react'

import type { WriteOptions } from '@/app/_authed/(dashboard)/_canvas/live-graph'
import { autolayoutSections } from '@/app/_authed/(dashboard)/_canvas/section-autolayout'
import { isAutolayoutSection } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'

/**
 * How long the nodes stay unchanged before a layout pass: a card that grows
 * over a few frames, or a burst of remote changes, is laid out once.
 */
export const AUTOLAYOUT_SETTLE_MS = 300

/**
 * Lays out the autolayout sections once the nodes have settled for
 * `AUTOLAYOUT_SETTLE_MS`, while this tab is the layout writer. A pass waits
 * while a node is dragged or resized, so the layout never pulls a node from
 * under the pointer; the drop or release is a change, and the pass follows
 * it. A pass that changes something is written untracked: undo is for what
 * the person did.
 */
export function useSectionAutolayout({
  nodes,
  edges,
  setNodes,
  requestWrite,
  layoutWriter,
}: {
  nodes: Node[]
  edges: Edge[]
  setNodes: (update: (nodes: Node[]) => Node[]) => void
  requestWrite: (options?: WriteOptions) => void
  layoutWriter: boolean
}): void {
  useEffect(() => {
    if (!layoutWriter || !nodes.some(isAutolayoutSection) || nodes.some((n) => n.dragging || n.resizing)) {
      return
    }
    const timer = setTimeout(() => {
      setNodes((current) => {
        const next = autolayoutSections(current, edges)
        if (next !== current) {
          requestWrite({ untracked: true })
        }
        return next
      })
    }, AUTOLAYOUT_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [nodes, edges, setNodes, requestWrite, layoutWriter])
}
