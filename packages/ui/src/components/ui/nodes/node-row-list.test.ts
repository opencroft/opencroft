// Where a dragged row lands, and how a host puts its own list in the order a
// drop reported.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { inRowOrder, reorderedIds } from './node-row-list'

const ids = ['a', 'b', 'c', 'd']

test('a row dropped after a later row lands after it', () => {
  assert.deepEqual(reorderedIds(ids, 'a', { index: 2, pos: 'after' }), ['b', 'c', 'a', 'd'])
})

test('a row dropped before an earlier row lands before it', () => {
  assert.deepEqual(reorderedIds(ids, 'd', { index: 1, pos: 'before' }), ['a', 'd', 'b', 'c'])
})

test('a row dropped at either edge of its own place, or of its neighbour toward it, stays put', () => {
  assert.equal(reorderedIds(ids, 'b', { index: 1, pos: 'before' }), null)
  assert.equal(reorderedIds(ids, 'b', { index: 1, pos: 'after' }), null)
  assert.equal(reorderedIds(ids, 'b', { index: 0, pos: 'after' }), null)
  assert.equal(reorderedIds(ids, 'b', { index: 2, pos: 'before' }), null)
})

test('a row the list does not hold moves nothing', () => {
  assert.equal(reorderedIds(ids, 'z', { index: 0, pos: 'before' }), null)
})

test("the host's list follows the reported order, and an entry added since keeps its place after the others", () => {
  const list = [{ key: 'a' }, { key: 'new' }, { key: 'b' }, { key: 'c' }]
  assert.deepEqual(
    inRowOrder(list, (e) => e.key, ['c', 'a', 'b']).map((e) => e.key),
    ['c', 'a', 'b', 'new'],
  )
})
