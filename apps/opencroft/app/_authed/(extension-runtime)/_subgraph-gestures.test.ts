import assert from 'node:assert/strict'
import test from 'node:test'

import { NO_ENUMS } from '@opencroft/core/values'
import * as Y from 'yjs'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { absolutePositions, levelOf } from '@/app/_authed/(extension-runtime)/_frame-tree'
import {
  type ExpandSubgraphOptions,
  expandSubgraph,
  type GestureNode,
  type MakeSubgraphOptions,
  makeSubgraph,
} from '@/app/_authed/(extension-runtime)/_subgraph-gestures'
import type { ExtensionHandle } from '@/app/_authed/(extension-runtime)/_types'
import { type WiringEdge, wiredEdges } from '@/app/_authed/(extension-runtime)/_wired-edges'
import { applyGraphToDoc, readGraphFromDoc } from '@/app/_authed/(space)/_lib/graph-doc'
import { GraphUndo } from '@/app/_authed/(space)/_lib/graph-undo'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

const NODE = 'acme.t.node'
const FRAME = 'acme.t.frame'
const SECTION = 'acme.t.section'

const HANDLES: Record<string, ExtensionHandle[]> = {
  [NODE]: [
    { id: 'in', role: 'target', handleType: 'acme.t.text', label: 'Text' },
    { id: 'many', role: 'target', handleType: 'acme.t.text', label: 'Lines', multiple: true },
    { id: 'out', role: 'source', handleType: 'acme.t.text', label: 'Result' },
  ],
}

function node(id: string, x: number, y: number, parentId?: string): GestureNode {
  return {
    id,
    type: NODE,
    position: { x, y },
    width: 200,
    height: 100,
    ...(parentId ? { parentId } : {}),
  }
}

function edge(id: string, source: string, sourceHandle: string, target: string, targetHandle: string): WiringEdge {
  return { id, source, sourceHandle, target, targetHandle }
}

function options(id = 'sg'): MakeSubgraphOptions<GestureNode> {
  let n = 0
  return {
    subgraph: { id, type: SUBGRAPH_TYPE, position: { x: 0, y: 0 }, data: { name: 'Made' } },
    newId: () => `id${String(n++).padStart(8, '0')}`,
    declared: (type) => HANDLES[type] ?? [],
    enumCasesOf: NO_ENUMS,
  }
}

const expandOptions: ExpandSubgraphOptions<GestureNode> = {
  section: { type: SECTION, data: { label: '', color: 'blue' }, zIndex: -1 },
  newId: () => 'fresh',
}

/** What the graph's wiring reads: each wired edge's ends, sorted. */
function wiring(graph: { nodes: readonly GestureNode[]; edges: readonly WiringEdge[] }): string[] {
  return wiredEdges(graph)
    .map((e) => `${e.source}/${e.sourceHandle} -> ${e.target}/${e.targetHandle}`)
    .sort()
}

function made(result: ReturnType<typeof makeSubgraph<GestureNode, WiringEdge>>) {
  assert.ok(!('refused' in result), 'refused' in result ? result.refused : '')
  return result
}

// x feeds a and b, which feed each other; b feeds w and v. The subgraph is made of a and b,
// placed away from the origin so a mix-up of absolute and relative positions shows.
const nodes = [node('x', -400, -200), node('a', 100, -60), node('b', 100, 200), node('w', 600, 0), node('v', 600, 300)]
const edges = [
  edge('xa', 'x', 'out', 'a', 'in'),
  edge('xb', 'x', 'out', 'b', 'many'),
  edge('ab', 'a', 'out', 'b', 'in'),
  edge('bw', 'b', 'out', 'w', 'in'),
  edge('bv', 'b', 'out', 'v', 'in'),
]

