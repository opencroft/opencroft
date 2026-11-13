import assert from 'node:assert/strict'
import test from 'node:test'

import { fallbackSize } from '@/app/_authed/(dashboard)/_canvas/window-shell'
import { ownSize } from '@/app/_authed/(extension-runtime)/_grid'

const defaultSize = { width: 400, height: 360 }

test('a node holding no size is drawn at the default size', () => {
  assert.deepEqual(fallbackSize(ownSize({}), defaultSize), { width: 400, height: 360 })
})

test('a node resized on the canvas keeps its own size', () => {
  assert.deepEqual(fallbackSize(ownSize({ width: 620, height: 300 }), defaultSize), {})
})

test('a node created with a style size keeps it', () => {
  assert.deepEqual(fallbackSize(ownSize({ style: { width: 800, height: 480 } }), defaultSize), {})
})

test('only the axis a node holds no size on takes the default', () => {
  assert.deepEqual(fallbackSize(ownSize({ width: 620 }), defaultSize), { height: 360 })
  assert.deepEqual(fallbackSize(ownSize({ style: { height: 300 } }), defaultSize), { width: 400 })
})

test('without a default size a node holding none is left to its content', () => {
  assert.deepEqual(fallbackSize(ownSize({}), undefined), {})
})
