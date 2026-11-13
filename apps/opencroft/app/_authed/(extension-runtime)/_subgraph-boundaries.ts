// Where a subgraph's Inputs and Outputs boundaries stand on its canvas. The
// canvas draws them (see `subgraph-level.ts`) and the graph keeps where they
// stand, in the subgraph's `inputsAt` and `outputsAt`. A boundary without a
// place is given one by the first write that sees it (`normaliseSubgraphs`),
// beside what the subgraph holds then, and keeps it until it is dragged:
// adding, moving or removing the nodes inside never moves it.
//
// Safe for both server and client — no runtime imports.

import {
  isSubgraph,
  type PortSide,
  type SubgraphData,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { type Point, roomOf, type TreeNode, UNSIZED_NODE } from '@/app/_authed/(extension-runtime)/_frame-tree'

/**
 * How far a boundary stands from the contents' bounding box when it is given
 * its place: a card at its widest (`NODE_CARD_MAX_WIDTH` in `ui`), so a card
 * fits between them.
 */
export const BOUNDARY_GAP = 240

/**
 * The width a boundary is counted as when it is placed: as drawn with no
 * ports, its rows' `min-w-56` plus the card's padding and border, rounded up
 * to the grid. A port name too long for that widens it into the gap.
 */
export const BOUNDARY_WIDTH = 260

const PLACE_KEY = { inputs: 'inputsAt', outputs: 'outputsAt' } as const

type BoundaryNode = TreeNode & { data?: unknown }

/**
 * Where the boundary on `side` of `subgraph` stands on its canvas: where it
 * was put, else `BOUNDARY_GAP` beside the subgraph's members in `nodes`,
 * Inputs left of them and Outputs right, level with the top one. With no
 * members they stand as they would around one unsized card. A boundary's size
 * is the canvas's alone, so Inputs counts as `BOUNDARY_WIDTH` wide here.
 */
export function boundaryAt(subgraph: BoundaryNode, side: PortSide, nodes: readonly TreeNode[]): Point {
  const placed = (subgraph.data as Partial<SubgraphData> | undefined)?.[PLACE_KEY[side]]
  if (placed) {
    return placed
  }
  const members = nodes.filter((n) => n.parentId === subgraph.id)
  if (members.length === 0) {
    return side === 'inputs' ? { x: 0, y: 0 } : { x: BOUNDARY_WIDTH + 2 * BOUNDARY_GAP + UNSIZED_NODE.width, y: 0 }
  }
  const boxes = members.map((m) => ({ x: 0, y: 0, ...m.position, ...roomOf(m) }))
  const top = Math.min(...boxes.map((b) => b.y))
  if (side === 'inputs') {
    return { x: Math.min(...boxes.map((b) => b.x)) - BOUNDARY_GAP - BOUNDARY_WIDTH, y: top }
  }
  return { x: Math.max(...boxes.map((b) => b.x + b.width)) + BOUNDARY_GAP, y: top }
}

/**
 * `nodes` with every subgraph's boundaries given the place `boundaryAt`
 * draws them at, where they have none. Returns `nodes` itself when every
 * boundary has one.
 */
export function withBoundariesPlaced<N extends BoundaryNode>(nodes: readonly N[]): readonly N[] {
  let next = nodes
  for (const subgraph of nodes) {
    if (!isSubgraph(subgraph)) {
      continue
    }
    const data = (subgraph.data ?? {}) as Partial<SubgraphData>
    if (data.inputsAt && data.outputsAt) {
      continue
    }
    const places = {
      inputsAt: boundaryAt(subgraph, 'inputs', nodes),
      outputsAt: boundaryAt(subgraph, 'outputs', nodes),
    }
    next = next.map((n) => (n.id === subgraph.id ? { ...n, data: { ...data, ...places } } : n))
  }
  return next
}