test('making a subgraph keeps what every node is wired to, through one port per distinct source', () => {
  const graph = { nodes, edges }
  const result = made(makeSubgraph(graph, new Set(['a', 'b']), options()))
  assert.deepEqual(wiring(result), wiring(graph))
  assert.equal(result.ports.inputs.length, 1, 'x feeds both through one input port')
  assert.equal(result.ports.outputs.length, 1, 'b feeds w and v through one output port')
  const [input] = result.ports.inputs
  const [output] = result.ports.outputs
  assert.deepEqual(
    { label: input.label, handleType: input.handleType, multiple: input.multiple },
    { label: 'Text', handleType: 'acme.t.text', multiple: undefined },
    'labelled after the topmost inner handle; not multiple while one handle it feeds takes one edge',
  )
  assert.equal(output.label, 'Result')
  // The crossing edges keep their ids on the end they fed; the edge into each port is new.
  const byId = new Map(result.edges.map((e) => [e.id, e]))
  assert.deepEqual(byId.get('xa'), edge('xa', 'sg', `in-${input.id}`, 'a', 'in'))
  assert.deepEqual(byId.get('bw'), edge('bw', 'sg', `out-${output.id}`, 'w', 'in'))
  assert.equal(result.edges.length, edges.length + 2)
})

test('the nodes keep their ids and layout inside, the subgraph standing where a Section around them would', () => {
  const result = made(makeSubgraph({ nodes, edges }, new Set(['a', 'b']), options()))
  const sg = result.nodes.find((n) => n.id === 'sg')
  assert.deepEqual(sg?.position, { x: 90, y: -100 }, 'one grid step left of them, four above')
  const a = result.nodes.find((n) => n.id === 'a')
  const b = result.nodes.find((n) => n.id === 'b')
  assert.deepEqual([a?.parentId, a?.position], ['sg', { x: 10, y: 40 }])
  assert.deepEqual([b?.parentId, b?.position], ['sg', { x: 10, y: 300 }])
  assert.ok(result.nodes.indexOf(sg as GestureNode) < result.nodes.indexOf(a as GestureNode), 'parents first')
  const data = sg?.data as { inputsAt?: unknown; outputsAt?: unknown }
  assert.ok(data.inputsAt && data.outputsAt, 'its boundaries are given their places')
})

test('ports are ordered by where their inner end is drawn, and a label taken is numbered', () => {
  const graph = {
    nodes: [node('x', 0, 0), node('y', 0, 400), node('low', 300, 300), node('high', 300, 0)],
    edges: [edge('yl', 'y', 'out', 'low', 'in'), edge('xh', 'x', 'out', 'high', 'in')],
  }
  const result = made(makeSubgraph(graph, new Set(['low', 'high']), options()))
  assert.deepEqual(
    result.ports.inputs.map((p) => p.label),
    ['Text', 'Text 2'],
  )
  const first = result.edges.find((e) => e.id === 'xh')
  assert.equal(first?.sourceHandle, `in-${result.ports.inputs[0].id}`, 'the top one first')
})

test('an input port takes several edges when every handle it feeds does', () => {
  const graph = { nodes: [node('x', 0, 0), node('a', 300, 0)], edges: [edge('xa', 'x', 'out', 'a', 'many')] }
  const result = made(makeSubgraph(graph, new Set(['a']), options()))
  assert.equal(result.ports.inputs[0].multiple, true)
})

test('an input port made from an edge into an input that takes several types takes them, with the edge’s type', () => {
  const nodes: GestureNode[] = [
    { id: 't', type: 'builtin.core.value', position: { x: 0, y: 0 }, data: { value: 'draft' } },
    { id: 'sw', type: 'builtin.core.switch', position: { x: 300, y: 0 }, data: {} },
  ]
  const graph = { nodes, edges: [edge('tsw', 't', 'value', 'sw', 'condition')] }
  const result = made(makeSubgraph(graph, new Set(['sw']), options()))
  assert.deepEqual(result.ports.inputs[0].accepts, ['builtin.core.boolean', 'builtin.core.string'])
  assert.equal(result.ports.inputs[0].handleType, 'builtin.core.string')
})

test('a selected frame takes its members, which keep their place in it', () => {
  const frame: GestureNode = { id: 'f', type: FRAME, position: { x: 200, y: 200 }, style: { width: 400, height: 300 } }
  const graph = {
    nodes: [frame, node('m', 20, 40, 'f'), node('out', 900, 0)],
    edges: [edge('mo', 'm', 'out', 'out', 'in')],
  }
  const result = made(makeSubgraph(graph, new Set(['f']), options()))
  const byId = new Map(result.nodes.map((n) => [n.id, n]))
  assert.equal(byId.get('f')?.parentId, 'sg')
  assert.deepEqual([byId.get('m')?.parentId, byId.get('m')?.position], ['f', { x: 20, y: 40 }])
  assert.equal(levelOf('m', byId), 'sg')
  assert.deepEqual(wiring(result), wiring(graph))
})

