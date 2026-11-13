// Wrap in section: a new Section laid around the selected nodes, on the grid,
// with the nodes as its members (see `_frame-tree.ts`), so a drag of it
// carries them along.
//
// Pure, so the rule is testable without a canvas.

import { absolutePositions, placedRoots, reparent, type TreeNode } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { FRAME_PADDING, FRAME_TITLE_PADDING } from '@/app/_authed/(extension-runtime)/_frames'
import { ceilToGrid, floorToGrid, type GridBox } from '@/app/_authed/(extension-runtime)/_grid'

/** The room left between the wrapped nodes and the section's left, right and bottom edges. */
export const WRAP_PADDING = FRAME_PADDING

/** The room left above the wrapped nodes, where the section draws its icon and label. */
export const WRAP_TITLE_PADDING = FRAME_TITLE_PADDING

/**
 * The section's box around `boxes`, each a node's place and drawn size on the
 * canvas: one grid step from the outermost nodes on the left, right and
 * bottom, four at the top for the title. Every edge is on the grid; a node
 * edge between two grid lines takes the line outside it, so the padding is
 * never less than that. `null` when there is nothing to wrap.
 */
export function sectionBoxAround(boxes: readonly GridBox[]): GridBox | null {
  if (boxes.length === 0) {
    return null
  }
  const left = floorToGrid(Math.min(...boxes.map((b) => b.x))) - WRAP_PADDING
  const top = floorToGrid(Math.min(...boxes.map((b) => b.y))) - WRAP_TITLE_PADDING
  const right = ceilToGrid(Math.max(...boxes.map((b) => b.x + b.width))) + WRAP_PADDING
  const bottom = ceilToGrid(Math.max(...boxes.map((b) => b.y + b.height))) + WRAP_PADDING
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/**
 * `nodes` with `section` added where it is drawn behind the nodes it wraps:
 * just before the first of them, so a frame among them stays in front of it
 * and a frame that already held them stays behind it. The new section is
 * the only node left selected, so it can be renamed or dragged at once.
 */
export function withSectionAround<N extends { id: string; selected?: boolean }>(
  nodes: readonly N[],
  wrapped: ReadonlySet<string>,
  section: N,
): N[] {
  const deselected = nodes.map((n) => (n.selected ? { ...n, selected: false } : n))
  const at = nodes.findIndex((n) => wrapped.has(n.id))
  const index = at === -1 ? nodes.length : at
  return [...deselected.slice(0, index), { ...section, selected: true }, ...deselected.slice(index)]
}

/**
 * `nodes` with `section`, placed at its absolute `position`, wrapped around
 * the nodes in `wrapped`: each of them whose frame is not wrapped too becomes
 * the section's member where it is drawn, and a member of a wrapped frame
 * stays in that frame. The section goes into the frame the wrapped nodes
 * shared, else to the top level; that frame is grown to hold it by the
 * caller (`growToHold`). Drawn and selected as `withSectionAround` puts it.
 */
export function wrapInSection<N extends TreeNode & { selected?: boolean }>(
  nodes: readonly N[],
  wrapped: ReadonlySet<string>,
  section: N,
): N[] {
  const top = placedRoots(nodes, wrapped)
  const abs = absolutePositions(nodes)
  const shared = top.every((n) => n.parentId === top[0]?.parentId) ? top[0]?.parentId : undefined
  abs.set(section.id, section.position ?? { x: 0, y: 0 })
  const topIds = new Set(top.map((n) => n.id))
  const members = nodes.map((n) => (topIds.has(n.id) ? reparent(n, section, abs) : n))
  return withSectionAround(
    members,
    wrapped,
    reparent(
      section,
      nodes.find((n) => n.id === shared),
      abs,
    ),
  )
}
