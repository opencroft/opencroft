import assert from 'node:assert/strict'
import test from 'node:test'

import { edgesReplacedBy, feedingEdges } from './_input-edges'
import type { ExtensionHandle } from './_types'

function edge(id: string, source: string, target: string, targetHandle?: string | null) {
  return { id, source, target, targetHandle }
}

const ids = (edges: Array<{ id: string }>) => edges.map((e) => e.id)

test('a handle with one edge is fed by it', () => {
  assert.deepEqual(ids(feedingEdges([edge('e1', 'engine-1', 'app-1', 'engine-in')])), ['e1'])
})

test('a handle with several edges is fed by the first of them only', () => {
  const edges = [
    edge('e1', 'engine-1', 'app-1', 'engine-in'),
    edge('e2', 'engine-2', 'app-1', 'engine-in'),
    edge('e3', 'engine-3', 'app-1', 'engine-in'),
  ]
  assert.deepEqual(ids(feedingEdges(edges)), ['e1'])
})

test('the same handle id on different nodes, and different handles on one node, are fed separately', () => {
  const edges = [
    edge('e1', 'engine-1', 'app-1', 'engine-in'),
    edge('e2', 'engine-2', 'app-1', 'spare-in'),
    edge('e3', 'engine-3', 'app-2', 'engine-in'),
    edge('e4', 'engine-4', 'app-2', 'engine-in'),
  ]
  assert.deepEqual(ids(feedingEdges(edges)), ['e1', 'e2', 'e3'])
})

test('once the first edge is removed, the next one on the handle feeds it', () => {
  const edges = [edge('e1', 'engine-1', 'app-1', 'engine-in'), edge('e2', 'engine-2', 'app-1', 'engine-in')]
  assert.deepEqual(ids(feedingEdges(edges.filter((e) => e.id !== 'e1'))), ['e2'])
})

test('an edge without a target handle feeds nothing and claims nothing', () => {
  const edges = [
    edge('e1', 'engine-1', 'app-1', null),
    edge('e2', 'engine-2', 'app-1'),
    edge('e3', 'engine-3', 'app-1', 'engine-in'),
  ]
  assert.deepEqual(ids(feedingEdges(edges)), ['e3'])
})

test('no edges feed nothing', () => {
  assert.deepEqual(feedingEdges([]), [])
})

const handles: ExtensionHandle[] = [
  { id: 'engine-in', handleType: 'engine', role: 'target' },
  { id: 'spare-in', handleType: 'engine', role: 'target', multiple: true },
  { id: 'engine-out', handleType: 'engine', role: 'source' },
]

test('an edge into an input without multiple replaces every edge already into it', () => {
  const edges = [
    edge('e1', 'engine-1', 'app-1', 'engine-in'),
    edge('e2', 'engine-2', 'app-1', 'engine-in'),
    edge('e3', 'engine-3', 'app-1', 'spare-in'),
    edge('e4', 'engine-4', 'app-2', 'engine-in'),
  ]
  assert.deepEqual(ids(edgesReplacedBy(edges, edge('new', 'engine-5', 'app-1', 'engine-in'), handles)), ['e1', 'e2'])
})

test('an edge into a multiple input replaces nothing', () => {
  const edges = [edge('e1', 'engine-1', 'app-1', 'spare-in')]
  assert.deepEqual(edgesReplacedBy(edges, edge('new', 'engine-2', 'app-1', 'spare-in'), handles), [])
})

test('a handle declared only as a source, an undeclared handle and no handle replace nothing', () => {
  const edges = [
    edge('e1', 'engine-1', 'app-1', 'engine-out'),
    edge('e2', 'engine-1', 'app-1', 'unknown-in'),
    edge('e3', 'engine-1', 'app-1', null),
  ]
  assert.deepEqual(edgesReplacedBy(edges, edge('new', 'engine-2', 'app-1', 'engine-out'), handles), [])
  assert.deepEqual(edgesReplacedBy(edges, edge('new', 'engine-2', 'app-1', 'unknown-in'), handles), [])
  assert.deepEqual(edgesReplacedBy(edges, edge('new', 'engine-2', 'app-1', null), handles), [])
})
