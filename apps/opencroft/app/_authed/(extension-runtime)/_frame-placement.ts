// Placing nodes by absolute position, for agents and extensions: they read and
// write where a node is drawn, and the tree (see `_frame-tree.ts`) is kept
// here. A position given without a parent places the node by the corner rule,
// on the level the node is on; a frame given with it must hold its corner; a
// parent given alone takes the node in below its members. A subgraph named as
// the parent takes the node onto its own canvas, the position given on that
// canvas. A frame grows to hold what is placed in it.
//
// Safe for both server and client — no runtime imports.

import { isSubgraph } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import {
  absolutePositions,
  ancestors,
  byIdOf,
  descendants,
  dropTarget,
  frameHoldsPoint,
  frameSize,
  growToHold,
  type IsFrame,
  minimumFrameSize,
  type Point,
  roomOf,
  type TreeNode,
} from '@/app/_authed/(extension-runtime)/_frame-tree'
import { FRAME_PADDING, FRAME_TITLE_PADDING, type NodeSize } from '@/app/_authed/(extension-runtime)/_frames'
import { ceilToGrid, GRID_STEP, ownSize, withSize } from '@/app/_authed/(extension-runtime)/_grid'

/** One node's place as a write gives it. */
export interface PlacementRequest {
  id: string
  /** Where its top-left corner is drawn: absolute. */
  position?: Point
  /** The frame it goes into, `null` for the top level; left out, the corner rule decides when `position` is given. */
  parentId?: string | null
  /** Its new size; for a frame, its new area. */
  size?: NodeSize
}

export type PlacementResult<N> = { nodes: N[] } | { refused: string }

function describeBox(at: Point, frame: TreeNode): string {
  const { width, height } = frameSize(frame)
  return `x ${at.x} to ${at.x + width}, y ${at.y} to ${at.y + height}`
}

function samePoint(a: Point | undefined, b: Point | undefined): boolean {
  return !!a && !!b && a.x === b.x && a.y === b.y
}

/**
 * `requests` without the places that leave a node where it is: a position
 * equal to where the node is drawn, given with no parent or with the one it
 * has, while none of its ancestors is given a position in the same call. So
 * writing back what a read returned moves no node out of its frame. A size or
 * a new parent in such a request stays.
 */
export function withoutStandingPlaces<N extends TreeNode>(
  nodes: readonly N[],
  requests: readonly PlacementRequest[],
): PlacementRequest[] {
  const byId = byIdOf(nodes)
  const drawn = absolutePositions(nodes)
  const moving = new Set(requests.filter((r) => r.position).map((r) => r.id))
  return requests.map((r) => {
    const node = byId.get(r.id)
    if (
      !node ||
      !samePoint(r.position, drawn.get(r.id)) ||
      (r.parentId !== undefined && (r.parentId ?? undefined) !== node.parentId) ||
      ancestors(r.id, byId).some((a) => moving.has(a.id))
    ) {
      return r
    }
    const { position: _position, parentId: _parentId, ...rest } = r
    return rest
  })
}

/**
 * `nodes` with every request applied, positions stored relative to each
 * node's parent. Within one call every given position is final and absolute
 * on its level, and a node not given one follows its parent: a frame moved
 * carries its members, and a frame and its members moved together land where
 * each was put. Then every frame grows to hold the nodes placed or sized in
 * it, up the chain (`growToHold`; never a frame `fitsItself` says fits
 * itself). Refused, with nothing applied, when a parent given is neither a
 * frame nor a subgraph, is the node or lies inside it, or is a frame that
 * does not hold the position given with it, and when a frame is given a size,
 * other than the one it has, smaller than its members need
 * (`minimumFrameSize`).
 */
