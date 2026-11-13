// The frame tree: which frame each node belongs to. A node may carry
// `parentId`, the id of the frame it was placed in, and its `position` is then
// relative to that frame's top-left corner, as React Flow draws a child; a
// top-level node's position is absolute. A node joins a frame only when it is
// placed (dropped, created, pasted, wrapped, or written by an agent); a frame
// that grows or moves never changes who belongs to it.
//
// Two rules place a node. A drag on the canvas places by the pointer: what was
// dragged goes into the frame under the pointer at release (`dropAtPoint`).
// A writer without a pointer places by the corner: a node goes into the frame
// that holds its top-left corner (`dropTarget`). Either way a frame holds its
// members whole: a placement that puts a member past a frame's edge grows the
// frame (`growToHold`).
//
// A subgraph (see `subgraph-shared.ts`) holds nodes too, but as a canvas of its
// own: a level. A node's level is the nearest subgraph among its ancestors
// (`levelOf`), none for the top level. Positions add up the parent chain and
// stop at a subgraph, so a node inside one is placed on that subgraph's canvas,
// its origin the subgraph's own. The placement rules look only at the frames
// on the placed node's level, and on an inner level the place that is no frame
// is the subgraph itself. Nothing is dropped into a subgraph by area: it is not
// a frame.
//
// The canvas, the graph actions, the extension host and the stored graph's
// conversion all work through this module, so they agree on the tree.
//
// Safe for both server and client — no runtime imports.

import { isSubgraph } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import {
  FRAME_PADDING,
  FRAME_TITLE_PADDING,
  frameHolds,
  MIN_FRAME_SIZE,
  type NodeSize,
} from '@/app/_authed/(extension-runtime)/_frames'
import { ceilToGrid, drawnSize, floorToGrid, ownSize, withSize } from '@/app/_authed/(extension-runtime)/_grid'

export interface Point {
  x: number
  y: number
}

/** A node as the tree reads it. */
export interface TreeNode {
  id: string
  type?: string
  parentId?: string
  position?: Point
  width?: number
  height?: number
  style?: object
  measured?: { width?: number; height?: number }
}

/** Whether a node is a frame: one of the `Organization` palette category, which the caller knows by type. */
export type IsFrame<N> = (node: N) => boolean

const ORIGIN: Point = { x: 0, y: 0 }

export function byIdOf<N extends TreeNode>(nodes: readonly N[]): Map<string, N> {
  return new Map(nodes.map((n) => [n.id, n]))
}

/** The size a frame's area is: its own, else the smallest a frame is. */
export function frameSize(frame: TreeNode): NodeSize {
  const own = ownSize(frame)
  return { width: own.width ?? MIN_FRAME_SIZE.width, height: own.height ?? MIN_FRAME_SIZE.height }
}

/**
 * The room a node takes when its size is not known. Only the canvas measures a
 * card, per tab, so the stored graph a write sees carries no size for one.
 * The width is a card's narrowest (`NODE_CARD_MIN_WIDTH` in `ui`); the height
 * leaves room for a card with a few lines in it.
 */
export const UNSIZED_NODE: NodeSize = { width: 200, height: 140 }

/** The room `node` takes: as drawn, and `UNSIZED_NODE` on an axis that is not known. */
export function roomOf(node: TreeNode): NodeSize {
  const drawn = drawnSize(node)
  return { width: drawn.width || UNSIZED_NODE.width, height: drawn.height || UNSIZED_NODE.height }
}

/** Whether `frame`, its top-left corner at `frameAt`, holds `point`; both in the same coordinates. */
export function frameHoldsPoint(frame: TreeNode, frameAt: Point, point: Point): boolean {
  return frameHolds({ position: frameAt, style: frameSize(frame) }, { position: point })
}

/**
 * Where `node` is drawn on its level's canvas: its position plus every
 * ancestor's up to the nearest subgraph, whose canvas has its origin at the
 * subgraph's own corner. A parent missing from `byId`, or a loop of parents,
 * ends the walk.
 */
