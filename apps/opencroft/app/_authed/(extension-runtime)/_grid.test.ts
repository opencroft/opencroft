import assert from 'node:assert/strict'
import test from 'node:test'

import { newNodeLayout } from '@/app/_authed/(extension-runtime)/_frames'
import {
  ceilToGrid,
  drawnSize,
  GRID_STEP,
  ownSize,
  snapMovedNode,
  snapResizedBox,
  snapResizedNode,
  snapToGrid,
  withGridSize,
  withSize,
} from '@/app/_authed/(extension-runtime)/_grid'

test('a position snaps to the nearest grid line, a size rounds up to the next one', () => {
  assert.equal(GRID_STEP, 10)
  assert.equal(snapToGrid(104), 100)
  assert.equal(snapToGrid(105), 110)
  assert.equal(ceilToGrid(201), 210, 'a size never clips what it was given room for')
  assert.equal(ceilToGrid(200), 200)
  assert.equal(ceilToGrid(200.000001), 200, 'layout noise above a grid line stays on it')
})

test('a resize snaps both corners: the dragged edge to the nearest line, an edge on a line stays', () => {
  // Bottom-right handle dragged to (437, 286) from a box at (100, 50).
  assert.deepEqual(snapResizedBox({ x: 100, y: 50, width: 337, height: 236 }), {
    x: 100,
    y: 50,
    width: 340,
    height: 240,
  })
  // Top-left handle dragged to (63, 17): the far corner (500, 350) stays.
  assert.deepEqual(snapResizedBox({ x: 63, y: 17, width: 437, height: 333 }), {
    x: 60,
    y: 20,
    width: 440,
    height: 330,
  })
  // A box off the grid before the resize ends with both corners on it.
  const off = snapResizedBox({ x: 13, y: 7, width: 291, height: 158 })
  for (const v of [off.x, off.y, off.x + off.width, off.y + off.height]) {
    assert.equal(v % GRID_STEP, 0, JSON.stringify(off))
  }
})

test('a resize at a minimum that is a grid multiple never ends below it', () => {
  for (let x = 0; x < GRID_STEP; x += 0.5) {
    const box = snapResizedBox({ x, y: x, width: 300, height: 200 })
    assert.ok(box.width >= 300 && box.height >= 200, JSON.stringify({ x, box }))
  }
})

test('a node’s own size is read per axis, the top-level field over style, as the canvas draws it', () => {
  assert.deepEqual(ownSize({ style: { width: 400, height: 300 } }), { width: 400, height: 300 })
  assert.deepEqual(ownSize({ width: 437, style: { width: 440, height: 300 } }), { width: 437, height: 300 })
  assert.deepEqual(ownSize({ style: { width: '100%' } }), {}, 'only a number of pixels is a size')
  assert.deepEqual(ownSize({}), {})
})

test('a size is written on style, and on the top-level field only where the node has one', () => {
  assert.deepEqual(withSize({ style: { zIndex: 1 } }, { width: 400, height: 300 }), {
    style: { zIndex: 1, width: 400, height: 300 },
  })
  assert.deepEqual(withSize({ width: 437, height: 286, style: { width: 440 } }, { width: 440, height: 290 }), {
    width: 440,
    height: 290,
    style: { width: 440, height: 290 },
  })
  assert.deepEqual(withSize({ style: {} }, { width: 400 }), { style: { width: 400 } }, 'an axis not given is not set')
})

test('a size is written on the measured size too where the node has one, so it is read as drawn at once', () => {
  const node = { style: { width: 400, height: 300 }, measured: { width: 400, height: 300 } }
  const next = withSize(node, { height: 610 })
  assert.deepEqual(next, { style: { width: 400, height: 610 }, measured: { width: 400, height: 610 } })
  assert.deepEqual(drawnSize(next), { width: 400, height: 610 })
  assert.deepEqual(node.measured, { width: 400, height: 300 }, 'the node given is left as it was')
})

test('a resized node snaps its box, writing the axes it sizes and leaving a content-sized axis alone', () => {
  // As the resizer leaves it: top-level size set, the stored style from before.
  const resized = {
    id: 'a',
    position: { x: 63, y: 17 },
    width: 437,
    height: 333,
    style: { width: 400, height: 300 },
  }
  assert.deepEqual(snapResizedNode(resized), {
    id: 'a',
    position: { x: 60, y: 20 },
    width: 440,
    height: 330,
    style: { width: 440, height: 330 },
  })
  // A horizontal-only resizer: the height stays the content's.
  const widened = { id: 'b', position: { x: 0, y: 0 }, width: 237, measured: { width: 237, height: 93 } }
  assert.deepEqual(snapResizedNode(widened), {
    id: 'b',
    position: { x: 0, y: 0 },
    width: 240,
    measured: { width: 240, height: 93 },
    style: { width: 240 },
  })
})

test('a moved node lands on a grid point and an off-grid size of its own rounds up', () => {
  assert.deepEqual(snapMovedNode({ position: { x: 104, y: 56 }, width: 437, style: { width: 437, height: 291 } }), {
    position: { x: 100, y: 60 },
    width: 440,
    style: { width: 440, height: 300 },
  })
  const card = { position: { x: 104, y: 56 }, measured: { width: 213, height: 87 } }
  assert.deepEqual(snapMovedNode(card), { position: { x: 100, y: 60 }, measured: { width: 213, height: 87 } })
})

test('a content-sized node keeps no size, and every default layout is already on the grid', () => {
  const card = { id: 'c', style: { zIndex: 1 } }
  assert.equal(withGridSize(card), card)
  for (const category of ['Organization', 'Windows', 'Applications']) {
    const { style } = newNodeLayout({ type: 'acme.nodes.node', category })
    if (style) {
      assert.deepEqual(withGridSize({ style }).style, style, category)
    }
  }
})
