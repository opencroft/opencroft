/**
 * How far React Flow lifts a selected node above the rest: `SELECTED_NODE_Z`
 * in `@xyflow/system`, which does not export it. `frame-stacking.test.ts`
 * reads the stacking order React Flow computes, so it fails if the lift
 * changes.
 */
const SELECTED_NODE_LIFT = 1000

/**
 * The stacking order of a top-level frame on the canvas. A frame one level
 * deeper stacks one higher, so a nested frame draws above the frame it is in;
 * every frame stays below 0, where every other node stacks. React Flow stacks
 * a child at its own order, or one above its parent's when that is not
 * higher, so a node inside a frame keeps 0.
 */
const TOP_FRAME_Z = -100

interface Stackable {
  zIndex?: number
  selected?: boolean
}

/** The stacking order of a frame `depth` levels deep: 0 at the top level. Never 0 or above. */
export function frameZ(depth: number): number {
  return Math.min(TOP_FRAME_Z + depth, -1)
}

/**
 * `node`, a frame `depth` levels deep, as the canvas hands it to React Flow:
 * above the frames it is in and below every other node, whether or not it is
 * selected. React Flow draws a selected node above the others, which would
 * put a selected frame, and its resize handles, over the nodes it holds; the
 * frame's z-index is lowered by that lift so it stays where it is. The node
 * is returned as is when it already stacks there.
 */
export function stackedFrame<T extends Stackable>(node: T, depth = 0): T {
  const zIndex = frameZ(depth) - (node.selected ? SELECTED_NODE_LIFT : 0)
  return node.zIndex === zIndex ? node : { ...node, zIndex }
}