export function absolutePosition<N extends TreeNode>(node: N, byId: ReadonlyMap<string, N>): Point {
  const seen = new Set([node.id])
  let { x, y } = node.position ?? ORIGIN
  let parent = node.parentId ? byId.get(node.parentId) : undefined
  while (parent && !seen.has(parent.id) && !isSubgraph(parent)) {
    seen.add(parent.id)
    x += parent.position?.x ?? 0
    y += parent.position?.y ?? 0
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  return { x, y }
}

/** Where each node is drawn, by id. */
export function absolutePositions<N extends TreeNode>(nodes: readonly N[]): Map<string, Point> {
  const byId = byIdOf(nodes)
  return new Map(nodes.map((n) => [n.id, absolutePosition(n, byId)]))
}

/** `nodes` with every position absolute on its level's canvas, as agents and extensions read them; `parentId` stays. */
export function withAbsolutePositions<N extends TreeNode>(nodes: readonly N[]): N[] {
  const byId = byIdOf(nodes)
  return nodes.map((n) => (n.parentId ? { ...n, position: absolutePosition(n, byId) } : n))
}

/**
 * The level `nodeId` is on: the id of the nearest subgraph among its
 * ancestors, or undefined for the top level.
 */
export function levelOf<N extends TreeNode>(nodeId: string, byId: ReadonlyMap<string, N>): string | undefined {
  return ancestors(nodeId, byId).find(isSubgraph)?.id
}

/** `nodes`, each one inside a subgraph carrying its level as `subgraph` (see `levelOf`), as agents and extensions read them. */
export function withLevels<N extends TreeNode>(nodes: readonly N[]): Array<N & { subgraph?: string }> {
  const byId = byIdOf(nodes)
  return nodes.map((n) => {
    const level = n.parentId ? levelOf(n.id, byId) : undefined
    return level ? { ...n, subgraph: level } : n
  })
}

/** The frames and subgraphs `nodeId` lies in, innermost first. */
export function ancestors<N extends TreeNode>(nodeId: string, byId: ReadonlyMap<string, N>): N[] {
  const out: N[] = []
  const seen = new Set([nodeId])
  let parentId = byId.get(nodeId)?.parentId
  while (parentId && !seen.has(parentId)) {
    const parent = byId.get(parentId)
    if (!parent) {
      break
    }
    seen.add(parentId)
    out.push(parent)
    parentId = parent.parentId
  }
  return out
}

/** The ids of everything inside `nodeId`: its children, their children, and so on. */
export function descendants(nodeId: string, nodes: readonly TreeNode[]): Set<string> {
  const children = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.parentId) {
      children.set(n.parentId, [...(children.get(n.parentId) ?? []), n.id])
    }
  }
  const out = new Set<string>()
  const queue = [...(children.get(nodeId) ?? [])]
  while (queue.length > 0) {
    const id = queue.shift() as string
    if (id === nodeId || out.has(id)) {
      continue
    }
    out.add(id)
    queue.push(...(children.get(id) ?? []))
  }
  return out
}

/**
 * `at`, an absolute point, relative to `parent`: a frame, whose corner `abs`
 * gives, or a subgraph or the top level, whose canvas `at` is on already.
 */
export function toRelative(at: Point, parent: TreeNode | undefined, abs: ReadonlyMap<string, Point>): Point {
  const base = (parent && !isSubgraph(parent) && abs.get(parent.id)) || ORIGIN
  return { x: at.x - base.x, y: at.y - base.y }
}

/**
 * The innermost frame on `level` (a subgraph's id, undefined for the top
 * level) whose area holds `point` (absolute on that level), or undefined when
 * none does: of those frames, the deepest in the tree, then the smaller, then
 * the one drawn later. Never a frame in `excluded`. `abs` gives where each
 * frame is drawn.
 */
export function frameAtPoint<N extends TreeNode>(
  nodes: readonly N[],
  excluded: ReadonlySet<string>,
  point: Point,
  isFrame: IsFrame<N>,
  level: string | undefined,
  abs: ReadonlyMap<string, Point> = absolutePositions(nodes),
): string | undefined {
  const byId = byIdOf(nodes)
  let best: { id: string; depth: number; area: number; index: number } | undefined
  nodes.forEach((frame, index) => {
    if (excluded.has(frame.id) || !isFrame(frame) || isSubgraph(frame) || levelOf(frame.id, byId) !== level) {
      return
    }
    if (!frameHoldsPoint(frame, abs.get(frame.id) ?? ORIGIN, point)) {
      return
    }
    const size = frameSize(frame)
    const candidate = { id: frame.id, depth: ancestors(frame.id, byId).length, area: size.width * size.height, index }
    if (
      !best ||
      candidate.depth > best.depth ||
      (candidate.depth === best.depth &&
        (candidate.area < best.area || (candidate.area === best.area && index > best.index)))
    ) {
      best = candidate
    }
  })
  return best?.id
}