export function placeAbsolute<N extends TreeNode>(
  nodes: readonly N[],
  requests: readonly PlacementRequest[],
  isFrame: IsFrame<N>,
  fitsItself?: (frame: N) => boolean,
): PlacementResult<N> {
  const sizes = new Map(requests.flatMap((r) => (r.size ? [[r.id, r.size] as const] : [])))
  let work = nodes.map((n) => {
    const size = sizes.get(n.id)
    return size ? withSize(n, size) : n
  })
  const byId = () => byIdOf(work)
  const given = new Map<string, Point>()
  for (const r of requests) {
    if (r.position) {
      given.set(r.id, r.position)
    }
  }
  // Where everything ends up drawn on its level: a given position, else its
  // parent's place plus its own; a subgraph's members are on its own canvas.
  const finalPositions = (): Map<string, Point> => {
    const lookup = byId()
    const out = new Map<string, Point>()
    const resolve = (node: N, chain: Set<string>): Point => {
      const known = out.get(node.id)
      if (known) {
        return known
      }
      const own = node.position ?? { x: 0, y: 0 }
      let at = given.get(node.id) ?? own
      const parent = node.parentId ? lookup.get(node.parentId) : undefined
      if (!given.has(node.id) && parent && !isSubgraph(parent) && !chain.has(parent.id)) {
        chain.add(node.id)
        const base = resolve(parent, chain)
        at = { x: base.x + own.x, y: base.y + own.y }
      }
      out.set(node.id, at)
      return at
    }
    for (const node of work) {
      resolve(node, new Set())
    }
    return out
  }
  const setParent = (id: string, parentId: string | undefined) => {
    work = work.map((n) => {
      if (n.id !== id) {
        return n
      }
      const { parentId: _old, ...rest } = n
      return (parentId ? { ...rest, parentId } : rest) as N
    })
  }

  // A parent named: checked, and the node placed in it.
  for (const r of requests) {
    if (r.parentId === undefined) {
      continue
    }
    if (r.parentId === null) {
      // Taken out where it is drawn, or put where it is given.
      given.set(r.id, given.get(r.id) ?? (finalPositions().get(r.id) as Point))
      setParent(r.id, undefined)
      continue
    }
    const frame = byId().get(r.parentId)
    if (!frame) {
      return { refused: `parentId ${r.parentId} of ${r.id}: no such node on this graph` }
    }
    const subgraph = isSubgraph(frame)
    if (!isFrame(frame) && !subgraph) {
      return {
        refused: `parentId ${r.parentId} of ${r.id}: not a frame (a node such as a Section that holds others) or a subgraph`,
      }
    }
    if (frame.id === r.id || descendants(r.id, work).has(frame.id)) {
      return { refused: `parentId ${r.parentId} of ${r.id}: a node cannot go into itself or a frame inside it` }
    }
    const at = finalPositions()
    // A subgraph's members are placed on its own canvas, whose origin is its corner.
    const frameAt = subgraph ? { x: 0, y: 0 } : (at.get(frame.id) as Point)
    if (r.position) {
      if (!subgraph && !frameHoldsPoint(frame, frameAt, r.position)) {
        return {
          refused: `position (${r.position.x}, ${r.position.y}) of ${r.id} lies outside frame ${frame.id}, whose area is ${describeBox(frameAt, frame)}`,
        }
      }
      setParent(r.id, frame.id)
      continue
    }
    // Below the frame's lowest member; the frame grows to hold it below.
    const members = work.filter((n) => n.parentId === frame.id && n.id !== r.id)
    const bottom = Math.max(...members.map((m) => (at.get(m.id) as Point).y - frameAt.y + roomOf(m).height))
    const slot = {
      x: FRAME_PADDING,
      y: members.length > 0 ? ceilToGrid(bottom) + GRID_STEP : FRAME_TITLE_PADDING,
    }
    given.set(r.id, { x: frameAt.x + slot.x, y: frameAt.y + slot.y })
    setParent(r.id, frame.id)
  }

  // A position alone: the corner rule, at the places everything ends up. Frames
  // smallest first, so two frames put over each other nest.
  const area = (n: N) => (isFrame(n) ? frameSize(n).width * frameSize(n).height : Number.POSITIVE_INFINITY)
  const dropped = requests
    .filter((r) => r.parentId === undefined && r.position)
    .map((r) => byId().get(r.id) as N)
    .sort((p, q) => area(p) - area(q))
  for (const node of dropped) {
    const at = finalPositions()
    setParent(node.id, dropTarget(work, node.id, at.get(node.id) as Point, isFrame, at))
  }

  const at = finalPositions()
  const lookup = byId()
  const result = work.map((n) => {
    const own = at.get(n.id) as Point
    const base = n.parentId && !isSubgraph(lookup.get(n.parentId)) ? at.get(n.parentId) : undefined
    const position = base ? { x: own.x - base.x, y: own.y - base.y } : own
    return n.position && n.position.x === position.x && n.position.y === position.y ? n : { ...n, position }
  })

  const before = byIdOf(nodes)
  for (const [id, size] of sizes) {
    const was = before.get(id)
    const own = was ? ownSize(was) : {}
    const needed = minimumFrameSize(result, id)
    if (!needed || (own.width === size.width && own.height === size.height)) {
      continue
    }
    if (size.width < needed.width || size.height < needed.height) {
      return {
        refused: `size ${size.width} × ${size.height} of ${id} is too small for the nodes inside it: it needs at least ${Math.max(size.width, needed.width)} × ${Math.max(size.height, needed.height)}. Make it larger, or move those nodes first.`,
      }
    }
  }
  const held = requests.filter((r) => r.position || r.parentId !== undefined || r.size).map((r) => r.id)
  return { nodes: growToHold(result, held, fitsItself) }
}
