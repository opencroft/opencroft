// A framed view aims at the part of the canvas no panel or sidebar covers.

import assert from 'node:assert/strict'
import test from 'node:test'

import { areaWithin, centreViewport, fitViewport } from '@/app/_authed/(dashboard)/_canvas/visible-area'

const rect = (left: number, top: number, width: number, height: number) =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top }) as DOMRect

test('the visible area is the uncovered box, in the canvas own pixels', () => {
  // A canvas from the window's left edge, under a 48px title bar; the panel
  // beside a 384px sidebar.
  assert.deepEqual(areaWithin(rect(0, 48, 1280, 752), rect(384, 48, 896, 752)), {
    left: 384,
    top: 0,
    width: 896,
    height: 752,
  })
})

test('a point is centred in the visible area, not in the whole canvas', () => {
  const area = { left: 384, top: 0, width: 896, height: 752 }
  assert.deepEqual(centreViewport({ x: 100, y: 50 }, 1, area), { x: 732, y: 326, zoom: 1 })
  // The zoom scales the point, not the area.
  assert.deepEqual(centreViewport({ x: 100, y: 50 }, 2, area), { x: 632, y: 276, zoom: 2 })
})

test('fitting keeps the bounds inside the visible area and centres them there', () => {
  const area = { left: 300, top: 0, width: 500, height: 600 }
  // Small bounds stop at the zoom limit and sit in the area's centre.
  const small = fitViewport({ x: 0, y: 0, width: 100, height: 100 }, area, { minZoom: 0.25, maxZoom: 1, padding: 0.1 })
  assert.deepEqual(small, { x: 500, y: 250, zoom: 1 })
  // Wide bounds are zoomed out until they fit the area's width, padding included.
  const wide = fitViewport({ x: 0, y: 0, width: 2200, height: 100 }, area, {
    minZoom: 0.1,
    maxZoom: 1,
    padding: 0.1,
  })
  const left = 0 * wide.zoom + wide.x
  const right = 2200 * wide.zoom + wide.x
  assert.ok(left >= area.left && right <= area.left + area.width, `${left}..${right}`)
  assert.equal(Math.round((left + right) / 2), area.left + area.width / 2)
})