/**
 * The corner rule: the frame a node placed with its top-left corner at `at`
 * (absolute on its level) goes into. The innermost frame on the node's level
 * holding that point (see `frameAtPoint`), never `nodeId` itself or a frame
 * inside it; with none, the level itself: its subgraph, or undefined for the
 * top level. A node with no id yet is placed on the top level.
 */
export function dropTarget<N extends TreeNode>(
  nodes: readonly N[],
  nodeId: string | null,
  at: Point,
  isFrame: IsFrame<N>,
  abs: ReadonlyMap<string, Point> = absolutePositions(nodes),
): string | undefined {
  const excluded = nodeId ? new Set([nodeId, ...descendants(nodeId, nodes)]) : new Set<string>()
  const level = nodeId ? levelOf(nodeId, byIdOf(nodes)) : undefined
  return frameAtPoint(nodes, excluded, at, isFrame, level, abs) ?? level
}

/** The nodes in `placed` none of whose ancestors is placed too: the ones a placement puts somewhere. */
export function placedRoots<N extends TreeNode>(nodes: readonly N[], placed: ReadonlySet<string>): N[] {
  const byId = byIdOf(nodes)
  return nodes.filter((n) => placed.has(n.id) && !ancestors(n.id, byId).some((a) => placed.has(a.id)))
}

/**
 * The frame a canvas drag of the nodes in `dragged`, released with the
 * pointer at `pointer` (absolute), drops them into: the innermost frame under
 * the pointer on the level they are dragged on, never a dragged frame or a
 * frame inside one. Undefined when no frame is under the pointer.
 */
export function dragDropTarget<N extends TreeNode>(
  nodes: readonly N[],
  dragged: ReadonlySet<string>,
  pointer: Point,
  isFrame: IsFrame<N>,
): string | undefined {
  const excluded = new Set([...dragged].flatMap((id) => [id, ...descendants(id, nodes)]))
  return frameAtPoint(nodes, excluded, pointer, isFrame, draggedLevel(nodes, dragged))
}

// The level a canvas drag happens on: the canvas shows one level, so every
// dragged node is on it.
function draggedLevel<N extends TreeNode>(nodes: readonly N[], dragged: ReadonlySet<string>): string | undefined {
  const [first] = dragged
  return first === undefined ? undefined : levelOf(first, byIdOf(nodes))
}

/**
 * The pointer rule: `nodes` after a canvas drag of the nodes in `dragged` was
 * released with the pointer at `pointer` (absolute). Every dragged node whose
 * parent is not dragged too goes into the one frame `dragDropTarget` gives,
 * or else to the level it is on, and stays where it is drawn. Returns `nodes`
 * itself when no parent changes.
 */
export function dropAtPoint<N extends TreeNode>(
  nodes: readonly N[],
  dragged: ReadonlySet<string>,
  pointer: Point,
  isFrame: IsFrame<N>,
): N[] {
  const target = dragDropTarget(nodes, dragged, pointer, isFrame) ?? draggedLevel(nodes, dragged)
  const moving = new Set(
    placedRoots(nodes, dragged)
      .filter((n) => n.parentId !== target)
      .map((n) => n.id),
  )
  if (moving.size === 0) {
    return nodes as N[]
  }
  const abs = absolutePositions(nodes)
  const parent = target ? byIdOf(nodes).get(target) : undefined
  return nodes.map((n) => (moving.has(n.id) ? reparent(n, parent, abs) : n))
}

/**
 * `nodes` with each frame grown to hold the nodes in `held` that are its
 * members: the frame's box becomes the union of its box and each such
 * member's box (`roomOf`) with the padding Wrap in section leaves, one grid
 * step left, right and bottom and `FRAME_TITLE_PADDING` at the top, its edges
 * snapped outward to the grid. Only the sides that are short move; a frame
 * never shrinks here. Growing left or up moves the frame's corner, and its
 * members' positions move back by as much, so nothing but the frame's edges
 * moves on screen. A frame that grew is held by its own parent in turn, up to
 * the top level. A frame for which `fitsItself` is true is left alone, and so
 * is the chain above it: it fits itself around its members (an autolayout
 * section), and whatever does that grows its parent. Membership never
 * changes. Returns `nodes` itself when no frame grows.
 */