test('nodes on different levels are refused', () => {
  const graph = {
    nodes: [
      { id: 'outer', type: SUBGRAPH_TYPE, position: { x: 0, y: 0 }, data: {} },
      node('in', 0, 0, 'outer'),
      node('top', 0, 0),
    ],
    edges: [],
  }
  const result = makeSubgraph(graph, new Set(['in', 'top']), options())
  assert.ok('refused' in result && /one level/.test(result.refused))
})

test('inside a subgraph, an edge from its own boundary becomes a port of the new one', () => {
  const outer: GestureNode = {
    id: 'p',
    type: SUBGRAPH_TYPE,
    position: { x: 0, y: 0 },
    data: { name: 'P', ports: { inputs: [{ id: 'a', label: 'A', handleType: 'acme.t.text' }], outputs: [] } },
  }
  const graph = {
    nodes: [node('x', -500, 0), outer, node('y', 100, 100, 'p')],
    edges: [edge('xp', 'x', 'out', 'p', 'in-a'), edge('py', 'p', 'in-a', 'y', 'in')],
  }
  const result = made(makeSubgraph(graph, new Set(['y']), options()))
  const sg = result.nodes.find((n) => n.id === 'sg')
  assert.equal(sg?.parentId, 'p', 'made on the level the nodes were on')
  assert.deepEqual(wiring(result), wiring(graph))
})

test('expanding a made subgraph gives back the edges and the places the nodes were drawn at', () => {
  const graph = { nodes, edges }
  const result = made(makeSubgraph(graph, new Set(['a', 'b']), options()))
  const expanded = expandSubgraph(result, 'sg', expandOptions)
  assert.ok(!('refused' in expanded))
  const sorted = (list: readonly WiringEdge[]) => [...list].sort((p, q) => p.id.localeCompare(q.id))
  assert.deepEqual(sorted(expanded.edges), sorted(edges))
  const drawn = absolutePositions(expanded.nodes)
  for (const id of ['a', 'b']) {
    assert.deepEqual(drawn.get(id), nodes.find((n) => n.id === id)?.position, id)
  }
  const section = expanded.nodes.find((n) => n.id === 'sg')
  assert.equal(section?.type, SECTION)
  assert.deepEqual(section?.data, { label: 'Made', color: 'blue' })
  assert.deepEqual(section?.style, { width: 220, height: 410 })
  assert.equal(section?.zIndex, -1)
})

test('expanding keeps the subgraphs inside, and joins chains only through its own ports', () => {
  const port = (id: string) => ({ id, label: id, handleType: 'acme.t.text' })
  const sg = (id: string, parentId?: string): GestureNode => ({
    id,
    type: SUBGRAPH_TYPE,
    position: { x: 300, y: 300 },
    ...(parentId ? { parentId } : {}),
    data: { name: id, ports: { inputs: [port('i')], outputs: [] } },
  })
  const graph = {
    nodes: [node('x', 0, 0), sg('outer'), sg('inner', 'outer'), node('y', 600, 600, 'inner')],
    edges: [
      edge('x-outer', 'x', 'out', 'outer', 'in-i'),
      edge('outer-inner', 'outer', 'in-i', 'inner', 'in-i'),
      edge('inner-y', 'inner', 'in-i', 'y', 'in'),
    ],
  }
  const expanded = expandSubgraph(graph, 'outer', expandOptions)
  assert.ok(!('refused' in expanded))
  assert.equal(expanded.nodes.find((n) => n.id === 'inner')?.type, SUBGRAPH_TYPE)
  assert.deepEqual(
    expanded.edges.find((e) => e.id === 'outer-inner'),
    edge('outer-inner', 'x', 'out', 'inner', 'in-i'),
  )
  assert.deepEqual(wiring(expanded), wiring(graph))
})

