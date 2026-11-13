import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { NO_ENUMS } from '@opencroft/core/values'

import {
  graphsReadingChanges,
  graphsReadingMoved,
  graphsReadingRemoved,
  type InstanceGraph,
  nodeCheckPass,
} from '@/app/_authed/(extension-runtime)/_server/node-check-instance'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

// What the passes record is kept for the process, so every test uses graph ids of its own.
const suffix = crypto.randomUUID().slice(0, 8)
const id = (name: string) => `${name}-${suffix}`

const LAMP = 'acme.lights.lamp'
const SWITCH = 'acme.lights.switch'
const OTHER = 'other.kit.lamp'

function graphOf(nodes: { id: string; type: string; data?: Record<string, unknown> }[], edges: unknown[] = []) {
  return { nodes: nodes.map((n) => ({ position: { x: 0, y: 0 }, data: {}, ...n })), edges } as unknown as GraphData
}

function entry(name: string, graph: GraphData): InstanceGraph {
  return { id: id(name), address: `space.${name}`, graph }
}

test("nodesOfType reads the calling extension's own type on every graph, with each node's graph and edges", () => {
  const one = entry(
    'one',
    graphOf(
      [
        { id: 'l1', type: LAMP, data: { on: true } },
        { id: 's1', type: SWITCH },
      ],
      [{ id: 'e1', source: 's1', target: 'l1', sourceHandle: 'out', targetHandle: 'in', data: { big: 'x' } }],
    ),
  )
  const two = entry('two', graphOf([{ id: 'l2', type: LAMP }]))
  const pass = nodeCheckPass(undefined, NO_ENUMS, () => [one, two])
  assert.deepEqual(pass.instanceFor('acme.lights').nodesOfType('lamp'), [
    {
      id: 'l1',
      data: { on: true },
      graph: 'space.one',
      edges: [{ source: 's1', target: 'l1', sourceHandle: 'out', targetHandle: 'in' }],
    },
    { id: 'l2', data: {}, graph: 'space.two', edges: [] },
  ])
})

test("another extension's nodes are not in the view, of the same bare type or named by a qualified type", () => {
  const one = entry(
    'own',
    graphOf([
      { id: 'l1', type: LAMP },
      { id: 'o1', type: OTHER },
    ]),
  )
  const view = nodeCheckPass(undefined, NO_ENUMS, () => [one]).instanceFor('acme.lights')
  assert.deepEqual(
    view.nodesOfType('lamp').map((r) => r.id),
    ['l1'],
  )
  assert.deepEqual(view.nodesOfType(OTHER), [])
  assert.deepEqual(
    nodeCheckPass(undefined, NO_ENUMS, () => [one])
      .instanceFor('other.kit')
      .nodesOfType('lamp')
      .map((r) => r.id),
    ['o1'],
    'CONTROL: the other extension sees its own',
  )
})

test('the graph being checked replaces its registry copy: each node once, as it is being written', () => {
  const stored = entry(
    'checked',
    graphOf([
      { id: 'l1', type: LAMP, data: { on: false } },
      { id: 'gone', type: LAMP },
    ]),
  )
  const written = { ...stored, graph: graphOf([{ id: 'l1', type: LAMP, data: { on: true } }]) }
  const view = nodeCheckPass(written, NO_ENUMS, () => [stored]).instanceFor('acme.lights')
  assert.deepEqual(view.nodesOfType('lamp'), [{ id: 'l1', data: { on: true }, graph: 'space.checked', edges: [] }])
})

test('the records are frozen copies: a check can change neither them nor the graph', () => {
  const source = graphOf([{ id: 'l1', type: LAMP, data: { nested: { on: true } } }])
  const [record] = nodeCheckPass(undefined, NO_ENUMS, () => [entry('frozen', source)])
    .instanceFor('acme.lights')
    .nodesOfType('lamp')
  assert.throws(() => {
    ;(record.data.nested as { on: boolean }).on = false
  }, TypeError)
  assert.throws(() => {
    ;(record.edges as unknown[]).push({})
  }, TypeError)
  const node = (source.nodes as unknown as { data: { nested: { on: boolean } } }[])[0]
  assert.equal(Object.isFrozen(node.data), false, 'the graph itself is not frozen')
  node.data.nested.on = false
  assert.equal((record.data.nested as { on: boolean }).on, true, 'and the record is not the graph')
})

