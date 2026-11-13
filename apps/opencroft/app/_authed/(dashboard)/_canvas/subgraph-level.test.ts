import assert from 'node:assert/strict'
import test from 'node:test'

import { BOOLEAN_TYPE, NO_ENUMS, NUMBER_TYPE, STRING_TYPE } from '@opencroft/core/values'
import type { Edge, Node } from '@xyflow/react'

import {
  addPort,
  boundaryId,
  boundaryOf,
  canvasHandles,
  edgesKeptByPorts,
  edgesOnCanvas,
  handlesConnect,
  levelName,
  levelPath,
  levelsChanged,
  NEW_PORT_HANDLE,
  narrowedInput,
  nodesOnLevel,
  slotConnection,
  storedConnection,
} from '@/app/_authed/(dashboard)/_canvas/subgraph-level'
import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { byIdOf } from '@/app/_authed/(extension-runtime)/_frame-tree'

const TEXT = 'acme.t.text'

function subgraph(id: string, parentId?: string, inputs: string[] = ['a']): Node {
  return {
    id,
    type: SUBGRAPH_TYPE,
    position: { x: -200, y: 300 },
    ...(parentId ? { parentId } : {}),
    data: {
      name: `Sub ${id}`,
      ports: { inputs: inputs.map((p) => ({ id: p, label: p, handleType: TEXT })), outputs: [] },
    },
  }
}

function card(id: string, parentId?: string): Node {
  return { id, type: 'acme.t.card', position: { x: -40, y: 60 }, data: {}, ...(parentId ? { parentId } : {}) }
}

// `outer` at the top holds `inner`, which holds `deep`; `top` and `x` are on the top level.
const nodes = [card('top'), subgraph('outer'), card('x', 'outer'), subgraph('inner', 'outer'), card('deep', 'inner')]
const NO_SIZES = new Map<string, { width: number; height: number }>()
const shown = (flow: Node[]) =>
  flow
    .filter((n) => !n.hidden)
    .map((n) => n.id)
    .sort()

test('the top level shows its own nodes; every subgraph has its boundaries, hidden', () => {
  const flow = nodesOnLevel(nodes, undefined, NO_SIZES)
  assert.deepEqual(shown(flow), ['outer', 'top'])
  assert.ok(flow.some((n) => n.id === boundaryId('inner', 'inputs') && n.hidden))
})

test("a subgraph's canvas shows its members, without their parent, and its boundaries", () => {
  const flow = nodesOnLevel(nodes, 'outer', NO_SIZES)
  assert.deepEqual(shown(flow), [boundaryId('outer', 'inputs'), boundaryId('outer', 'outputs'), 'inner', 'x'].sort())
  const x = flow.find((n) => n.id === 'x') as Node
  assert.equal(x.parentId, undefined, 'drawn on the canvas plane, which is the subgraph’s')
  assert.deepEqual(x.position, { x: -40, y: 60 })
  assert.equal((flow.find((n) => n.id === 'deep') as Node).parentId, 'inner', 'a deeper member keeps its parent')
})

test('a boundary stands beside the members until it is put somewhere', () => {
  const flow = nodesOnLevel(nodes, 'outer', NO_SIZES)
  const inputs = flow.find((n) => n.id === boundaryId('outer', 'inputs')) as Node
  const outputs = flow.find((n) => n.id === boundaryId('outer', 'outputs')) as Node
  assert.ok(inputs.position.x < -40, 'left of the members')
  assert.ok(outputs.position.x > -40, 'right of them')
  assert.equal(inputs.position.y, 60)
  const placed = nodes.map((n) => (n.id === 'outer' ? { ...n, data: { ...n.data, inputsAt: { x: -500, y: -20 } } } : n))
  const moved = nodesOnLevel(placed, 'outer', NO_SIZES).find((n) => n.id === boundaryId('outer', 'inputs')) as Node
  assert.deepEqual(moved.position, { x: -500, y: -20 })
})

