// An input port of a value type with nothing outside feeds the nodes inside
// with the value typed on the subgraph's card.

import assert from 'node:assert/strict'
import test from 'node:test'

import { NUMBER_TYPE } from '@opencroft/core/values'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import {
  inputFeedOf,
  type WiringEdge,
  type WiringNode,
  wiredEdges,
} from '@/app/_authed/(extension-runtime)/_wired-edges'

function subgraph(id: string, handleType: string, inputs?: Record<string, unknown>, parentId?: string): WiringNode {
  return {
    id,
    type: SUBGRAPH_TYPE,
    ...(parentId ? { parentId } : {}),
    data: {
      name: id,
      ports: { inputs: [{ id: 'a', label: 'a', handleType }], outputs: [] },
      ...(inputs ? { inputs } : {}),
    },
  }
}

const node = (id: string, parentId?: string): WiringNode => ({
  id,
  type: 'acme.t.node',
  ...(parentId ? { parentId } : {}),
})

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): WiringEdge {
  return { id, source, sourceHandle, target, targetHandle }
}

const inner = edge('inner', 's', 'in-a', 'y', 'var-a')

test('a value port with a typed value and nothing outside feeds the node inside from the subgraph', () => {
  const nodes = [subgraph('s', NUMBER_TYPE, { 'in-a': 3 }), node('y', 's')]
  assert.deepEqual(wiredEdges({ nodes, edges: [inner] }), [inner])
})

test('an edge outside wins over the typed value', () => {
  const nodes = [node('x'), subgraph('s', NUMBER_TYPE, { 'in-a': 3 }), node('y', 's')]
  const outer = edge('outer', 'x', 'out', 's', 'in-a')
  assert.deepEqual(
    wiredEdges({ nodes, edges: [outer, inner] }).map((e) => `${e.source}/${e.sourceHandle}`),
    ['x/out'],
  )
})

test('a port with nothing typed, or of a type that takes no value, gives nothing', () => {
  assert.deepEqual(wiredEdges({ nodes: [subgraph('s', NUMBER_TYPE), node('y', 's')], edges: [inner] }), [])
  const terminal = subgraph('s', 'builtin.core.terminal-context', { 'in-a': 3 })
  assert.deepEqual(wiredEdges({ nodes: [terminal, node('y', 's')], edges: [inner] }), [])
  const wrongType = subgraph('s', NUMBER_TYPE, { 'in-a': 'three' })
  assert.deepEqual(wiredEdges({ nodes: [wrongType, node('y', 's')], edges: [inner] }), [])
})

test("an outer subgraph's typed value reaches through an inner subgraph's port to the node inside it", () => {
  const nodes = [
    subgraph('s', NUMBER_TYPE, { 'in-a': 3 }),
    subgraph('t', NUMBER_TYPE, { 'in-a': 9 }, 's'),
    node('y', 't'),
  ]
  const edges = [edge('s-to-t', 's', 'in-a', 't', 'in-a'), edge('t-to-y', 't', 'in-a', 'y', 'var-a')]
  assert.deepEqual(
    wiredEdges({ nodes, edges }).map((e) => `${e.source}/${e.sourceHandle} -> ${e.target}/${e.targetHandle}`),
    ['s/in-a -> y/var-a'],
  )
})

test("a subgraph's own input port is fed by the edge into it outside, with or without an edge past it", () => {
  const nodes = [node('x'), subgraph('s', NUMBER_TYPE, { 'in-a': 3 }), node('y', 's')]
  const outer = edge('outer', 'x', 'out', 's', 'in-a')
  assert.deepEqual(inputFeedOf({ nodes, edges: [outer, inner] }, 's', 'in-a'), { source: 'x', sourceHandle: 'out' })
  assert.deepEqual(inputFeedOf({ nodes, edges: [outer] }, 's', 'in-a'), { source: 'x', sourceHandle: 'out' })
  assert.deepEqual(inputFeedOf({ nodes, edges: [outer, inner] }, 'y', 'var-a'), { source: 'x', sourceHandle: 'out' })
  assert.equal(inputFeedOf({ nodes, edges: [inner] }, 's', 'in-a'), undefined, 'nothing outside')
})

test("a port fed from another subgraph's output is fed by the node inside that one", () => {
  const out: WiringNode = {
    id: 'o',
    type: SUBGRAPH_TYPE,
    data: { name: 'o', ports: { inputs: [], outputs: [{ id: 'b', label: 'b', handleType: NUMBER_TYPE }] } },
  }
  const nodes = [out, node('z', 'o'), subgraph('s', NUMBER_TYPE), node('y', 's')]
  const edges = [edge('z-out', 'z', 'out', 'o', 'out-b'), edge('o-to-s', 'o', 'out-b', 's', 'in-a')]
  assert.deepEqual(inputFeedOf({ nodes, edges }, 's', 'in-a'), { source: 'z', sourceHandle: 'out' })
})
