// The part of the canvas a person can see.
//
// The canvas fills the App's whole viewport (AppViewport), so the sidebar, a
// docked chat and the docked inspector lie over parts of it. What they leave
// uncovered is the canvas panel's box, and a framed view (the graph fitted on
// opening, a node centred) aims at that box rather than at the whole canvas.
//
// Pure, so the rules are testable without a canvas.

import { getViewportForBounds, type Rect, type Viewport } from '@xyflow/react'

/** A box in the canvas element's own pixels: 0, 0 is the canvas's top left corner. */
export interface Area {
  left: number
  top: number
  width: number
  height: number
}

/** The box `visible` covers, in the pixels of `canvas`; both as the page lays them out. */
export function areaWithin(canvas: DOMRect, visible: DOMRect): Area {
  return {
    left: visible.left - canvas.left,
    top: visible.top - canvas.top,
    width: visible.width,
    height: visible.height,
  }
}

/** The view that centres the flow point `point` in `area` at `zoom`. */
export function centreViewport(point: { x: number; y: number }, zoom: number, area: Area): Viewport {
  return {
    x: area.left + area.width / 2 - point.x * zoom,
    y: area.top + area.height / 2 - point.y * zoom,
    zoom,
  }
}

/**
 * The view that fits `bounds` (flow coordinates) into `area`, centred there,
 * with the flow library's own rules for zoom limits and `padding` (a share
 * of the area kept clear, as its fitView takes it).
 */
export function fitViewport(
  bounds: Rect,
  area: Area,
  { minZoom, maxZoom, padding }: { minZoom: number; maxZoom: number; padding: number },
): Viewport {
  const view = getViewportForBounds(bounds, area.width, area.height, minZoom, maxZoom, padding)
  return { x: view.x + area.left, y: view.y + area.top, zoom: view.zoom }
}