test('edges between a subgraph and its members are drawn to its boundaries, and stored back on it', () => {
  const edges: Edge[] = [
    { id: 'outer-in', source: 'top', sourceHandle: 'out', target: 'outer', targetHandle: 'in-a' },
    { id: 'inner-in', source: 'outer', sourceHandle: 'in-a', target: 'x', targetHandle: 'in' },
    { id: 'inner-out', source: 'x', sourceHandle: 'out', target: 'outer', targetHandle: 'out-b' },
  ]
  const flow = edgesOnCanvas(edges, nodes)
  assert.equal(flow[0], edges[0])
  assert.equal(flow[1].source, boundaryId('outer', 'inputs'))
  assert.equal(flow[2].target, boundaryId('outer', 'outputs'))
  assert.deepEqual(
    storedConnection({ source: flow[1].source, target: 'x', sourceHandle: 'in-a', targetHandle: 'in' }),
    { source: 'outer', target: 'x', sourceHandle: 'in-a', targetHandle: 'in' },
  )
  assert.deepEqual(boundaryOf(boundaryId('outer', 'outputs')), { subgraphId: 'outer', side: 'outputs' })
  assert.equal(boundaryOf('x'), null)
})

test("a boundary's handles are its side's ports and its empty slot, which connects to any node handle", () => {
  const handles = canvasHandles({ id: boundaryId('outer', 'inputs') } as Node, nodes, () => [], NO_ENUMS)
  assert.deepEqual(
    handles.map((h) => [h.id, h.role]),
    [
      ['in-a', 'source'],
      [NEW_PORT_HANDLE, 'source'],
    ],
  )
  const slot = { nodeId: boundaryId('outer', 'inputs'), handle: handles[1] }
  const inner = { nodeId: 'x', handle: { id: 'in', role: 'target' as const, handleType: TEXT } }
  assert.equal(handlesConnect(slot, inner), true)
  const otherBoundary = {
    nodeId: boundaryId('outer', 'outputs'),
    handle: { id: NEW_PORT_HANDLE, role: 'target' as const, handleType: '' },
  }
  assert.equal(handlesConnect(slot, otherBoundary), false, 'two slots make no port')
  const wrongType = { nodeId: 'x', handle: { id: 'in', role: 'target' as const, handleType: 'acme.t.other' } }
  assert.equal(handlesConnect({ nodeId: 'top', handle: { ...inner.handle, role: 'source' } }, wrongType), false)
})

test('an input passed straight through to an output is drawn inside, from Inputs to Outputs', () => {
  const through: Edge = { id: 'through', source: 'outer', sourceHandle: 'in-a', target: 'outer', targetHandle: 'out-b' }
  const [drawn] = edgesOnCanvas([through], nodes)
  assert.equal(drawn.source, boundaryId('outer', 'inputs'))
  assert.equal(drawn.target, boundaryId('outer', 'outputs'))
  assert.deepEqual(storedConnection(drawn), through)
  assert.deepEqual(levelsChanged({ nodes, edges: [] }, { nodes, edges: [through] }), ['outer'])
})

test("a port on Inputs connects to its own Outputs' empty slot, and to no other boundary's", () => {
  const port = {
    nodeId: boundaryId('outer', 'inputs'),
    handle: { id: 'in-a', role: 'source' as const, handleType: TEXT },
  }
  const slotOf = (subgraphId: string) => ({
    nodeId: boundaryId(subgraphId, 'outputs'),
    handle: { id: NEW_PORT_HANDLE, role: 'target' as const, handleType: '' },
  })
  assert.equal(handlesConnect(port, slotOf('outer')), true)
  assert.equal(handlesConnect(port, slotOf('inner')), false)
  const inputsSlot = { nodeId: boundaryId('outer', 'inputs'), handle: { ...port.handle, id: NEW_PORT_HANDLE } }
  assert.equal(handlesConnect(inputsSlot, slotOf('outer')), false, 'an empty slot passes nothing through')
})