export function growToHold<N extends TreeNode>(
  nodes: readonly N[],
  held: Iterable<string>,
  fitsItself: (frame: N) => boolean = () => false,
): N[] {
  let current = nodes as N[]
  const pending = new Set(held)
  while (pending.size > 0) {
    const byId = byIdOf(current)
    // The deepest first, so a frame is grown for all its members before its own parent is.
    const deepest = [...pending].reduce((p, q) => (depthOf(q, byId) > depthOf(p, byId) ? q : p))
    const frame = byId.get(byId.get(deepest)?.parentId ?? '')
    // A subgraph has no area to grow: its members are on a canvas of their own.
    if (!frame || isSubgraph(frame)) {
      pending.delete(deepest)
      continue
    }
    const members = current.filter((n) => n.parentId === frame.id && pending.has(n.id))
    for (const m of members) {
      pending.delete(m.id)
    }
    if (fitsItself(frame)) {
      continue
    }
    const size = frameSize(frame)
    const boxes = members.map((m) => ({ ...(m.position ?? ORIGIN), ...roomOf(m) }))
    const left = Math.min(0, floorToGrid(Math.min(...boxes.map((b) => b.x))) - FRAME_PADDING)
    const top = Math.min(0, floorToGrid(Math.min(...boxes.map((b) => b.y))) - FRAME_TITLE_PADDING)
    const right = Math.max(size.width, ceilToGrid(Math.max(...boxes.map((b) => b.x + b.width))) + FRAME_PADDING)
    const bottom = Math.max(size.height, ceilToGrid(Math.max(...boxes.map((b) => b.y + b.height))) + FRAME_PADDING)
    if (left === 0 && top === 0 && right === size.width && bottom === size.height) {
      continue
    }
    const at = frame.position ?? ORIGIN
    const grown = withSize(
      { ...frame, position: { x: at.x + left, y: at.y + top } },
      {
        width: right - left,
        height: bottom - top,
      },
    )
    current = current.map((n) => {
      if (n.id === frame.id) {
        return grown
      }
      if (n.parentId !== frame.id || (left === 0 && top === 0)) {
        return n
      }
      const { x, y } = n.position ?? ORIGIN
      return { ...n, position: { x: x - left, y: y - top } }
    })
    pending.add(frame.id)
  }
  return current
}

/**
 * The smallest size `frame` can be given with its top-left corner where it
 * is, so that it still holds its members as `growToHold` makes it: their
 * boxes (`roomOf`) plus the padding on the right and at the bottom. Null when
 * it has no members.
 */
export function minimumFrameSize<N extends TreeNode>(nodes: readonly N[], frameId: string): NodeSize | null {
  const members = nodes.filter((n) => n.parentId === frameId)
  if (members.length === 0) {
    return null
  }
  const boxes = members.map((m) => ({ ...(m.position ?? ORIGIN), ...roomOf(m) }))
  return {
    width: ceilToGrid(Math.max(...boxes.map((b) => b.x + b.width))) + FRAME_PADDING,
    height: ceilToGrid(Math.max(...boxes.map((b) => b.y + b.height))) + FRAME_PADDING,
  }
}

/**
 * `after`, with each node whose parent's position differs from `before` while
 * its own does not moved back by as much, so it stays where it is drawn: a
 * frame's own position changing without carrying what is inside it, as when
 * a resize from its left or top edge snaps to the grid.
 */
export function membersStayDrawn<N extends TreeNode>(before: readonly N[], after: readonly N[]): N[] {
  const was = new Map(before.map((n) => [n.id, n.position ?? ORIGIN]))
  const shift = new Map<string, Point>()
  for (const n of after) {
    const from = was.get(n.id)
    const to = n.position ?? ORIGIN
    if (from && (from.x !== to.x || from.y !== to.y)) {
      shift.set(n.id, { x: to.x - from.x, y: to.y - from.y })
    }
  }
  if (shift.size === 0) {
    return after as N[]
  }
  return after.map((n) => {
    const by = n.parentId ? shift.get(n.parentId) : undefined
    if (!by || shift.has(n.id)) {
      return n
    }
    const { x, y } = n.position ?? ORIGIN
    return { ...n, position: { x: x - by.x, y: y - by.y } }
  })
}

