import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detachFromUnpicked,
  offsetTopLevel,
  pasteOffset,
  viewportCentre,
} from '@/app/_authed/(dashboard)/_canvas/paste-layout'

test('the viewport centre is the pane centre taken through the canvas transform', () => {
  assert.deepEqual(viewportCentre(800, 600, [100, -50, 2]), { x: 150, y: 175 })
})

test('the offset is one whole number of grid steps, so the layout is kept exactly', () => {
  const nodes = [
    { id: 'a', position: { x: 3, y: 7 } },
    { id: 'b', position: { x: 58, y: 41 } },
  ]
  const offset = pasteOffset(nodes, { point: { x: 104, y: 96 }, align: 'top-left' }, 0)
  assert.deepEqual(offset, { x: 100, y: 90 })
  const moved = offsetTopLevel(nodes, offset)
  assert.deepEqual(
    moved.map((n) => n.position),
    [
      { x: 103, y: 97 },
      { x: 158, y: 131 },
    ],
  )
})

test('the group box takes a node size from its measured size, then its own size', () => {
  const nodes = [
    { id: 'a', position: { x: 0, y: 0 }, measured: { width: 40, height: 20 } },
    { id: 'b', position: { x: 100, y: 100 }, style: { width: 100, height: 60 } },
  ]
  // The box is 200 by 160; centred on (500, 500) its top-left is (400, 420).
  assert.deepEqual(pasteOffset(nodes, { point: { x: 500, y: 500 }, align: 'centre' }, 0), { x: 400, y: 420 })
})

test('a child whose parent is not picked is placed at its absolute position, through every ancestor', () => {
  const all = [
    { id: 'outer', position: { x: 1000, y: 2000 } },
    { id: 'inner', parentId: 'outer', position: { x: 100, y: 200 } },
    { id: 'leaf', parentId: 'inner', extent: 'parent', position: { x: 10, y: 20 } },
  ]
  const leaf = all[2]
  assert.ok(leaf)
  assert.deepEqual(detachFromUnpicked([leaf], all), [{ id: 'leaf', position: { x: 1110, y: 2220 } }])
})

test('a child whose parent is picked too keeps its parent and relative position', () => {
  const all = [
    { id: 'frame', position: { x: 1000, y: 2000 } },
    { id: 'child', parentId: 'frame', position: { x: 10, y: 20 } },
  ]
  assert.deepEqual(detachFromUnpicked(all, all), all)
})