test("a Switch's condition takes a boundary's empty slot, a text and a boolean, and no other type", () => {
  const condition = {
    nodeId: 'sw',
    handle: {
      id: 'condition',
      role: 'target' as const,
      handleType: BOOLEAN_TYPE,
      accepts: [BOOLEAN_TYPE, STRING_TYPE],
    },
  }
  const from = (handleType: string) => ({ nodeId: 'top', handle: { id: 'out', role: 'source' as const, handleType } })
  const [, slot] = canvasHandles({ id: boundaryId('outer', 'inputs') } as Node, nodes, () => [], NO_ENUMS)
  assert.equal(handlesConnect({ nodeId: boundaryId('outer', 'inputs'), handle: slot }, condition), true, 'slot')
  assert.equal(handlesConnect(from(STRING_TYPE), condition), true, 'a text retypes the Switch')
  assert.equal(handlesConnect(from(BOOLEAN_TYPE), condition), true)
  assert.equal(handlesConnect(from(NUMBER_TYPE), condition), false, 'a number is refused')
  const booleanInput = { ...condition, handle: { id: 'on', role: 'target' as const, handleType: BOOLEAN_TYPE } }
  assert.equal(handlesConnect(from(STRING_TYPE), booleanInput), false, 'an input of one type keeps the usual rule')
})

test('while one input of a type group is wired, another of the group takes only the type it has now', () => {
  const branch = (id: string) => ({
    id,
    role: 'target' as const,
    handleType: NUMBER_TYPE,
    accepts: [STRING_TYPE, NUMBER_TYPE, BOOLEAN_TYPE],
    typeGroup: 'value',
  })
  const handles = [branch('true'), branch('false')]
  const from = (handleType: string) => ({ nodeId: 'top', handle: { id: 'out', role: 'source' as const, handleType } })
  const intoFalse = { nodeId: 'sel', handle: handles[1], handles }
  const trueWired = [{ target: 'sel', targetHandle: 'true' }]
  assert.equal(handlesConnect(from(STRING_TYPE), intoFalse, trueWired), false)
  assert.equal(handlesConnect(from(NUMBER_TYPE), intoFalse, trueWired), true)
  assert.equal(handlesConnect(from(STRING_TYPE), intoFalse), true, 'nothing of the group wired')
  assert.equal(
    handlesConnect(from(STRING_TYPE), { ...intoFalse, handle: handles[0] }, trueWired),
    true,
    'an edge into the input itself is replaced',
  )
})

test('an input port that takes several types connects inside where the target takes any of them, and narrows to those', () => {
  const port = {
    nodeId: boundaryId('outer', 'inputs'),
    handle: { id: 'in-a', role: 'source' as const, handleType: BOOLEAN_TYPE, accepts: [BOOLEAN_TYPE, STRING_TYPE] },
  }
  const numberInput = { nodeId: 'x', handle: { id: 'n', role: 'target' as const, handleType: NUMBER_TYPE } }
  const textInput = { nodeId: 'x', handle: { id: 't', role: 'target' as const, handleType: STRING_TYPE } }
  const onOff = { nodeId: 'x', handle: { id: 'b', role: 'target' as const, handleType: BOOLEAN_TYPE } }
  assert.equal(handlesConnect(port, numberInput), false)
  assert.equal(handlesConnect(port, textInput), true)
  const data = {
    name: 'S',
    ports: {
      inputs: [{ id: 'a', label: 'A', handleType: BOOLEAN_TYPE, accepts: [BOOLEAN_TYPE, STRING_TYPE] }],
      outputs: [],
    },
  }
  assert.equal(narrowedInput(data, 'in-a', textInput.handle), data, 'a text input takes both, a boolean as its text')
  const narrowed = narrowedInput(data, 'in-a', onOff.handle) as typeof data
  assert.deepEqual(narrowed.ports.inputs[0], { id: 'a', label: 'A', handleType: BOOLEAN_TYPE })
})