/**
 * `node` moved into `parent` (undefined: the top level) on the same level,
 * where it is drawn now, `abs` holding where it and the new parent are drawn.
 * Its descendants stay where they are drawn without changing, their positions
 * being relative to it.
 */
export function reparent<N extends TreeNode>(
  node: N,
  parent: TreeNode | undefined,
  abs: ReadonlyMap<string, Point>,
): N {
  const { parentId: _parentId, extent: _extent, ...rest } = node as N & { extent?: unknown }
  const position = toRelative(abs.get(node.id) ?? node.position ?? ORIGIN, parent, abs)
  return { ...rest, ...(parent ? { parentId: parent.id } : {}), position } as N
}

/**
 * The corner rule for a placement without a pointer: `nodes` after the nodes
 * in `placed` were put down where they are drawn now. Each goes into the
 * frame `dropTarget` gives it, unless one of its ancestors was placed too, in
 * which case it stays in its parent. Frames are placed smallest first, so a
 * frame and a smaller one put over each other nest rather than loop. Returns
 * `nodes` itself when no parent changes.
 */
export function dropPlaced<N extends TreeNode>(
  nodes: readonly N[],
  placed: ReadonlySet<string>,
  isFrame: IsFrame<N>,
): N[] {
  const roots = placedRoots(nodes, placed)
  const area = (n: N) => (isFrame(n) ? frameSize(n).width * frameSize(n).height : Number.POSITIVE_INFINITY)
  roots.sort((p, q) => area(p) - area(q))
  // Reparenting keeps every node where it is drawn, so one map of where they are holds throughout.
  const abs = absolutePositions(nodes)
  let current = [...nodes]
  let changed = false
  for (const root of roots) {
    const node = current.find((n) => n.id === root.id) as N
    const target = dropTarget(current, node.id, abs.get(node.id) ?? ORIGIN, isFrame, abs)
    if (target === node.parentId) {
      continue
    }
    const moved = reparent(node, target ? byIdOf(current).get(target) : undefined, abs)
    current = current.map((n) => (n.id === node.id ? moved : n))
    changed = true
  }
  return changed ? current : (nodes as N[])
}

/**
 * The nodes a deletion of the nodes in `deleted` removes: those, and
 * everything inside a deleted subgraph, whose contents cannot be seen from
 * where it is deleted. A deleted frame's members are not among them.
 */
export function deletedWithContents(nodes: readonly TreeNode[], deleted: ReadonlySet<string>): Set<string> {
  const out = new Set(deleted)
  for (const n of nodes) {
    if (deleted.has(n.id) && isSubgraph(n)) {
      for (const id of descendants(n.id, nodes)) {
        out.add(id)
      }
    }
  }
  return out
}

/**
 * `nodes` without the nodes in `deleted` and the contents of a deleted
 * subgraph (`deletedWithContents`), each child of a deleted frame moved, where
 * it is drawn, to the nearest ancestor that stays and whose area holds its
 * top-left corner, or else to its level: the subgraph it is in, or the top
 * level. A frame may reach past its own parent's edge, so the nearest ancestor
 * that stays need not hold the child.
 */
export function deleteKeepingChildren<N extends TreeNode>(nodes: readonly N[], deleted: ReadonlySet<string>): N[] {
  const byId = byIdOf(nodes)
  const abs = absolutePositions(nodes)
  const gone = deletedWithContents(nodes, deleted)
  return nodes
    .filter((n) => !gone.has(n.id))
    .map((n) => {
      if (!n.parentId || !gone.has(n.parentId)) {
        return n
      }
      const at = abs.get(n.id) ?? ORIGIN
      const kept = ancestors(n.id, byId).find(
        (a) => !gone.has(a.id) && (isSubgraph(a) || frameHoldsPoint(a, abs.get(a.id) ?? ORIGIN, at)),
      )
      return reparent(n, kept, abs)
    })
}

/**
 * The nodes of a deletion that are deleted, out of the nodes React Flow
 * would delete: it adds the children of a deleted frame, and a frame's
 * children outlive it instead (they go to its parent). A node stays in the
 * deletion when it was asked for: selected, or not inside another node of the
 * deletion, or inside a subgraph of the deletion, which takes its contents.
 */
