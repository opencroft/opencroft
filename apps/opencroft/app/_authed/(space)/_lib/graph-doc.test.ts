// The mapping between a plain graph and its Yjs doc. What is pinned here is
// what every reader of a graph relies on once the doc is the source of truth:
// a graph read back is the graph written, element order included; React Flow
// gets parents before children; and writing a graph changes only what
// differs, so a concurrent writer's change to another field survives.

import assert from 'node:assert/strict'
import test from 'node:test'

import * as Y from 'yjs'

import {
  applyGraphChange,
  applyGraphToDoc,
  graphNodes,
  jsonEqual,
  readGraphFromDoc,
  sameEdge,
  sameNode,
} from '@/app/_authed/(space)/_lib/graph-doc'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

function sample(): GraphData {
  return {
    nodes: [
      { id: 'section-1', type: 'acme.kit.section', position: { x: 0, y: 0 }, style: { width: 400 }, data: {} },
      {
        id: 'node-a',
        type: 'acme.kit.script',
        position: { x: 10, y: 20 },
        parentId: 'section-1',
        data: { label: 'A', code: 'echo a', entries: [{ at: 1 }] },
      },
      { id: 'node-b', type: 'acme.kit.log', position: { x: 200, y: 20 }, data: { label: 'B' } },
    ],
    edges: [
      { id: 'edge-2', source: 'node-a', target: 'node-b', sourceHandle: 'out', targetHandle: 'in' },
      { id: 'edge-1', source: 'node-b', target: 'node-a', sourceHandle: 'out', targetHandle: 'in' },
    ],
  }
}

// Two docs exchanging every update, as a client and the server do.
function syncedPair(): [Y.Doc, Y.Doc] {
  const a = new Y.Doc()
  const b = new Y.Doc()
  a.on('update', (update: Uint8Array, origin: unknown) => origin !== b && Y.applyUpdate(b, update, a))
  b.on('update', (update: Uint8Array, origin: unknown) => origin !== a && Y.applyUpdate(a, update, b))
  return [a, b]
}

test('a graph written to a fresh doc reads back identical, in its original order', () => {
  const doc = new Y.Doc()
  applyGraphToDoc(doc, sample())
  assert.deepEqual(readGraphFromDoc(doc), sample())
})

test('the doc state carries the graph to another doc', () => {
  const doc = new Y.Doc()
  applyGraphToDoc(doc, sample())
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  assert.deepEqual(readGraphFromDoc(copy), sample())
})

test('a node is read after its parent even when stored before it', () => {
  const graph = sample()
  graph.nodes = [graph.nodes[1], graph.nodes[2], graph.nodes[0]]
  const doc = new Y.Doc()
  applyGraphToDoc(doc, graph)
  assert.deepEqual(
    readGraphFromDoc(doc).nodes.map((n) => n.id),
    ['section-1', 'node-a', 'node-b'],
  )
})

test('a parent cycle does not drop or repeat nodes', () => {
  const doc = new Y.Doc()
  applyGraphToDoc(doc, {
    nodes: [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ],
    edges: [],
  })
  const ids = readGraphFromDoc(doc).nodes.map((n) => n.id)
  assert.deepEqual(ids.sort(), ['x', 'y'])
})

test('writing the graph the doc already holds produces no update', () => {
  const doc = new Y.Doc()
  applyGraphToDoc(doc, sample())
  let updates = 0
  doc.on('update', () => updates++)
  applyGraphToDoc(doc, sample())
  assert.equal(updates, 0)
})

// Key-value rows a user put in order (an environment's variables, a
// container's labels) are kept as an object in that order.
test('a data value whose keys only moved is written, and its new order reaches another doc', () => {
  const graph = (env: Record<string, string>): GraphData => ({
    nodes: [{ id: 'app', type: 'acme.kit.app', data: { label: 'App', env } }],
    edges: [],
  })
  const doc = new Y.Doc()
  applyGraphToDoc(doc, graph({ FIRST: '1', SECOND: '2', THIRD: '3' }))
  applyGraphToDoc(doc, graph({ THIRD: '3', FIRST: '1', SECOND: '2' }))
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
  for (const read of [readGraphFromDoc(doc), readGraphFromDoc(copy)]) {
    assert.deepEqual(Object.keys((read.nodes[0].data as { env: object }).env), ['THIRD', 'FIRST', 'SECOND'])
  }
})