test('a new port takes the inner handle’s type and label, numbered when the label is taken', () => {
  const sub = subgraph('s', undefined, ['a'])
  const first = addPort(
    sub.data,
    'inputs',
    { id: 'in', label: 'a', role: 'target', handleType: TEXT, multiple: true },
    'p1',
  )
  assert.equal(first.handleId, 'in-p1')
  assert.deepEqual(first.data.ports.inputs.at(-1), { id: 'p1', label: 'a 2', handleType: TEXT, multiple: true })
  const out = addPort(sub.data, 'outputs', { id: 'out', role: 'source', handleType: TEXT }, 'p2')
  assert.deepEqual(out.data.ports.outputs, [{ id: 'p2', label: 'out', handleType: TEXT }])
})

test('a new input port made from an input that takes several types takes them too, with the type it has now', () => {
  const branch = {
    id: 'true',
    label: 'True',
    role: 'target' as const,
    handleType: NUMBER_TYPE,
    accepts: [STRING_TYPE, NUMBER_TYPE, BOOLEAN_TYPE],
    typeGroup: 'value',
  }
  const made = addPort(subgraph('s').data, 'inputs', branch, 'p')
  assert.deepEqual(made.data.ports.inputs.at(-1), {
    id: 'p',
    label: 'True',
    handleType: NUMBER_TYPE,
    accepts: [STRING_TYPE, NUMBER_TYPE, BOOLEAN_TYPE],
  })
  const output = addPort(subgraph('s').data, 'outputs', { ...branch, role: 'source' }, 'o')
  assert.equal(output.data.ports.outputs[0].accepts, undefined, 'only an input port takes several types')
})

test('a new input port given choices takes only those, and keeps the inner value only when it is one', () => {
  const condition = { id: 'condition', label: 'Condition', role: 'target' as const, handleType: STRING_TYPE }
  const choices = [{ value: 'llama' }, { value: 'qwen' }]
  const kept = addPort(subgraph('s').data, 'inputs', condition, 'm', 'qwen', choices)
  assert.deepEqual(kept.data.ports.inputs.at(-1)?.options, choices)
  assert.equal((kept.data as { inputs?: Record<string, unknown> }).inputs?.['in-m'], 'qwen')
  const dropped = addPort(subgraph('s').data, 'inputs', condition, 'm', '', choices)
  assert.equal((dropped.data as { inputs?: unknown }).inputs, undefined, 'an empty value is no choice')
  const output = addPort(subgraph('s').data, 'outputs', { ...condition, role: 'source' }, 'o', undefined, choices)
  assert.equal(output.data.ports.outputs[0].options, undefined, 'only an input port has choices')
})

test('an input port stops taking several edges once it feeds a handle that takes one', () => {
  const data = addPort(
    subgraph('s').data,
    'inputs',
    { id: 'in', role: 'target', handleType: TEXT, multiple: true },
    'm',
  ).data
  const single = { id: 'in', role: 'target' as const, handleType: TEXT }
  const narrowed = narrowedInput(data, 'in-m', single) as typeof data
  assert.equal(narrowed.ports.inputs.find((p) => p.id === 'm')?.multiple, undefined)
  assert.equal(narrowedInput(data, 'in-m', { ...single, multiple: true }), data)
})

test('an input port passed through to a new output keeps taking several edges on the card', () => {
  const data = addPort(
    subgraph('s').data,
    'inputs',
    { id: 'in', role: 'target', handleType: TEXT, multiple: true },
    'm',
  ).data
  const conn = {
    source: boundaryId('s', 'inputs'),
    sourceHandle: 'in-m',
    target: boundaryId('s', 'outputs'),
    targetHandle: NEW_PORT_HANDLE,
  }
  const made = slotConnection(conn, data, { id: 'in-m', label: 'in', role: 'source', handleType: TEXT }, 'o')
  assert.deepEqual(made?.stored, { source: 's', sourceHandle: 'in-m', target: 's', targetHandle: 'out-o' })
  assert.deepEqual(made?.data.ports.outputs, [{ id: 'o', label: 'in', handleType: TEXT }])
  assert.equal(made?.data.ports.inputs.find((p) => p.id === 'm')?.multiple, true)
})

