// How a finger moves and resizes nodes: only while the canvas's move-nodes
// toggle is on, by title bars and resize handles sized for a fingertip.

import { type Node, type ReactFlowState, useNodeId, useStore } from '@xyflow/react'
import { createContext, useContext, useLayoutEffect, useRef, useSyncExternalStore } from 'react'

import { cutOutOver, keepCutOut } from '@/app/_authed/(dashboard)/_canvas/control-cutouts'

/**
 * The smallest touch target, in screen pixels: 44pt is the iOS minimum
 * (Android's 48dp is a little more).
 */
export const TOUCH_TARGET_PX = 44

function settledNodes(state: ReactFlowState): Node[] | null {
  return state.nodes.some((node) => node.dragging || node.resizing) ? null : state.nodes
}

/**
 * The canvas's nodes, for an effect that measures what lies around a touch
 * target (see `keepCutOut`); null while a node is being dragged or resized,
 * so that the effect waits for the gesture to end rather than measuring each
 * of its frames, and runs again when it has.
 */
export function useSettledNodes(): Node[] | null {
  return useStore(settledNodes)
}

const COARSE_POINTER = '(pointer: coarse)'

function subscribeCoarsePointer(onChange: () => void): () => void {
  const query = window.matchMedia?.(COARSE_POINTER)
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

function coarsePointer(): boolean {
  return window.matchMedia?.(COARSE_POINTER).matches === true
}

/**
 * Whether the canvas's move-nodes toggle is on; null on a canvas that has no
 * such toggle (the desktop layout).
 */
export const MoveModeContext = createContext<boolean | null>(null)

/**
 * Whether the canvas's move mode is on, where nodes follow the touch rules:
 * under a coarse pointer, on a canvas that has the toggle. Null where they
 * don't apply, and nodes are dragged and resized as with a mouse.
 */
export function useTouchMoveMode(): boolean | null {
  const moveMode = useContext(MoveModeContext)
  const coarse = useSyncExternalStore(subscribeCoarsePointer, coarsePointer, () => false)
  return coarse ? moveMode : null
}

/**
 * The area a finger drags a node by, for its title bar: put it in a
 * `relative isolate` bar that stacks above the node's content (the `dragArea`
 * slot of the kit's node header is one). While move mode is on, it is as tall
 * as the bar, or `TOUCH_TARGET_PX` on screen when that is taller, which the
 * bar is not below zoom 1, and centred on the bar, so it reaches as far above
 * the bar as into the content below it. It is drawn behind the bar's content,
 * so the bar's buttons keep their taps, and it has a hole over each control it
 * covers, in the node's content or in a neighbour it reaches over (see
 * `cutOutOver`), so those keep theirs too. The holes are measured again when
 * the nodes, the zoom or the node's size change, and on what `keepCutOut`
 * watches; a control that moves with none of these keeps its old hole until
 * the next. Otherwise it draws nothing.
 */
export function NodeDragArea() {
  return useTouchMoveMode() ? <TouchDragArea /> : null
}

// Its own component, so that only a node in move mode re-renders as the canvas zooms.
function TouchDragArea() {
  const zoom = useStore((state) => state.transform[2])
  const id = useNodeId()
  const size = useStore((state) => {
    const node = id ? state.nodeLookup.get(id) : undefined
    return node ? `${node.measured.width}x${node.measured.height}` : ''
  })
  const nodes = useSettledNodes()
  const ref = useRef<HTMLDivElement>(null)
  // What the area covers moves with its height (the zoom), the node's size
  // and the nodes around it; panning moves the area and the controls alike.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoom, size and nodes move what the area covers, which the cut reads from the page.
  useLayoutEffect(() => {
    const area = ref.current
    const flow = area?.closest('.react-flow')
    if (!area || !flow || !nodes) {
      return
    }
    return keepCutOut(flow, () => cutOutOver(flow, [area]))
  }, [zoom, size, nodes])
  return (
    <div
      ref={ref}
      aria-hidden
      className='absolute inset-x-0 top-1/2 -z-10 -translate-y-1/2'
      style={{ height: `max(100%, ${TOUCH_TARGET_PX / zoom}px)` }}
    />
  )
}
