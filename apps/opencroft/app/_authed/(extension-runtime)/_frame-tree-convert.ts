// The one conversion of a stored graph to the frame tree (see `_frame-tree.ts`).
// A graph stored before the tree held every position absolute, and a node lay
// in every frame whose area held its top-left corner. Converted, each node is
// a child of the innermost such frame, at a position relative to it, so
// nothing moves on screen; membership changes only for a node more than one
// unrelated frame held, which keeps the innermost.
//
// Safe for both server and client — no runtime imports.

import {
  absolutePositions,
  ancestors,
  byIdOf,
  frameHoldsPoint,
  frameSize,
  type IsFrame,
  normaliseTree,
  type TreeNode,
} from '@/app/_authed/(extension-runtime)/_frame-tree'

/** A frame as a conversion report names it. */
export interface ReportedFrame {
  id: string
  type?: string
}

/** A node whose frames differ between the area rule and the tree it was converted to. */
export interface MembershipChange {
  nodeId: string
  type?: string
  /** Frames whose area held its corner, which it is not inside any more. */
  left: ReportedFrame[]
  /** Frames it is inside now whose area did not hold its corner. */
  gained: ReportedFrame[]
}

export interface ConvertedGraph<N> {
  nodes: N[]
  changes: MembershipChange[]
}

/**
 * `nodes`, stored with absolute positions, as a tree. Each node's parent is
 * the smallest frame whose area holds its top-left corner, never itself. A
 * frame's parent is only a larger frame, or an equal one earlier in the
 * graph, so no two frames hold each other; of equal frames the later is
 * inside the earlier, so a node two equal frames hold goes into the later.
 * A node that already has a `parentId` keeps it. Positions become relative to
 * the parent. `changes` lists every node whose frames differ from those the
 * area rule gave it.
 */
export function toTree<N extends TreeNode>(nodes: readonly N[], isFrame: IsFrame<N>): ConvertedGraph<N> {
  const abs = absolutePositions(nodes)
  const frames = nodes
    .map((node, index) => ({ node, index, area: frameSize(node).width * frameSize(node).height }))
    .filter(({ node }) => isFrame(node))
  const indexOf = new Map(nodes.map((n, i) => [n.id, i]))
  const holdersOf = (node: N) =>
    frames.filter(
      ({ node: f }) =>
        f.id !== node.id && frameHoldsPoint(f, abs.get(f.id) ?? { x: 0, y: 0 }, abs.get(node.id) ?? { x: 0, y: 0 }),
    )

  const converted = nodes.map((node) => {
    if (node.parentId) {
      return node
    }
    const own = isFrame(node) ? frameSize(node).width * frameSize(node).height : Number.POSITIVE_INFINITY
    const index = indexOf.get(node.id) ?? 0
    const candidates = holdersOf(node).filter(
      (f) => !isFrame(node) || f.area > own || (f.area === own && f.index < index),
    )
    const parent = candidates.reduce<(typeof candidates)[number] | undefined>(
      (best, f) => (!best || f.area < best.area || (f.area === best.area && f.index > best.index) ? f : best),
      undefined,
    )
    if (!parent) {
      return node
    }
    const at = abs.get(node.id) ?? { x: 0, y: 0 }
    const base = abs.get(parent.node.id) ?? { x: 0, y: 0 }
    return { ...node, parentId: parent.node.id, position: { x: at.x - base.x, y: at.y - base.y } }
  })
  const tree = normaliseTree(converted)

  const byId = byIdOf(tree)
  const report = (f: TreeNode): ReportedFrame => ({ id: f.id, ...(f.type ? { type: f.type } : {}) })
  const changes = nodes.flatMap((node) => {
    const held = holdersOf(node).map(({ node: f }) => f)
    const inside = ancestors(node.id, byId)
    const left = held.filter((f) => !inside.some((a) => a.id === f.id))
    const gained = inside.filter((a) => !held.some((f) => f.id === a.id))
    if (left.length === 0 && gained.length === 0) {
      return []
    }
    return [
      {
        nodeId: node.id,
        ...(node.type ? { type: node.type } : {}),
        left: left.map(report),
        gained: gained.map(report),
      },
    ]
  })
  return { nodes: tree, changes }
}
