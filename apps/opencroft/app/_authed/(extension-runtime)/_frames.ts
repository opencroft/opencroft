// Frames: nodes that hold other nodes, such as a Section or a Network. What a
// frame holds is a tree (see `_frame-tree.ts`): a node belongs to the frame it
// was placed in. This module has what a frame is on its own: its category,
// sizes, stacking and the area test the placement rules place nodes by.
//
// Safe for both server and client — no runtime imports.

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { GRID_STEP } from '@/app/_authed/(extension-runtime)/_grid'

/** The palette category whose nodes are frames: drawn behind the rest and resizable. */
export const FRAME_CATEGORY = 'Organization'

export interface NodeSize {
  width: number
  height: number
}

/** The smallest a frame is resized to, and the size taken for a frame with none stored. */
export const MIN_FRAME_SIZE: NodeSize = { width: 200, height: 160 }

/** The stacking order a frame is stored with: below every other node, which has none of its own and stacks at 0. */
export const FRAME_Z_INDEX = -1

/** The room a frame leaves between its members and its left, right and bottom edges. */
export const FRAME_PADDING = GRID_STEP

/** The room a frame leaves above its members, where it draws its icon and label. */
export const FRAME_TITLE_PADDING = 4 * GRID_STEP

/**
 * Whether a node type is a frame: one of the frames' palette category. A
 * subgraph is listed with them but holds its nodes on a canvas of its own,
 * not by area, so it is not one.
 */
export function isFrameType(nodeType: { type: string; category?: string }): boolean {
  return nodeType.category === FRAME_CATEGORY && nodeType.type !== SUBGRAPH_TYPE
}

/** The size a new frame is created with. */
export const NEW_FRAME_SIZE: NodeSize = { width: 400, height: 300 }

/** What a node gets when created, before anyone resizes it, by its type. */
export function newNodeLayout(nodeType: { type: string; category?: string } | undefined): {
  zIndex?: number
  style?: NodeSize
} {
  if (nodeType && isFrameType(nodeType)) {
    return { zIndex: FRAME_Z_INDEX, style: { ...NEW_FRAME_SIZE } }
  }
  if (nodeType?.category === 'Windows') {
    return { style: { width: 800, height: 480 } }
  }
  return {}
}

interface Placed {
  position?: { x: number; y: number }
  style?: { width?: unknown; height?: unknown }
}

/** Whether `frame`'s area holds `node`'s top-left corner, both placed in the same coordinates. */
export function frameHolds(frame: Placed, node: Placed): boolean {
  const width = typeof frame.style?.width === 'number' ? frame.style.width : MIN_FRAME_SIZE.width
  const height = typeof frame.style?.height === 'number' ? frame.style.height : MIN_FRAME_SIZE.height
  const fx = frame.position?.x ?? 0
  const fy = frame.position?.y ?? 0
  const nx = node.position?.x ?? 0
  const ny = node.position?.y ?? 0
  return nx >= fx && ny >= fy && nx < fx + width && ny < fy + height
}