test('the instance is read at most once per pass, and not at all when no check asks', () => {
  let reads = 0
  const graphs = () => {
    reads++
    return [
      entry(
        'counted',
        graphOf([
          { id: 'l1', type: LAMP },
          { id: 's1', type: SWITCH },
        ]),
      ),
    ]
  }
  nodeCheckPass(undefined, NO_ENUMS, graphs).finish()
  assert.equal(reads, 0)

  const pass = nodeCheckPass(undefined, NO_ENUMS, graphs)
  const view = pass.instanceFor('acme.lights')
  const first = view.nodesOfType('lamp')
  view.nodesOfType('switch')
  assert.equal(pass.instanceFor('acme.lights').nodesOfType('lamp'), first, 'a type is copied once')
  assert.equal(reads, 1)
})

test('a finished pass records what its graph depends on: a change of a type it read elsewhere', () => {
  const reader = entry('reader', graphOf([{ id: 'l1', type: LAMP }]))
  const pass = nodeCheckPass(reader, NO_ENUMS, () => [])
  pass.instanceFor('acme.lights').nodesOfType('lamp')
  pass.finish()
  const idle = entry('idle', graphOf([{ id: 'l9', type: LAMP }]))
  nodeCheckPass(idle, NO_ENUMS, () => []).finish()

  const before = graphOf([
    { id: 'l2', type: LAMP },
    { id: 's2', type: SWITCH },
  ])
  const after = graphOf([{ id: 's2', type: SWITCH, data: { on: true } }])
  assert.deepEqual(
    graphsReadingChanges(id('writer'), before, after, { nodeIds: ['l2'], edgeIds: [] }),
    [reader.id],
    'a lamp removed',
  )
  assert.deepEqual(
    graphsReadingChanges(id('writer'), before, after, { nodeIds: ['s2'], edgeIds: [] }),
    [],
    'a switch changed',
  )
  assert.deepEqual(
    graphsReadingChanges(reader.id, before, after, { nodeIds: ['l2'], edgeIds: [] }),
    [],
    "a graph's own change is its own",
  )
  assert.deepEqual(graphsReadingChanges(id('writer'), before, after, { nodeIds: [], edgeIds: [] }), [])
})

test('a change to an edge alone is a change to the nodes at its ends, and not when only its data changed', () => {
  const reader = entry('edge-reader', graphOf([]))
  const pass = nodeCheckPass(reader, NO_ENUMS, () => [])
  pass.instanceFor('acme.lights').nodesOfType('relay')
  pass.finish()

  const nodes = [
    { id: 'l1', type: 'acme.lights.relay' },
    { id: 's1', type: SWITCH },
    { id: 's2', type: SWITCH },
  ]
  const wired = graphOf(nodes, [{ id: 'e1', source: 's1', target: 'l1', targetHandle: 'in' }])
  const rewired = graphOf(nodes, [{ id: 'e1', source: 's2', target: 'l1', targetHandle: 'in' }])
  const relabelled = graphOf(nodes, [{ id: 'e1', source: 's1', target: 'l1', targetHandle: 'in', data: { x: 1 } }])
  const bare = graphOf(nodes)
  const edge = { nodeIds: [], edgeIds: ['e1'] }
  assert.deepEqual(graphsReadingChanges(id('writer'), bare, wired, edge), [reader.id], 'connected')
  assert.deepEqual(graphsReadingChanges(id('writer'), wired, bare, edge), [reader.id], 'disconnected')
  assert.deepEqual(graphsReadingChanges(id('writer'), wired, rewired, edge), [reader.id], 'its end moved')
  assert.deepEqual(graphsReadingChanges(id('writer'), wired, relabelled, edge), [], 'its data alone changed')

  const switches = graphOf(nodes, [{ id: 'e2', source: 's1', target: 's2' }])
  assert.deepEqual(
    graphsReadingChanges(id('writer'), bare, switches, { nodeIds: [], edgeIds: ['e2'] }),
    [],
    'between switches',
  )
})

