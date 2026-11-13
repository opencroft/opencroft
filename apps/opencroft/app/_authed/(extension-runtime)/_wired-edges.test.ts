import assert from 'node:assert/strict'
import test from 'node:test'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import {
  crossLevelRefusal,
  normaliseSubgraphs,
  portEndProblem,
  type WiringEdge,
  type WiringNode,
  wiredEdges,
} from '@/app/_authed/(extension-runtime)/_wired-edges'

function subgraph(id: string, inputs: string[], outputs: string[], parentId?: string): WiringNode {
  const port = (p: string) => ({ id: p, label: p, handleType: 'acme.t.text' })
  return {
    id,
    type: SUBGRAPH_TYPE,
    ...(parentId ? { parentId } : {}),
    // Boundaries placed, so the normaliser has only the ports and edges to keep.
    data: {
      name: id,
      ports: { inputs: inputs.map(port), outputs: outputs.map(port) },
      inputsAt: { x: -300, y: 0 },
      outputsAt: { x: 300, y: 0 },
    },
  }
}

function node(id: string, parentId?: string): WiringNode {
  return { id, type: 'acme.t.node', ...(parentId ? { parentId } : {}) }
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): WiringEdge {
  return { id, source, sourceHandle, target, targetHandle }
}

// x outside feeds y inside `s` through input port `a`; z inside feeds w
// outside through output port `b`; `x → w` is direct.
const nodes = [node('x'), node('w'), subgraph('s', ['a'], ['b']), node('y', 's'), node('z', 's')]
const edges = [
  edge('direct', 'x', 'out', 'w', 'in'),
  edge('outer-in', 'x', 'out', 's', 'in-a'),
  edge('inner-in', 's', 'in-a', 'y', 'in'),
  edge('inner-out', 'z', 'out', 's', 'out-b'),
  edge('outer-out', 's', 'out-b', 'w', 'in'),
]

test('a chain through a port is read as the direct edge it stands for, listing its stored edges', () => {
  assert.deepEqual(wiredEdges({ nodes, edges }), [
    edges[0],
    { ...edges[2], id: 'outer-in>inner-in', source: 'x', sourceHandle: 'out', via: ['outer-in', 'inner-in'] },
    { ...edges[4], id: 'inner-out>outer-out', source: 'z', sourceHandle: 'out', via: ['inner-out', 'outer-out'] },
  ])
})

test('an input passed straight through to an output joins what feeds it to what the output feeds', () => {
  const through = edge('through', 's', 'in-a', 's', 'out-b')
  const graph = { nodes, edges: [edges[1], through, edges[4]] }
  assert.deepEqual(wiredEdges(graph), [
    {
      ...edges[4],
      id: 'outer-in>through>outer-out',
      source: 'x',
      sourceHandle: 'out',
      via: ['outer-in', 'through', 'outer-out'],
    },
  ])
  assert.equal(portEndProblem(nodes, through), null)
  assert.equal(crossLevelRefusal(nodes, through), null)
  assert.equal(normaliseSubgraphs(graph), graph, 'the normaliser keeps it')
  const backwards = edge('backwards', 's', 'out-b', 's', 'in-a')
  assert.match(portEndProblem(nodes, backwards) ?? '', /is an output port: inside the subgraph it is a target/)
})

test('a graph without subgraphs gets its own edge list back', () => {
  const plain = { nodes: [node('x'), node('w')], edges: [edges[0]] }
  assert.equal(wiredEdges(plain), plain.edges)
})

test('the join is computed once per edge list and node list', () => {
  const graph = { nodes, edges }
  assert.equal(wiredEdges(graph), wiredEdges({ nodes, edges }))
  assert.notEqual(wiredEdges(graph), wiredEdges({ nodes: [...nodes], edges }))
})

test('chains through nested subgraphs and from one subgraph into another reach the real ends', () => {
  const nested = [
    node('x'),
    subgraph('s1', ['a'], ['o']),
    subgraph('s2', ['b'], [], 's1'),
    node('y', 's2'),
    subgraph('s3', ['c'], []),
    node('v', 's3'),
    node('z', 's1'),
  ]
  const chain = [
    edge('1', 'x', 'out', 's1', 'in-a'),
    edge('2', 's1', 'in-a', 's2', 'in-b'),
    edge('3', 's2', 'in-b', 'y', 'in'),
    edge('4', 'z', 'out', 's1', 'out-o'),
    edge('5', 's1', 'out-o', 's3', 'in-c'),
    edge('6', 's3', 'in-c', 'v', 'in'),
  ]
  const wired = wiredEdges({ nodes: nested, edges: chain })
  assert.deepEqual(
    wired.map((e) => [e.source, e.target, e.via]),
    [
      ['x', 'y', ['1', '2', '3']],
      ['z', 'v', ['4', '5', '6']],
    ],
  )
})

