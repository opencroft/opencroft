// A node moved by dragging its row in the Outline. The move is a reparent,
// the same write as an agent's `parentId` with no position: the node goes in
// below the new frame's members, or out to the top level where it is drawn,
// and the frames around it grow to hold it (`placeAbsolute`).
//
// The Outline lists siblings in drawn order, containers first, so where a row
// is dropped among its siblings means nothing to a plain frame, and only its
// parent changes. A row drops beside rows of its own kind only, so in each
// group the drawn order is the listed order.
// An autolayout section lays its members out from where they stand, so there
// the drop sets the place: the node is put between the row it was dropped
// beside and that row's neighbour on the same side, and the layout reads it
// in that slot.

import type { GraphOutlineDrop } from 'ui/nodes/graph-outline'

import { drawnOrder } from '@/app/_authed/(dashboard)/_canvas/outline-tree'
import { isSubgraph } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import {
  type PlacementRequest,
  type PlacementResult,
  placeAbsolute,
} from '@/app/_authed/(extension-runtime)/_frame-placement'
import {
  absolutePositions,
  byIdOf,
  frameSize,
  type IsFrame,
  levelOf,
  type Point,
  type TreeNode,
} from '@/app/_authed/(extension-runtime)/_frame-tree'

/**
 * Where in an autolayout section a node dropped beside `besideId` stands so
 * the layout reads it on that side: halfway to the sibling beyond it, or one
 * step past `besideId` when there is none. Kept inside the section, which
 * must hold the corner of a node placed in it; the layout fits it after.
 */
function slotBeside<N extends TreeNode>(
  nodes: readonly N[],
  movedId: string,
  section: N,
  besideId: string,
  side: 'before' | 'after',
): Point | null {
  const siblings = nodes.filter((n) => n.parentId === section.id && n.id !== movedId).sort(drawnOrder)
  const at = siblings.findIndex((n) => n.id === besideId)
  if (at < 0) {
    return null
  }
  const abs = absolutePositions(nodes)
  const pos = (n: N) => abs.get(n.id) as Point
  const beside = pos(siblings[at])
  const beyond = siblings[side === 'before' ? at - 1 : at + 1]
  const behind = siblings[side === 'before' ? at + 1 : at - 1]
  const step = side === 'before' ? -1 : 1
  const slot = beyond
    ? { x: Math.round((beside.x + pos(beyond).x) / 2), y: Math.round((beside.y + pos(beyond).y) / 2) }
    : behind
      ? { x: 2 * beside.x - pos(behind).x, y: 2 * beside.y - pos(behind).y }
      : { x: beside.x + step, y: beside.y + step }
  const corner = pos(section)
  const { width, height } = frameSize(section)
  return {
    x: Math.min(Math.max(slot.x, corner.x), corner.x + width - 1),
    y: Math.min(Math.max(slot.y, corner.y), corner.y + height - 1),
  }
}

/**
 * Why the Outline refuses a drop that would take a node into or out of a
 * subgraph. Across levels a node's edges cannot stay (`normaliseSubgraphs`
 * drops them) and its position belongs to another canvas, so the Outline
 * keeps every node on its level: its rows offer no such drop, and this is
 * the write's own guard.
 */
export const OUTLINE_KEEPS_LEVEL = 'A node moves into or out of a subgraph by cut and paste.'

/**
 * `nodes` with `nodeId` moved as the Outline drop says, or null when the drop
 * changes nothing (a new place among the siblings of a plain frame). Refused
 * when the drop would change the node's level (`OUTLINE_KEEPS_LEVEL`), and as
 * `placeAbsolute` refuses: a parent that is no frame, or the node itself or a
 * frame inside it.
 */
export function moveFromOutline<N extends TreeNode>(
  nodes: readonly N[],
  nodeId: string,
  drop: GraphOutlineDrop,
  isFrame: IsFrame<N>,
  isAutolayout: (frame: N) => boolean,
): PlacementResult<N> | null {
  const byId = byIdOf(nodes)
  const node = byId.get(nodeId)
  if (!node) {
    return null
  }
  const parent = drop.parentId ? byId.get(drop.parentId) : undefined
  const parentLevel = parent && (isSubgraph(parent) ? parent.id : levelOf(parent.id, byId))
  if (parentLevel !== levelOf(nodeId, byId)) {
    return { refused: OUTLINE_KEEPS_LEVEL }
  }
  const slot =
    parent && drop.beside && isAutolayout(parent)
      ? slotBeside(nodes, nodeId, parent, drop.beside.id, drop.beside.side)
      : null
  if (!slot && (drop.parentId ?? undefined) === node.parentId) {
    return null
  }
  const request: PlacementRequest = slot
    ? { id: nodeId, parentId: drop.parentId, position: slot }
    : { id: nodeId, parentId: drop.parentId }
  return placeAbsolute(nodes, [request], isFrame, isAutolayout)
}
