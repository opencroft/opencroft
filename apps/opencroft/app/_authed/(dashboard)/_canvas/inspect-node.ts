// What the canvas does when something asks the inspector for a node
// (`inspectorIntent.open`): that node becomes the only selected one, since the
// inspector shows the selection, and the view moves to it if it is out of
// sight.
//
// Pure, so the rules are testable without a canvas.

import type { Transform } from '@/app/_authed/(dashboard)/_canvas/paste-layout'
import { type Area, centreViewport } from '@/app/_authed/(dashboard)/_canvas/visible-area'

/** `nodes` with `nodeId` selected and every other node not. */
export function selectOnly<N extends { id: string; selected?: boolean }>(nodes: N[], nodeId: string): N[] {
  return nodes.map((n) => ({ ...n, selected: n.id === nodeId }))
}

/** A node's box in flow coordinates. */
export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/**
 * The view that shows `node` in the visible `area` of the pane (see
 * visible-area): null when the node is already seen whole there, otherwise
 * the node centred in it at the same zoom. The zoom is kept so the person's
 * view moves only as far as it has to.
 */
export function revealViewport(node: Box, area: Area, [x, y, zoom]: Transform): Viewport | null {
  const left = node.x * zoom + x
  const top = node.y * zoom + y
  const inView =
    left >= area.left &&
    top >= area.top &&
    left + node.width * zoom <= area.left + area.width &&
    top + node.height * zoom <= area.top + area.height
  if (inView) {
    return null
  }
  return centreViewport({ x: node.x + node.width / 2, y: node.y + node.height / 2 }, zoom, area)
}