test('a pass with no graph records nothing', () => {
  const pass = nodeCheckPass(undefined, NO_ENUMS, () => [])
  pass.instanceFor('acme.lights').nodesOfType('switch')
  pass.finish()
  const before = graphOf([{ id: 's1', type: SWITCH }])
  assert.deepEqual(graphsReadingChanges(id('anywhere'), before, graphOf([]), { nodeIds: ['s1'], edgeIds: [] }), [])
})

test('deleting a graph gives the graphs that read a type it held, and forgets what it read', () => {
  const reader = entry('switch-reader', graphOf([]))
  const readerPass = nodeCheckPass(reader, NO_ENUMS, () => [])
  readerPass.instanceFor('acme.lights').nodesOfType('switch')
  readerPass.finish()
  const holder = entry('switch-holder', graphOf([{ id: 's1', type: SWITCH }]))
  const holderPass = nodeCheckPass(holder, NO_ENUMS, () => [])
  holderPass.instanceFor('acme.lights').nodesOfType('switch')
  holderPass.finish()
  const fuses = entry('fuse-holder', graphOf([{ id: 'f1', type: 'acme.lights.fuse' }]))
  nodeCheckPass(fuses, NO_ENUMS, () => []).finish()

  assert.deepEqual(graphsReadingRemoved([fuses.id]), [], 'nobody reads fuses')
  assert.deepEqual(graphsReadingRemoved([holder.id]), [reader.id])
  const before = graphOf([{ id: 's2', type: SWITCH }])
  assert.deepEqual(
    graphsReadingChanges(id('elsewhere'), before, graphOf([]), { nodeIds: ['s2'], edgeIds: [] }),
    [reader.id],
    'the holder is forgotten',
  )
})

test('a graph taking a new address gives the graphs that read a type it holds, itself among them', () => {
  const PLUG = 'acme.lights.plug'
  const reader = entry('plug-reader', graphOf([]))
  const readerPass = nodeCheckPass(reader, NO_ENUMS, () => [])
  readerPass.instanceFor('acme.lights').nodesOfType('plug')
  readerPass.finish()
  const holder = entry('plug-holder', graphOf([{ id: 'p1', type: PLUG }]))
  const holderPass = nodeCheckPass(holder, NO_ENUMS, () => [])
  holderPass.instanceFor('acme.lights').nodesOfType('plug')
  holderPass.finish()
  const bulbs = entry('bulb-holder', graphOf([{ id: 'b1', type: 'acme.lights.bulb' }]))
  nodeCheckPass(bulbs, NO_ENUMS, () => []).finish()
  const graphs = () => [reader, holder, bulbs]

  assert.deepEqual(graphsReadingMoved([bulbs.id], graphs), [], 'nobody reads bulbs')
  assert.deepEqual(
    graphsReadingMoved([holder.id], graphs).sort(),
    [reader.id, holder.id].sort(),
    'its own records carry its address too',
  )
  assert.deepEqual(graphsReadingMoved([reader.id], graphs), [], 'CONTROL: the reader holds no plug')
})

test("the view tells a check the pass's enums", () => {
  const cases = [{ value: 'png' }]
  const pass = nodeCheckPass(
    undefined,
    (type) => (type === 'acme.images.format' ? cases : undefined),
    () => [],
  )
  const view = pass.instanceFor('acme.lights')
  assert.equal(view.enumCasesOf('acme.images.format'), cases)
  assert.equal(view.enumCasesOf('acme.images.size'), undefined)
})

test('deleting a graph no pass recorded gives every graph that reads anything', () => {
  const reader = entry('any-reader', graphOf([]))
  const pass = nodeCheckPass(reader, NO_ENUMS, () => [])
  pass.instanceFor('acme.lights').nodesOfType('dimmer')
  pass.finish()
  assert.ok(graphsReadingRemoved([id('never-checked')]).includes(reader.id))
})
