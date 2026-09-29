// A save must not carry the tab's selection, and a load must not adopt one.
// Both halves were live on stage: graphs held `selected: true` rows, and every
// reload of the page came up with those nodes picked.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { Node } from '@xyflow/react'

import { persistedNodes, withCurrentSelection } from './graph-view-state'

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: {},
  ...extra,
})

test('a save drops the view flags and the comment overlays, and keeps the rest', () => {
  const saved = persistedNodes([
    node('a', { selected: true, dragging: false, measured: { width: 200, height: 80 } }),
    node('comment-a', { type: 'comment', selectable: false }),
  ])
  assert.deepEqual(
    saved.map((n) => n.id),
    ['a'],
  )
  assert.equal('selected' in saved[0], false)
  assert.equal('dragging' in saved[0], false)
  assert.equal('selectable' in saved[0], false)
  assert.deepEqual(saved[0].measured, { width: 200, height: 80 })
})

test('a fetched graph takes the selection this tab has, not the one the rows carry', () => {
  const incoming = [node('a', { selected: true }), node('b'), node('c', { selected: true })]
  const current = [node('a'), node('b', { selected: true })]
  assert.deepEqual(
    withCurrentSelection(incoming, current).map((n) => [n.id, n.selected]),
    [
      ['a', false],
      ['b', true],
      ['c', false],
    ],
  )
})

test('a first load, with nothing on the canvas yet, selects nothing', () => {
  const loaded = withCurrentSelection([node('a', { selected: true })], [])
  assert.equal(loaded[0].selected, false)
})