test('a port fans out to every inner edge on it, and a port with one side unwired gives nothing', () => {
  const fan = [...edges.slice(0, 3), edge('inner-in-2', 's', 'in-a', 'z', 'in')]
  assert.deepEqual(
    wiredEdges({ nodes, edges: fan }).map((e) => e.id),
    ['direct', 'outer-in>inner-in', 'outer-in>inner-in-2'],
  )
  assert.deepEqual(
    wiredEdges({ nodes, edges: [edges[1], edges[3]] }).map((e) => e.id),
    [],
  )
})

test('an edge between two levels is refused, naming the port route; port edges are allowed', () => {
  const refusal = crossLevelRefusal(nodes, { source: 'x', sourceHandle: 'out', target: 'y', targetHandle: 'in' })
  assert.match(refusal ?? '', /x is on the top level and y on subgraph s/)
  assert.match(refusal ?? '', /<subgraph>\/in-<port>/)
  for (const e of edges) {
    assert.equal(crossLevelRefusal(nodes, e), null, e.id)
  }
})

test('a port end must name a port that exists, on the side the edge is on', () => {
  for (const e of edges) {
    assert.equal(portEndProblem(nodes, e), null, e.id)
  }
  assert.match(portEndProblem(nodes, edge('e', 'x', 'out', 's', 'in-nope')) ?? '', /not a port of subgraph s/)
  assert.match(
    portEndProblem(nodes, edge('e', 'x', 'out', 's', 'out-b')) ?? '',
    /s\/out-b is an output port: outside the subgraph it is a source, not a target/,
  )
  assert.match(
    portEndProblem(nodes, edge('e', 's', 'out-b', 'y', 'in')) ?? '',
    /s\/out-b is an output port: inside the subgraph it is a target, not a source/,
  )
})

test('the normaliser drops the edges of a removed port and edges between levels, and duplicate ports', () => {
  const removed = nodes.map((n) => (n.id === 's' ? subgraph('s', [], ['b', 'b']) : n))
  const crossing = edge('crossing', 'x', 'out', 'y', 'in')
  const next = normaliseSubgraphs({ nodes: removed, edges: [...edges, crossing] })
  assert.deepEqual(
    next.edges.map((e) => (e as WiringEdge).id),
    ['direct', 'inner-out', 'outer-out'],
  )
  const s = next.nodes.find((n) => (n as WiringNode).id === 's') as WiringNode
  assert.deepEqual(
    (s.data as { ports: { outputs: Array<{ id: string }> } }).ports.outputs.map((p) => p.id),
    ['b'],
  )
  const whole = { nodes, edges }
  assert.equal(normaliseSubgraphs(whole), whole)
})

test('the normaliser drops an edge from a subgraph handle that is no port, and keeps data it does not read', () => {
  const s = subgraph('s', ['a'], ['b'])
  const extra = { ...s, data: { ...(s.data as Record<string, unknown>), actions: [{ id: 'go', label: 'Go' }] } }
  const stored = nodes.map((n) => (n.id === 's' ? extra : n))
  const fromNoPort = edge('no-port', 's', 'act-go', 'y', 'run')
  const next = normaliseSubgraphs({ nodes: stored, edges: [...edges, fromNoPort] })
  assert.deepEqual(
    next.edges.map((e) => (e as WiringEdge).id),
    edges.map((e) => e.id),
  )
  const kept = next.nodes.find((n) => (n as WiringNode).id === 's') as WiringNode
  assert.deepEqual((kept.data as { actions?: unknown }).actions, [{ id: 'go', label: 'Go' }])
  assert.deepEqual(
    wiredEdges({ nodes: stored, edges: [...edges, fromNoPort] }).map((e) => e.id),
    ['direct', 'outer-in>inner-in', 'inner-out>outer-out'],
  )
})

test('the normaliser keeps a port id once across inputs and outputs, the input first', () => {
  const clashing = nodes.map((n) => (n.id === 's' ? subgraph('s', ['a'], ['a', 'b']) : n))
  const next = normaliseSubgraphs({ nodes: clashing, edges })
  const s = next.nodes.find((n) => (n as WiringNode).id === 's') as WiringNode
  const ports = (s.data as { ports: Record<'inputs' | 'outputs', Array<{ id: string }>> }).ports
  assert.deepEqual([ports.inputs.map((p) => p.id), ports.outputs.map((p) => p.id)], [['a'], ['b']])
})