test("a node whose fields or data keys come in another order is not rewritten: the doc's maps keep no order", () => {
  const doc = new Y.Doc()
  applyGraphToDoc(doc, sample())
  const shuffled = sample()
  const { id, type, position, parentId, data } = shuffled.nodes[1]
  const { label, code, entries } = data as Record<string, unknown>
  shuffled.nodes[1] = { data: { entries, code, label }, parentId, position, type, id }
  let updates = 0
  doc.on('update', () => updates++)
  applyGraphToDoc(doc, shuffled)
  assert.equal(updates, 0)
})

test('a new node is appended after the existing ones', () => {
  const doc = new Y.Doc()
  applyGraphToDoc(doc, sample())
  const next = sample()
  next.nodes.unshift({ id: 'node-new', type: 'acme.kit.log', data: {} })
  applyGraphToDoc(doc, next)
  assert.deepEqual(
    readGraphFromDoc(doc).nodes.map((n) => n.id),
    ['section-1', 'node-a', 'node-b', 'node-new'],
  )
})

test('fields, data keys, nodes and edges missing from the next graph are removed', () => {
  const doc = new Y.Doc()
  applyGraphToDoc(doc, sample())
  const next = sample()
  delete next.nodes[1].parentId
  next.nodes[1].data = { label: 'A' }
  next.nodes.pop()
  next.edges = []
  applyGraphToDoc(doc, next)
  assert.deepEqual(readGraphFromDoc(doc), next)
})

// Both writers read the graph first, then write, so the second writes from a
// graph that no longer matches the doc.
function concurrentEdits(change: { a: (g: GraphData) => void; b: (g: GraphData) => void }): [Y.Doc, Y.Doc] {
  const [a, b] = syncedPair()
  applyGraphToDoc(a, sample())
  const baseA = readGraphFromDoc(a)
  const baseB = readGraphFromDoc(b)
  const nextA = readGraphFromDoc(a)
  const nextB = readGraphFromDoc(b)
  change.a(nextA)
  change.b(nextB)
  applyGraphToDoc(a, nextA, { base: baseA })
  applyGraphToDoc(b, nextB, { base: baseB })
  return [a, b]
}

test('two writers changing different data keys of one node both land', () => {
  const [a, b] = concurrentEdits({
    a: (g) => {
      ;(g.nodes[1].data as Record<string, unknown>).label = 'renamed'
    },
    b: (g) => {
      ;(g.nodes[1].data as Record<string, unknown>).code = 'echo b'
    },
  })
  const data = readGraphFromDoc(a).nodes[1].data as Record<string, unknown>
  assert.equal(data.label, 'renamed')
  assert.equal(data.code, 'echo b')
  assert.deepEqual(readGraphFromDoc(a), readGraphFromDoc(b))
})

test("a writer moving a node keeps another writer's concurrent new edge", () => {
  const [, b] = concurrentEdits({
    a: (g) => {
      g.nodes[2].position = { x: 999, y: 0 }
    },
    b: (g) => {
      g.edges.push({ id: 'edge-3', source: 'node-a', target: 'section-1' })
    },
  })
  const merged = readGraphFromDoc(b)
  assert.deepEqual(merged.nodes[2].position, { x: 999, y: 0 })
  assert.ok(merged.edges.some((e) => e.id === 'edge-3'))
})

test('an edit to a node another writer deleted meanwhile does not bring it back', () => {
  const [a, b] = concurrentEdits({
    a: (g) => {
      g.nodes = g.nodes.filter((n) => n.id !== 'node-b')
    },
    b: (g) => {
      ;(g.nodes[2].data as Record<string, unknown>).label = 'edited'
    },
  })
  assert.equal(
    readGraphFromDoc(b).nodes.some((n) => n.id === 'node-b'),
    false,
  )
  assert.deepEqual(readGraphFromDoc(a), readGraphFromDoc(b))
})

