import assert from 'node:assert/strict'
import { test } from 'node:test'

import { staleHandleIds } from './stale-handles'

const NONE = new Set<string>()

test('an edge into an input the node does not draw is stale', () => {
  const ids = staleHandleIds(
    { source: [{ id: 'result' }], target: [{ id: 'b' }] },
    'target',
    [
      { source: 'n1', target: 'math', sourceHandle: 'value', targetHandle: 'a' },
      { source: 'n2', target: 'math', sourceHandle: 'value', targetHandle: 'b' },
    ],
    'math',
    NONE,
  )
  assert.deepEqual(ids, ['a'])
})

test('a node that draws no input at all still shows its inputs’ edges as stale', () => {
  // A Format whose template has no placeholder left: the flow library
  // measures its inputs as null, not as an empty list.
  const ids = staleHandleIds(
    { source: [{ id: 'text' }], target: null },
    'target',
    [{ source: 'n1', target: 'format', sourceHandle: 'value', targetHandle: 'arg-name' }],
    'format',
    NONE,
  )
  assert.deepEqual(ids, ['arg-name'])
})

test('a node that draws no output at all still shows its outputs’ edges as stale', () => {
  const ids = staleHandleIds(
    { source: null, target: [{ id: 'in' }] },
    'source',
    [{ source: 'sw', target: 'log', sourceHandle: 'case-a', targetHandle: 'exec-in' }],
    'sw',
    NONE,
  )
  assert.deepEqual(ids, ['case-a'])
})

test('nothing is stale before the node is first measured', () => {
  const ids = staleHandleIds(
    undefined,
    'target',
    [{ source: 'n1', target: 'format', sourceHandle: 'value', targetHandle: 'arg-name' }],
    'format',
    NONE,
  )
  assert.deepEqual(ids, [])
})

test('the stale pin’s own handle does not make its id drawn', () => {
  const edges = [{ source: 'n1', target: 'format', sourceHandle: 'value', targetHandle: 'arg-name' }]
  const pinDrawn = new Set(['target:arg-name'])
  assert.deepEqual(staleHandleIds({ target: [{ id: 'arg-name' }] }, 'target', edges, 'format', pinDrawn), ['arg-name'])
  // A second handle under that id is the node's own, declared again.
  assert.deepEqual(
    staleHandleIds({ target: [{ id: 'arg-name' }, { id: 'arg-name' }] }, 'target', edges, 'format', pinDrawn),
    [],
  )
})

test('a handle several edges use is listed once, and other nodes’ edges count for nothing', () => {
  const ids = staleHandleIds(
    { target: null },
    'target',
    [
      { source: 'n1', target: 'format', sourceHandle: 'value', targetHandle: 'arg-x' },
      { source: 'n2', target: 'format', sourceHandle: 'value', targetHandle: 'arg-x' },
      { source: 'n1', target: 'other', sourceHandle: 'value', targetHandle: 'arg-y' },
    ],
    'format',
    NONE,
  )
  assert.deepEqual(ids, ['arg-x'])
})
