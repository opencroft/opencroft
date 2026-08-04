import assert from 'node:assert/strict'
import { test } from 'node:test'

import { edgeHandleIds } from './edge-handles'

test('collects the handle ids the edges expect at each end', () => {
  const ids = edgeHandleIds(
    [
      { source: 'a', target: 'b', sourceHandle: 'out', targetHandle: 'in' },
      { source: 'c', target: 'a', sourceHandle: 'out', targetHandle: 'docker-in' },
    ],
    'a',
  )
  assert.deepEqual(ids, { source: ['out'], target: ['docker-in'] })
})

test('edges belonging to other nodes contribute nothing', () => {
  const ids = edgeHandleIds([{ source: 'b', target: 'c', sourceHandle: 'out', targetHandle: 'in' }], 'a')
  assert.deepEqual(ids, { source: [], target: [] })
})

test('the same handle used by several edges is rendered once', () => {
  const ids = edgeHandleIds(
    [
      { source: 'a', target: 'b', sourceHandle: 'out' },
      { source: 'a', target: 'c', sourceHandle: 'out' },
      { source: 'a', target: 'd', sourceHandle: 'other' },
    ],
    'a',
  )
  assert.deepEqual(ids.source, ['out', 'other'])
})

// An edge without a named handle attaches to whatever default the node offers,
// so there is no id to reproduce and nothing to render for it.
test('edges with no named handle are skipped', () => {
  const ids = edgeHandleIds(
    [
      { source: 'a', target: 'b' },
      { source: 'a', target: 'c', sourceHandle: null },
      { source: 'd', target: 'a', targetHandle: undefined },
    ],
    'a',
  )
  assert.deepEqual(ids, { source: [], target: [] })
})

// A node wired to itself is both ends of one edge, so both anchors have to come
// out of the same pass rather than one winning.
test('a self-edge yields both of its anchors', () => {
  const ids = edgeHandleIds([{ source: 'a', target: 'a', sourceHandle: 'out', targetHandle: 'in' }], 'a')
  assert.deepEqual(ids, { source: ['out'], target: ['in'] })
})

test('no node id yields no anchors', () => {
  const ids = edgeHandleIds([{ source: 'a', target: 'b', sourceHandle: 'out' }], null)
  assert.deepEqual(ids, { source: [], target: [] })
})