test('expanding an input passed straight through to an output gives the direct edge', () => {
  const port = (id: string) => ({ id, label: id, handleType: 'acme.t.text' })
  const graph = {
    nodes: [
      node('x', 0, 0),
      node('w', 600, 0),
      {
        id: 'sg',
        type: SUBGRAPH_TYPE,
        position: { x: 300, y: 0 },
        data: { name: 'Through', ports: { inputs: [port('i')], outputs: [port('o')] } },
      },
    ],
    edges: [
      edge('x-sg', 'x', 'out', 'sg', 'in-i'),
      edge('through', 'sg', 'in-i', 'sg', 'out-o'),
      edge('sg-w', 'sg', 'out-o', 'w', 'in'),
    ],
  }
  const expanded = expandSubgraph(graph, 'sg', expandOptions)
  assert.ok(!('refused' in expanded))
  assert.deepEqual(expanded.edges, [edge('sg-w', 'x', 'out', 'w', 'in')])
  assert.deepEqual(wiring(expanded), wiring(graph))
})

test('expanding a pass-through beside the same direct edge keeps that edge once', () => {
  const port = (id: string) => ({ id, label: id, handleType: 'acme.t.text' })
  const graph = {
    nodes: [
      node('x', 0, 0),
      node('w', 600, 0),
      {
        id: 'sg',
        type: SUBGRAPH_TYPE,
        position: { x: 300, y: 0 },
        data: { name: 'Through', ports: { inputs: [port('i'), port('j')], outputs: [port('o'), port('p')] } },
      },
    ],
    edges: [
      edge('direct', 'x', 'out', 'w', 'in'),
      edge('x-sg', 'x', 'out', 'sg', 'in-i'),
      edge('x-sg-j', 'x', 'out', 'sg', 'in-j'),
      edge('through-i', 'sg', 'in-i', 'sg', 'out-o'),
      edge('through-j', 'sg', 'in-j', 'sg', 'out-p'),
      edge('sg-w', 'sg', 'out-o', 'w', 'in'),
      edge('sg-w-p', 'sg', 'out-p', 'w', 'in'),
    ],
  }
  const expanded = expandSubgraph(graph, 'sg', expandOptions)
  assert.ok(!('refused' in expanded))
  assert.deepEqual(expanded.edges, [edge('direct', 'x', 'out', 'w', 'in')])
})

test('expanding a node that is no subgraph is refused', () => {
  const result = expandSubgraph({ nodes: [node('x', 0, 0)], edges: [] }, 'x', expandOptions)
  assert.ok('refused' in result)
})

test('each undo of a make and an expand gives back the graph before it, and each redo the graph after', () => {
  type Graph = { nodes: GestureNode[]; edges: WiringEdge[] }
  const doc = new Y.Doc()
  const me = {}
  applyGraphToDoc(doc, { nodes, edges } as unknown as GraphData)
  const history = new GraphUndo(doc, me)
  const read = () => readGraphFromDoc(doc) as unknown as Graph
  const write = (next: Graph) => {
    history.beginStep()
    applyGraphToDoc(doc, next as unknown as GraphData, { base: readGraphFromDoc(doc), origin: me })
  }
  const start = read()
  write(made(makeSubgraph(start, new Set(['a', 'b']), options())))
  const afterMake = read()
  const expanded = expandSubgraph(afterMake, 'sg', expandOptions)
  assert.ok(!('refused' in expanded))
  write(expanded)
  const afterExpand = read()
  const nothingKept = { applied: true, keptNodeIds: [] }
  for (const round of [1, 2]) {
    assert.deepEqual(history.undo(), nothingKept, `round ${round}: undo expand`)
    assert.deepEqual(read(), afterMake, `round ${round}: after undo of expand`)
    assert.deepEqual(history.undo(), nothingKept, `round ${round}: undo make`)
    assert.deepEqual(read(), start, `round ${round}: after undo of make`)
    assert.deepEqual(history.redo(), nothingKept, `round ${round}: redo make`)
    assert.deepEqual(read(), afterMake, `round ${round}: after redo of make`)
    assert.deepEqual(history.redo(), nothingKept, `round ${round}: redo expand`)
    assert.deepEqual(read(), afterExpand, `round ${round}: after redo of expand`)
  }
})