test('without a base, a graph read before another write reverts that write', () => {
  // The default base is the doc as it is now, which is only right for a graph
  // derived from the doc in the same transaction.
  const [a, b] = syncedPair()
  applyGraphToDoc(a, sample())
  const stale = readGraphFromDoc(b)
  const renamed = readGraphFromDoc(a)
  ;(renamed.nodes[1].data as Record<string, unknown>).label = 'renamed'
  applyGraphToDoc(a, renamed)
  applyGraphToDoc(b, stale)
  assert.equal((readGraphFromDoc(a).nodes[1].data as Record<string, unknown>).label, 'A')
})

test('mutating a read graph does not change the doc', () => {
  const doc = new Y.Doc()
  applyGraphToDoc(doc, sample())
  const read = readGraphFromDoc(doc)
  ;(read.nodes[1].data as { entries: unknown[] }).entries.push({ at: 2 })
  ;(read.nodes[1].position as { x: number }).x = -1
  assert.deepEqual(readGraphFromDoc(doc), sample())
})

test('a graph with a repeated or missing id is reported as not round-tripping', () => {
  const graph = sample()
  graph.nodes.push({ ...graph.nodes[2], data: { label: 'duplicate' } })
  graph.nodes.push({ type: 'acme.kit.log' })
  const doc = new Y.Doc()
  applyGraphToDoc(doc, graph)
  assert.equal(jsonEqual(readGraphFromDoc(doc), graph), false)
  assert.deepEqual([...graphNodes(doc).keys()].sort(), ['node-a', 'node-b', 'section-1'])
})

test('applyGraphChange applies a change to a newer graph and keeps what only the newer graph holds', () => {
  const before = sample()
  const after = sample()
  ;(after.nodes[1].data as Record<string, unknown>).label = 'mine'
  // Meanwhile someone else renamed node-b and added a node.
  const newer = sample()
  ;(newer.nodes[2].data as Record<string, unknown>).label = 'theirs'
  newer.nodes.push({ id: 'node-new', type: 'acme.kit.log', data: {} })
  const result = applyGraphChange(newer, before, after)
  assert.equal((result.nodes[1].data as Record<string, unknown>).label, 'mine')
  assert.equal((result.nodes[2].data as Record<string, unknown>).label, 'theirs')
  assert.ok(result.nodes.some((n) => n.id === 'node-new'))
})

test('jsonEqual counts key order and array order and ignores undefined fields', () => {
  assert.equal(jsonEqual({ a: 1, c: undefined, b: [1, 2] }, { a: 1, b: [1, 2] }), true)
  assert.equal(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), false)
  assert.equal(jsonEqual({ v: { a: 1, b: 2 } }, { v: { b: 2, a: 1 } }), false)
  assert.equal(jsonEqual({ b: [2, 1] }, { b: [1, 2] }), false)
  assert.equal(jsonEqual({ a: null }, { a: {} }), false)
})

test("sameNode ignores the order of a node's fields and data keys but not of a value's keys", () => {
  const node = { id: 'n', type: 't', data: { label: 'L', env: { A: '1', B: '2' } } }
  assert.equal(sameNode(node, { data: { env: { A: '1', B: '2' }, label: 'L' }, type: 't', id: 'n' }), true)
  assert.equal(sameNode(node, { id: 'n', type: 't', data: { label: 'L', env: { B: '2', A: '1' } } }), false)
  assert.equal(sameNode(node, undefined), false)
  assert.equal(sameNode(undefined, undefined), true)
})

test("sameEdge counts the order of an edge's data keys, which the doc stores whole", () => {
  const edge = { id: 'e', source: 'a', target: 'b', data: { x: 1, y: 2 } }
  assert.equal(sameEdge(edge, { target: 'b', source: 'a', id: 'e', data: { x: 1, y: 2 } }), true)
  assert.equal(sameEdge(edge, { id: 'e', source: 'a', target: 'b', data: { y: 2, x: 1 } }), false)
})
