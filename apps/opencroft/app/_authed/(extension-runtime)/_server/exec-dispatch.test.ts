import assert from 'node:assert/strict'
import test from 'node:test'

import { pickPrimaryEdge, unsupportedHandlerError } from './exec-dispatch'

// ── pickPrimaryEdge ──────────────────────────────────────────────────────
// Edge ids are stable across canvas re-saves; array order is not (a re-save
// persists the whole in-memory graph and can reorder it). The primary target
// must be picked by id, not position, so it can't silently flip.

test('pickPrimaryEdge picks the lowest edge id', () => {
  const edges = [{ id: 'edge-b' }, { id: 'edge-a' }, { id: 'edge-c' }]
  assert.equal(pickPrimaryEdge(edges)?.id, 'edge-a')
})

test('pickPrimaryEdge is stable when the input array is shuffled', () => {
  const a = { id: 'edge-a', target: 'node-1' }
  const b = { id: 'edge-b', target: 'node-2' }
  const c = { id: 'edge-c', target: 'node-3' }

  const order1 = pickPrimaryEdge([a, b, c])
  const order2 = pickPrimaryEdge([c, a, b])
  const order3 = pickPrimaryEdge([b, c, a])

  assert.equal(order1?.target, 'node-1')
  assert.equal(order2?.target, 'node-1')
  assert.equal(order3?.target, 'node-1')
})

test('pickPrimaryEdge does not mutate its input', () => {
  const edges = [{ id: 'edge-b' }, { id: 'edge-a' }]
  const copy = [...edges]
  pickPrimaryEdge(edges)
  assert.deepEqual(edges, copy)
})

test('pickPrimaryEdge returns undefined for an empty list', () => {
  assert.equal(pickPrimaryEdge([]), undefined)
})

// ── unsupportedHandlerError ─────────────────────────────────────────────
// One wording for every producer, naming the languages a handler can be.

test('unsupportedHandlerError reports the given language', () => {
  assert.equal(
    unsupportedHandlerError('ruby'),
    'Unsupported handler language: ruby. Only Bash, Python and Node.js scripts support ExecutionContext.',
  )
})

test('unsupportedHandlerError reports "none" when no language is set', () => {
  assert.equal(
    unsupportedHandlerError(undefined),
    'Unsupported handler language: none. Only Bash, Python and Node.js scripts support ExecutionContext.',
  )
})
