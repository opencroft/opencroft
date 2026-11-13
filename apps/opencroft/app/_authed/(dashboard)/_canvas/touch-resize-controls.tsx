import {
  type ControlPosition,
  NodeResizeControl,
  type ReactFlowState,
  type ResizeControlProps,
  ResizeControlVariant,
  useNodeId,
  useStore,
  ViewportPortal,
} from '@xyflow/react'
import { getNodeDimensions } from '@xyflow/system'
import { type CSSProperties, useLayoutEffect, useRef } from 'react'

import { cutOutOver, keepCutOut } from '@/app/_authed/(dashboard)/_canvas/control-cutouts'
import { TOUCH_TARGET_PX, useSettledNodes } from '@/app/_authed/(dashboard)/_canvas/touch-move-mode'
import type { NodeSize } from '@/app/_authed/(extension-runtime)/_frames'

/**
 * The middle of each edge, then the four corners. A later handle is drawn
 * above an earlier one, so where a corner's handle and an edge's overlap (on a
 * node small on screen) the corner takes the touch.
 */
const TOUCH_RESIZE_POSITIONS: ControlPosition[] = [
  'top',
  'right',
  'bottom',
  'left',
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
]

/**
 * A handle: a square centred on the node's corner or edge midpoint, half of
 * it over the node and half outside, so that a finger reaches it from either
 * side. React Flow scales a handle about its transform origin, which is its
 * centre, so the square stays centred at any zoom.
 */
const HANDLE_STYLE: CSSProperties = {
  width: TOUCH_TARGET_PX,
  height: TOUCH_TARGET_PX,
  translate: '-50% -50%',
  transformOrigin: '50% 50%',
  background: 'transparent',
  border: 'none',
  borderRadius: 0,
  pointerEvents: 'all',
}

interface HandleBox {
  x: number
  y: number
  width: number
  height: number
  zIndex: number
}

/**
 * The box node `id` is drawn in on the canvas, with a stacking order above
 * every node's; null while the node isn't there.
 */
function handleBox(state: ReactFlowState, id: string | null): HandleBox | null {
  const node = id ? state.nodeLookup.get(id) : undefined
  if (!node) {
    return null
  }
  let top = 0
  for (const other of state.nodeLookup.values()) {
    top = Math.max(top, other.internals.z)
  }
  return { ...node.internals.positionAbsolute, ...getNodeDimensions(node), zIndex: top + 1 }
}

function sameBox(a: HandleBox | null, b: HandleBox | null): boolean {
  return (
    a === b ||
    (!!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.zIndex === b.zIndex)
  )
}

// No `color`: on a handle it fills the whole hit area. No `autoScale`: the scale is what holds the hit area's size.
type TouchResizeControlsProps = Omit<
  ResizeControlProps,
  'position' | 'variant' | 'minWidth' | 'minHeight' | 'autoScale' | 'color'
> & {
  /** The smallest size the handle at each position resizes the node to. */
  limits: (position: ControlPosition) => Partial<NodeSize>
}

/**
 * A node's resize handles for a finger, at its corners and the middle of its
 * edges. A corner moves the two edges it joins, an edge's handle that edge.
 * Each handle's hit area is `TOUCH_TARGET_PX` square on screen at any zoom:
 * React Flow scales a handle by 1/zoom below zoom 1, and the canvas zooms in
 * no further than 1 (`maxZoom`; a larger one would shrink the handles). The
 * dot drawn on the corner or edge is smaller.
 *
 * The hit areas are drawn in the canvas's viewport, above every node, so that
 * no other node covers them: a node inside a frame stacks above the frame, and
 * its title bar's drag area can reach over the frame's edge. Each has a hole
 * over every control of a node it lies over (see `cutOutOver`), so a button
 * under a handle, such as a window's close at its top-right corner, keeps its
 * taps, a connection handle under it starts a wire, and the rest of the
 * handle still resizes. The holes are measured
 * again as a title bar's drag area's are (see `NodeDragArea`).
 */
export function TouchResizeControls({ limits, ...props }: TouchResizeControlsProps) {
  const contextId = useNodeId()
  const id = props.nodeId ?? contextId
  const box = useStore((state) => handleBox(state, id), sameBox)
  const zoom = useStore((state) => state.transform[2])
  const nodes = useSettledNodes()
  const ref = useRef<HTMLDivElement>(null)
  // What the handles lie over moves with the node's box, the zoom (a handle's
  // size on the canvas) and the nodes around it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: box, zoom and nodes move what the handles lie over, which the cut reads from the page.
  useLayoutEffect(() => {
    const handles = ref.current?.querySelectorAll<HTMLElement>('.react-flow__resize-control')
    const flow = ref.current?.closest('.react-flow')
    if (!handles || !flow || !nodes) {
      return
    }
    return keepCutOut(flow, () => cutOutOver(flow, handles))
  }, [box, zoom, nodes])
  if (!box) {
    return null
  }
  return (
    <ViewportPortal>
      <div
        ref={ref}
        data-touch-resize={id}
        className='pointer-events-none absolute top-0 left-0'
        style={{
          transform: `translate(${box.x}px,${box.y}px)`,
          width: box.width,
          height: box.height,
          zIndex: box.zIndex,
        }}
      >
        {TOUCH_RESIZE_POSITIONS.map((position) => {
          const { width, height } = limits(position)
          return (
            <NodeResizeControl
              {...props}
              key={position}
              nodeId={id ?? undefined}
              position={position}
              variant={ResizeControlVariant.Handle}
              style={HANDLE_STYLE}
              minWidth={width}
              minHeight={height}
            >
              <span className='pointer-events-none absolute top-1/2 left-1/2 size-3 -translate-1/2 rounded-full border-2 border-primary bg-background shadow-sm' />
            </NodeResizeControl>
          )
        })}
      </div>
    </ViewportPortal>
  )
}
