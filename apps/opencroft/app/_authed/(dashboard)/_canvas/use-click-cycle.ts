// Wires click cycling (click-cycle.ts) into a React Flow canvas: the handler
// for its `onNodeClick`, and the pointer watch that ends a cycle once the
// pointer leaves the spot.

import { type Node, type NodeMouseHandler, useReactFlow, useStoreApi } from '@xyflow/react'
import { getNodeDimensions } from '@xyflow/system'
import { useCallback, useEffect, useRef } from 'react'

import {
  type Cycle,
  clickCycle,
  isPlainClick,
  movedAway,
  type StackedBox,
  selectsText,
  slopFor,
  stackAt,
} from '@/app/_authed/(dashboard)/_canvas/click-cycle'
import { byIdOf, depthOf } from '@/app/_authed/(extension-runtime)/_frame-tree'

/**
 * The `onNodeClick` handler of the canvas in `canvas`: a repeated click on the
 * same spot selects the next node down the stack under it, through `select`.
 * React Flow selects the node clicked before this runs; `select` replaces
 * that selection in the same event, so only the cycled node is ever drawn
 * selected. `isFrame` must be a stable function.
 */
export function useClickCycle({
  canvas,
  select,
  isFrame,
}: {
  canvas: HTMLElement | null
  select: (nodeId: string) => void
  isFrame: (node: Node) => boolean
}): NodeMouseHandler {
  const store = useStoreApi()
  const { screenToFlowPosition } = useReactFlow()
  const cycle = useRef<Cycle | null>(null)
  const pointerType = useRef('mouse')

  useEffect(() => {
    if (!canvas) {
      return
    }
    const onDown = (event: PointerEvent) => {
      pointerType.current = event.pointerType
    }
    const onMove = (event: PointerEvent) => {
      if (cycle.current && movedAway(cycle.current, event.clientX, event.clientY)) {
        cycle.current = null
      }
    }
    canvas.addEventListener('pointerdown', onDown, true)
    canvas.addEventListener('pointermove', onMove, true)
    return () => {
      canvas.removeEventListener('pointerdown', onDown, true)
      canvas.removeEventListener('pointermove', onMove, true)
    }
  }, [canvas])

  return useCallback(
    (event, node) => {
      const { nodes, nodeLookup } = store.getState()
      const stackUnder = () => {
        const byId = byIdOf(nodes)
        const boxes: StackedBox[] = []
        for (const n of nodes) {
          const internal = nodeLookup.get(n.id)
          if (!internal || n.hidden) {
            continue
          }
          const { x, y } = internal.internals.positionAbsolute
          boxes.push({
            id: n.id,
            x,
            y,
            ...getNodeDimensions(internal),
            frame: isFrame(n),
            depth: depthOf(n.id, byId),
            zIndex: n.zIndex ?? 0,
          })
        }
        return stackAt(boxes, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
      }
      const next = clickCycle(
        cycle.current,
        {
          x: event.clientX,
          y: event.clientY,
          slop: slopFor(pointerType.current),
          nodeId: node.id,
          plain: isPlainClick(event, event.currentTarget),
          selectsText: selectsText(event, event.currentTarget),
          selectedIds: nodes.filter((n) => n.selected).map((n) => n.id),
        },
        stackUnder,
      )
      cycle.current = next.cycle
      if (next.select) {
        select(next.select)
      }
    },
    [store, screenToFlowPosition, select, isFrame],
  )
}
