import assert from 'node:assert/strict'
import test from 'node:test'

import { readUrlParam, withUrlParam } from '@/app/_lib/url-params'

test('reads a present value, and reports an absent one as null', () => {
  assert.equal(readUrlParam('?view=graph&zoom=2', 'view'), 'graph')
  assert.equal(readUrlParam('?view=graph', 'zoom'), null)
})

test('reads from a query string with or without its leading marker', () => {
  assert.equal(readUrlParam('?view=graph', 'view'), 'graph')
  assert.equal(readUrlParam('view=graph', 'view'), 'graph')
})

test('accepts already-parsed parameters as well as a string', () => {
  const params = new URLSearchParams('?view=graph')
  assert.equal(readUrlParam(params, 'view'), 'graph')
  assert.deepEqual(withUrlParam(params, 'zoom', '2'), { view: 'graph', zoom: '2' })
})

test('adding a parameter leaves every other parameter alone', () => {
  assert.deepEqual(withUrlParam('?view=graph&zoom=2', 'panel', 'left'), {
    view: 'graph',
    zoom: '2',
    panel: 'left',
  })
})

test('setting an existing parameter replaces only that one', () => {
  assert.deepEqual(withUrlParam('?view=graph&zoom=2', 'view', 'list'), {
    view: 'list',
    zoom: '2',
  })
})

test('removing a parameter drops it and keeps the rest', () => {
  assert.deepEqual(withUrlParam('?view=graph&zoom=2', 'view', null), { zoom: '2' })
})

// The reason this returns a whole set rather than a patch. Under a merge-based
// update an absent key means "leave it alone", so a removed parameter survives
// every attempt to clear it. The result must not carry the key at all — not
// carry it as undefined, not carry it as empty.
test('a removed parameter is absent from the result, not merely emptied', () => {
  const next = withUrlParam('?view=graph', 'view', null)
  assert.equal('view' in next, false)
  assert.deepEqual(next, {})
})

test('removing a parameter that was never there changes nothing', () => {
  assert.deepEqual(withUrlParam('?view=graph', 'panel', null), { view: 'graph' })
})

test('an empty string is a value, and is kept rather than treated as removal', () => {
  const next = withUrlParam('?view=graph', 'panel', '')
  assert.equal('panel' in next, true)
  assert.equal(next.panel, '')
})

test('a repeated key collapses to its last occurrence', () => {
  assert.deepEqual(withUrlParam('?view=graph&view=list', 'zoom', '2'), { view: 'list', zoom: '2' })
})

test('values needing encoding survive a round trip', () => {
  const next = withUrlParam('', 'q', 'a b&c=d')
  assert.equal(next.q, 'a b&c=d')
  assert.equal(readUrlParam(new URLSearchParams(next).toString(), 'q'), 'a b&c=d')
})