export function askedToDelete<N extends TreeNode & { selected?: boolean }>(requested: readonly N[]): N[] {
  const byId = byIdOf(requested)
  const asked = requested.filter((n) => n.selected || !n.parentId || !byId.has(n.parentId))
  const gone = deletedWithContents(requested, new Set(asked.map((n) => n.id)))
  return requested.filter((n) => gone.has(n.id))
}

/**
 * The edges of a deletion that are deleted, out of the edges React Flow
 * would delete: it adds every edge of a node it would delete, and the edges
 * of a node that outlives the deletion (in `requested` but not in `asked`, see
 * `askedToDelete`) stay with that node. An edge stays in the deletion when it
 * was asked for: selected, attached to a node that is deleted, or attached to
 * no node that outlives it, as the edges a pin's double-click names are.
 */
export function edgesAskedToDelete<E extends { source: string; target: string; selected?: boolean }>(
  requestedEdges: readonly E[],
  requested: readonly { id: string }[],
  asked: readonly { id: string }[],
): E[] {
  const deleted = new Set(asked.map((n) => n.id))
  const spared = new Set(requested.filter((n) => !deleted.has(n.id)).map((n) => n.id))
  return requestedEdges.filter(
    (e) =>
      e.selected || deleted.has(e.source) || deleted.has(e.target) || !(spared.has(e.source) || spared.has(e.target)),
  )
}

/** Every node after its parent, as React Flow requires; otherwise in the order given. */
export function parentsFirst<N extends { id?: unknown; parentId?: unknown }>(nodes: readonly N[]): N[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const placed = new Set<unknown>()
  const out: N[] = []
  const place = (node: N, chain: Set<unknown>) => {
    if (placed.has(node.id) || chain.has(node.id)) {
      return
    }
    chain.add(node.id)
    const parent = typeof node.parentId === 'string' ? byId.get(node.parentId) : undefined
    if (parent) {
      place(parent, chain)
    }
    placed.add(node.id)
    out.push(node)
  }
  for (const node of nodes) {
    place(node, new Set())
  }
  return out
}

/**
 * `nodes` with the tree made whole. A parent that is gone (a frame deleted
 * while someone dropped a node into it) is cleared, and the node keeps the
 * position it is drawn at, which with no parent to add is its own. A loop of
 * parents (two people dropping two frames into each other at once) is broken
 * at the node of the loop latest in the graph, which becomes top-level where
 * it is drawn. Returns `nodes` itself when nothing changes.
 *
 * Whether each parent is a frame is the caller's: it takes node types to
 * know, and a writer that sets `parentId` checks it.
 */
export function normaliseTree<N extends TreeNode>(nodes: readonly N[]): N[] {
  const byId = byIdOf(nodes)
  const index = new Map(nodes.map((n, i) => [n.id, i]))
  const cleared = new Set<string>()
  for (const node of nodes) {
    if (node.parentId && !byId.has(node.parentId)) {
      cleared.add(node.id)
    }
  }
  // Each loop is found from any node on it; its latest node is cut.
  for (const node of nodes) {
    const chain: string[] = []
    let id: string | undefined = node.id
    while (id && byId.has(id) && !cleared.has(id) && !chain.includes(id)) {
      chain.push(id)
      id = byId.get(id)?.parentId
    }
    if (id && chain.includes(id)) {
      const loop = chain.slice(chain.indexOf(id))
      const latest = loop.reduce((p, q) => ((index.get(q) ?? 0) > (index.get(p) ?? 0) ? q : p))
      cleared.add(latest)
    }
  }
  if (cleared.size === 0) {
    return nodes as N[]
  }
  const abs = absolutePositions(nodes)
  return nodes.map((n) => {
    if (!cleared.has(n.id)) {
      return n
    }
    const { parentId, ...rest } = n
    const position = parentId && byId.has(parentId) ? (abs.get(n.id) ?? n.position) : n.position
    return { ...rest, ...(position ? { position } : {}) } as N
  })
}

/** How deep `nodeId` lies: 0 at the top level, 1 in a top-level frame, and so on. */
export function depthOf<N extends TreeNode>(nodeId: string, byId: ReadonlyMap<string, N>): number {
  return ancestors(nodeId, byId).length
}
