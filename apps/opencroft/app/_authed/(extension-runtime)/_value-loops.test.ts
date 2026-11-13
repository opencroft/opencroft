import assert from 'node:assert/strict'
import test from 'node:test'

import { NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { loopRefusal, valueLoop } from '@/app/_authed/(extension-runtime)/_value-loops'

// Every node has a number output `out` and a number input `in`; `t` carries a
// terminal, which is not a value.
const sourceType = (_nodeId: string, handleId: string) =>
  handleId === 'out' ? NUMBER_TYPE : handleId === 'text' ? STRING_TYPE : 'builtin.core.terminal-context'

const nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id }))

function edge(id: string, source: string, target: string, sourceHandle = 'out', targetHandle = 'in') {
  return { id, source, target, sourceHandle, targetHandle }
}

test('an edge that closes a loop of values names the loop from its source round', () => {
  const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('new', 'c', 'a')]
  assert.deepEqual(valueLoop({ nodes, edges }, new Set(['new']), sourceType), ['c', 'a', 'b', 'c'])
})

test('an edge that closes no loop is not refused', () => {
  const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'c'), edge('new', 'a', 'c')]
  assert.equal(valueLoop({ nodes, edges }, new Set(['new']), sourceType), null)
})

test('an edge from a node into itself is a loop', () => {
  assert.deepEqual(valueLoop({ nodes, edges: [edge('new', 'a', 'a')] }, new Set(['new']), sourceType), ['a', 'a'])
})

test('a loop through an edge that carries no value is not a loop of values', () => {
  const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'a', 't', 'tin')]
  assert.equal(valueLoop({ nodes, edges }, new Set(['e1']), sourceType), null)
  // The same edge carrying text is.
  const text = [edge('e1', 'a', 'b'), edge('e2', 'b', 'a', 'text', 'tin')]
  assert.deepEqual(valueLoop({ nodes, edges: text }, new Set(['e1']), sourceType), ['a', 'b', 'a'])
})

test('only a loop through an added edge is reported', () => {
  const edges = [edge('e1', 'a', 'b'), edge('e2', 'b', 'a'), edge('new', 'c', 'd')]
  assert.equal(valueLoop({ nodes, edges }, new Set(['new']), sourceType), null)
})

test('a loop out of a subgraph and back in through its ports is found', () => {
  // `a` is inside subgraph `s`: s/in-p feeds a, a feeds s/out-q; outside, s/out-q feeds b and b feeds s/in-p.
  const withSubgraph = [
    {
      id: 's',
      type: SUBGRAPH_TYPE,
      data: {
        ports: {
          inputs: [{ id: 'p', label: 'p', handleType: NUMBER_TYPE }],
          outputs: [{ id: 'q', label: 'q', handleType: NUMBER_TYPE }],
        },
      },
    },
    { id: 'a', parentId: 's' },
    { id: 'b' },
  ]
  const edges = [
    edge('inner-in', 's', 'a', 'in-p', 'in'),
    edge('inner-out', 'a', 's', 'out', 'out-q'),
    edge('outer-out', 's', 'b', 'out-q', 'in'),
    edge('new', 'b', 's', 'out', 'in-p'),
  ]
  assert.deepEqual(valueLoop({ nodes: withSubgraph, edges }, new Set(['new']), sourceType), ['b', 'a', 'b'])
})

test('the refusal names every node on the loop, in order', () => {
  assert.equal(
    loopRefusal(['c', 'a', 'c'], (id) => id.toUpperCase()),
    'The edge would close a loop of values: C → A → C. A value cannot depend on itself: feed one of these inputs from outside the loop.',
  )
})