test('an edge with no empty slot at either end makes no port', () => {
  const conn = { source: 'top', sourceHandle: 'out', target: boundaryId('s', 'outputs'), targetHandle: 'out-o' }
  assert.equal(slotConnection(conn, subgraph('s').data, { id: 'out', role: 'source', handleType: TEXT }, 'n'), null)
})

test('the path runs from the graph through each subgraph to the open one', () => {
  assert.deepEqual(levelPath(nodes, 'inner', 'Graph', ''), [
    { id: '', label: 'Graph' },
    { id: 'outer', label: 'Sub outer' },
    { id: 'inner', label: 'Sub inner' },
  ])
  assert.deepEqual(levelPath(nodes, undefined, 'Graph', ''), [{ id: '', label: 'Graph' }])
})

test("a level's name for Find is its subgraphs' names, outermost first, or the graph's for the top level", () => {
  const byId = byIdOf(nodes)
  assert.equal(levelName('inner', byId, 'Graph'), 'Sub outer / Sub inner')
  assert.equal(levelName('outer', byId, 'Graph'), 'Sub outer')
  assert.equal(levelName(undefined, byId, 'Graph'), 'Graph')
})

test('a port written away takes its edges on both sides, and only those', () => {
  const edges: Edge[] = [
    { id: 'outside', source: 'top', sourceHandle: 'out', target: 'outer', targetHandle: 'in-a' },
    { id: 'inside', source: 'outer', sourceHandle: 'in-a', target: 'x', targetHandle: 'in' },
    { id: 'kept', source: 'top', sourceHandle: 'out', target: 'outer', targetHandle: 'in-b' },
    { id: 'other', source: 'top', sourceHandle: 'out', target: 'x', targetHandle: 'in' },
  ]
  const ports = { ports: { inputs: [{ id: 'b', label: 'b', handleType: TEXT }], outputs: [] } }
  assert.deepEqual(
    edgesKeptByPorts(edges, 'outer', ports).map((e) => e.id),
    ['kept', 'other'],
  )
  const both = { ports: { inputs: [...ports.ports.inputs, { id: 'a', label: 'a', handleType: TEXT }], outputs: [] } }
  assert.equal(edgesKeptByPorts(edges, 'outer', both), edges, 'a reorder or rename keeps the list itself')
})

test('a change is seen on the level of each node and edge it touched', () => {
  const graph = { nodes, edges: [{ id: 'e', source: 'inner', target: 'deep' }] }
  const moved = { ...graph, nodes: graph.nodes.map((n) => (n.id === 'deep' ? { ...n, position: { x: 0, y: 0 } } : n)) }
  assert.deepEqual(levelsChanged(graph, moved), ['inner'])
  const removed = { ...graph, nodes: graph.nodes.filter((n) => n.id !== 'x') }
  assert.deepEqual(levelsChanged(graph, removed), ['outer'], 'a removed node where it was')
  const unwired = { ...graph, edges: [] }
  assert.deepEqual(levelsChanged(graph, unwired), ['inner'], 'an edge to a member is drawn inside')
  const renamed = { ...graph, nodes: graph.nodes.map((n) => (n.id === 'top' ? { ...n, data: { name: 'T' } } : n)) }
  assert.deepEqual(levelsChanged(graph, renamed), [undefined])
  assert.deepEqual(levelsChanged(graph, graph), [])
})

test("a change to a subgraph's ports is seen on its card and inside it, on Inputs and Outputs", () => {
  const graph = { nodes, edges: [] }
  const withPorts = (inputs: string[]) => ({
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === 'inner' ? subgraph('inner', 'outer', inputs) : n)),
  })
  assert.deepEqual(levelsChanged(withPorts(['a', 'b']), withPorts(['b', 'a'])), ['outer', 'inner'])
  const named = withPorts(['a'])
  const nameOnly = {
    ...named,
    nodes: named.nodes.map((n) => (n.id === 'inner' ? { ...n, data: { ...n.data, name: 'Renamed' } } : n)),
  }
  assert.deepEqual(levelsChanged(named, nameOnly), ['outer'], 'its name is drawn on the card only')
})
