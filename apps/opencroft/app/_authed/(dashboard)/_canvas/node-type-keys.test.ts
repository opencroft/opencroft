import assert from 'node:assert/strict'
import { test } from 'node:test'

import { graphNodeTypes, nodeTypeIds, nodeTypesKey, typesFromKey } from './node-type-keys'

// The reason the canvas can paint before extensions arrive. A type present only
// in the graph still needs a component, or the flow library substitutes its own
// and logs once per node — and the node never reaches the code that would draw
// it as loading or as missing.
test('a type only the graph knows about still gets an entry', () => {
  const ids = nodeTypeIds(['agent'], ['agent', 'docker'])
  assert.deepEqual([...ids].sort(), ['agent', 'docker'])
})

test('registered types survive when the graph contains none of them', () => {
  assert.deepEqual(nodeTypeIds(['agent'], []), ['agent'])
})

test('a type both registered and present in the graph appears once', () => {
  const ids = nodeTypeIds(['agent', 'agent'], ['agent'])
  assert.deepEqual(ids, ['agent'])
})

test('graph node types are de-duplicated, sorted, and skip nodes with no type', () => {
  const types = graphNodeTypes([{ type: 'docker' }, { type: 'agent' }, { type: 'docker' }, {}, { type: '' }])
  assert.deepEqual(types, ['agent', 'docker'])
})

// The property the whole memo rests on. Nodes are reordered constantly — by
// selection, by dragging, by a resync writing them back in a different order —
// and none of that changes which components the canvas needs.
test('the key is unchanged when the same types arrive in a different order', () => {
  const a = nodeTypesKey(graphNodeTypes([{ type: 'agent' }, { type: 'docker' }]))
  const b = nodeTypesKey(graphNodeTypes([{ type: 'docker' }, { type: 'agent' }]))
  assert.equal(a, b)
})

test('the key is unchanged when a node of an existing type is added', () => {
  const before = nodeTypesKey(graphNodeTypes([{ type: 'agent' }, { type: 'docker' }]))
  const after = nodeTypesKey(graphNodeTypes([{ type: 'agent' }, { type: 'docker' }, { type: 'agent' }]))
  assert.equal(before, after)
})

test('the key moves when a type appears or its last node goes away', () => {
  const one = nodeTypesKey(graphNodeTypes([{ type: 'agent' }]))
  const two = nodeTypesKey(graphNodeTypes([{ type: 'agent' }, { type: 'docker' }]))
  assert.notEqual(one, two)
  assert.equal(nodeTypesKey(graphNodeTypes([{ type: 'docker' }])), nodeTypesKey(['docker']))
})

test('a key round-trips back to its types, and an empty key yields none', () => {
  const types = graphNodeTypes([{ type: 'b' }, { type: 'a' }])
  assert.deepEqual(typesFromKey(nodeTypesKey(types)), types)
  assert.deepEqual(typesFromKey(''), [])
  assert.deepEqual(typesFromKey(nodeTypesKey([])), [])
})

// A separator that could appear inside a type would let two different sets
// collapse to the same key, and the canvas would then miss a component for a
// type it really contains.
test('types containing separator-like characters cannot collide', () => {
  const spaced = nodeTypesKey(graphNodeTypes([{ type: 'a b' }]))
  const pair = nodeTypesKey(graphNodeTypes([{ type: 'a' }, { type: 'b' }]))
  assert.notEqual(spaced, pair)
  assert.deepEqual(typesFromKey(spaced), ['a b'])
})
