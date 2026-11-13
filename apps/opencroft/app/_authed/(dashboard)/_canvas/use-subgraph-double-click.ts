// A double click on a subgraph's card opens it, as the node menu's Open does.
// On touch a subgraph opens from the menu only (long press, then Open), so a
// double tap never changes the level.

import type { Node, NodeMouseHandler } from '@xyflow/react'
import { useCallback, useEffect, useRef } from 'react'

import { isSubgraph } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'

/**
 * The `onNodeDoubleClick` handler of the canvas in `canvas`: a double click
 * with a mouse or a pen on a subgraph's card calls `open` with its id. Any
 * other node, and a double tap, does nothing here. A pin's own double click
 * (it disconnects the pin) stops before it reaches the node, so it never opens.
 */
export function useSubgraphDoubleClick({
  canvas,
  open,
}: {
  canvas: HTMLElement | null
  open: (subgraphId: string) => void
}): NodeMouseHandler {
  // `dblclick` is a MouseEvent with no pointer type, so the type is taken
  // from the pointerdown that started the gesture.
  const pointerType = useRef('mouse')

  useEffect(() => {
    if (!canvas) {
      return
    }
    const onDown = (event: PointerEvent) => {
      pointerType.current = event.pointerType
    }
    canvas.addEventListener('pointerdown', onDown, true)
    return () => canvas.removeEventListener('pointerdown', onDown, true)
  }, [canvas])

  return useCallback(
    (_event, node: Node) => {
      if (pointerType.current !== 'touch' && isSubgraph(node)) {
        open(node.id)
      }
    },
    [open],
  )
}
