// Where a paste lands. The clipboard holds nodes at the coordinates they had
// in the graph they were copied from, which can be anywhere, in this graph or
// another. A paste moves the whole group by one offset to where the person is
// looking, so the nodes keep their layout relative to each other.
//
// Pure, so the rule is testable without a canvas or a clipboard.

import { absolutePosition } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { drawnSize, GRID_STEP, snapToGrid } from '@/app/_authed/(extension-runtime)/_grid'

export interface Point {
  x: number
  y: number
}

interface LayoutNode {
  id: string
  position: Point
  parentId?: string
  extent?: unknown
  width?: number
  height?: number
  measured?: { width?: number; height?: number }
  style?: object
}

/**
 * Where the pasted group goes: `point` in flow coordinates, with the group's
 * bounding box centred on it, or its top-left corner on it.
 */
export interface PasteAnchor {
  point: Point
  align: 'centre' | 'top-left'
}

/** The canvas transform: the pan `x`, `y` in screen pixels and the zoom. */
export type Transform = readonly [number, number, number]

/**
 * The flow-space point at the centre of a pane `width` by `height` screen
 * pixels, under the canvas transform `[x, y, zoom]`.
 */
export function viewportCentre(width: number, height: number, [x, y, zoom]: Transform): Point {
  return { x: (width / 2 - x) / zoom, y: (height / 2 - y) / zoom }
}

/** One paste's placement, and what makes the next paste a repeat of it. */
export interface PasteRun {
  /** Equal for two pastes into the same place: the same view, or the same menu point. */
  key: string
  anchor: PasteAnchor
  repeat: number
}

/**
 * Where a paste with `key` goes after `last`. With the same key it reuses the
 * last anchor one step further on; otherwise it starts over at `fresh()`.
 * The anchor is reused rather than measured again because what is measured
 * can move without the person moving the view: the pane narrows when the
 * pasted selection opens the inspector, and that moves the pane's centre.
 */
export function nextPasteRun(last: PasteRun | null, key: string, fresh: () => PasteAnchor): PasteRun {
  if (last && last.key === key) {
    return { key, anchor: last.anchor, repeat: last.repeat + 1 }
  }
  return { key, anchor: fresh(), repeat: 0 }
}

/**
 * `picked` as a group that stands on its own. A node whose parent is picked
 * too keeps its parent and its position relative to it. A node whose parent is
 * not picked becomes top-level at the place it is drawn, its absolute
 * position: the parent will not be there to measure from once pasted.
 */
export function detachFromUnpicked<N extends LayoutNode>(picked: readonly N[], all: readonly N[]): N[] {
  const pickedIds = new Set(picked.map((n) => n.id))
  const byId = new Map(all.map((n) => [n.id, n]))
  return picked.map((node) => {
    if (!node.parentId || pickedIds.has(node.parentId)) {
      return node
    }
    const { parentId: _parentId, extent: _extent, ...rest } = node
    return { ...rest, position: absolutePosition(node, byId) } as N
  })
}

/** The box around the group's top-level nodes; a child is drawn inside its parent. */
export function groupBounds(nodes: readonly LayoutNode[]): { x: number; y: number; width: number; height: number } {
  const ids = new Set(nodes.map((n) => n.id))
  const top = nodes.filter((n) => !n.parentId || !ids.has(n.parentId))
  if (top.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 }
  }
  const x = Math.min(...top.map((n) => n.position.x))
  const y = Math.min(...top.map((n) => n.position.y))
  const right = Math.max(...top.map((n) => n.position.x + drawnSize(n).width))
  const bottom = Math.max(...top.map((n) => n.position.y + drawnSize(n).height))
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * The one offset every top-level pasted node moves by. It is a whole number of
 * grid steps, so a node that sat on the grid still does and the layout is kept
 * exactly; `repeat` adds one more step per paste already made at the same
 * anchor, so copies pasted one after another do not cover each other.
 */
export function pasteOffset(nodes: readonly LayoutNode[], anchor: PasteAnchor, repeat: number): Point {
  const box = groupBounds(nodes)
  const left = anchor.align === 'centre' ? anchor.point.x - box.width / 2 : anchor.point.x
  const top = anchor.align === 'centre' ? anchor.point.y - box.height / 2 : anchor.point.y
  return {
    x: snapToGrid(left - box.x) + repeat * GRID_STEP,
    y: snapToGrid(top - box.y) + repeat * GRID_STEP,
  }
}

/** `nodes` moved by `offset`: the top-level ones only, a child stays where it is in its parent. */
export function offsetTopLevel<N extends LayoutNode>(nodes: readonly N[], offset: Point): N[] {
  const ids = new Set(nodes.map((n) => n.id))
  return nodes.map((n) =>
    n.parentId && ids.has(n.parentId)
      ? n
      : { ...n, position: { x: n.position.x + offset.x, y: n.position.y + offset.y } },
  )
}
