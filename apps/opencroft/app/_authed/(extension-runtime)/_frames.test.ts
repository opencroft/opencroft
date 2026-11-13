import assert from 'node:assert/strict'
import test from 'node:test'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import {
  FRAME_CATEGORY,
  frameHolds,
  isFrameType,
  MIN_FRAME_SIZE,
  newNodeLayout,
} from '@/app/_authed/(extension-runtime)/_frames'

const frame = { position: { x: 100, y: 50 }, style: { width: 400, height: 300 } }

test('a frame holds a node whose top-left corner lies in its area, its far edges excluded', () => {
  assert.equal(frameHolds(frame, { position: { x: 100, y: 50 } }), true, 'the frame’s own corner')
  assert.equal(frameHolds(frame, { position: { x: 499, y: 349 } }), true, 'just inside the far corner')
  assert.equal(frameHolds(frame, { position: { x: 500, y: 100 } }), false, 'on the right edge')
  assert.equal(frameHolds(frame, { position: { x: 200, y: 350 } }), false, 'on the bottom edge')
  assert.equal(frameHolds(frame, { position: { x: 99, y: 100 } }), false, 'left of it')
})

test('a frame with no stored size is taken at the minimum, one dimension at a time', () => {
  const unsized = { position: { x: 0, y: 0 } }
  assert.equal(frameHolds(unsized, { position: { x: MIN_FRAME_SIZE.width - 1, y: MIN_FRAME_SIZE.height - 1 } }), true)
  assert.equal(frameHolds(unsized, { position: { x: MIN_FRAME_SIZE.width, y: 0 } }), false)
  const wide = { position: { x: 0, y: 0 }, style: { width: 1000 } }
  assert.equal(frameHolds(wide, { position: { x: 900, y: 10 } }), true, 'the stored width counts')
  assert.equal(
    frameHolds(wide, { position: { x: 10, y: MIN_FRAME_SIZE.height } }),
    false,
    'the missing height is the minimum',
  )
})

test('a size that is not a number is no size', () => {
  const styled = { position: { x: 0, y: 0 }, style: { width: '1000px', height: '1000px' } }
  assert.equal(frameHolds(styled, { position: { x: 500, y: 10 } }), false)
})

test('a new frame is drawn behind the rest at its starting size; other nodes by their category', () => {
  assert.deepEqual(newNodeLayout({ type: 'builtin.core.section', category: FRAME_CATEGORY }), {
    zIndex: -1,
    style: { width: 400, height: 300 },
  })
  assert.deepEqual(newNodeLayout({ type: 'acme.ui.window', category: 'Windows' }), {
    style: { width: 800, height: 480 },
  })
  assert.deepEqual(newNodeLayout({ type: 'acme.apps.app', category: 'Applications' }), {})
  assert.deepEqual(newNodeLayout(undefined), {})
})

test('a subgraph is listed with the frames but is not one, and is created as a card', () => {
  assert.equal(isFrameType({ type: SUBGRAPH_TYPE, category: FRAME_CATEGORY }), false)
  assert.equal(isFrameType({ type: 'builtin.core.section', category: FRAME_CATEGORY }), true)
  assert.deepEqual(newNodeLayout({ type: SUBGRAPH_TYPE, category: FRAME_CATEGORY }), {})
})
