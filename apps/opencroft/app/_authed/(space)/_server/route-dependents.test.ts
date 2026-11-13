import assert from 'node:assert/strict'
import test from 'node:test'

import { graphsRoutingTo } from './route-dependents'

const ROUTER = 'builtin.core.terminal-router'

const router = (id: string, targets: string[]) => ({
  id,
  type: ROUTER,
  data: { routes: targets.map((target, i) => ({ id: `r${i}`, target })) },
})

const graphs = [
  { id: 'servers', graph: { nodes: [{ id: 'srv-1', type: 'builtin.core.server', data: {} }], edges: [] } },
  { id: 'dev', graph: { nodes: [router('router-1', ['srv-1/terminal'])], edges: [] } },
  { id: 'apps', graph: { nodes: [router('router-2', ['acme.box/terminal', 'srv-2/terminal'])], edges: [] } },
  {
    id: 'plain',
    graph: { nodes: [{ id: 'n', type: 'acme.kit.log', data: { routes: [{ target: 'srv-1/x' }] } }], edges: [] },
  },
]

test('a graph whose router routes to a changed node depends on it; a node of another type with routes does not', () => {
  assert.deepEqual(graphsRoutingTo(graphs, 'servers', new Set(['srv-1'])), ['dev'])
})

test('no graph depends on a node nothing routes to', () => {
  assert.deepEqual(graphsRoutingTo(graphs, 'servers', new Set(['srv-9'])), [])
})

test("a router routing to a node of its own graph is left to that graph's own resolution", () => {
  const same = [
    { id: 'g', graph: { nodes: [{ id: 'srv-1', type: 'x', data: {} }, router('r', ['srv-1/terminal'])], edges: [] } },
  ]
  assert.deepEqual(graphsRoutingTo(same, 'g', new Set(['srv-1'])), [])
})

test('every route of a router is considered', () => {
  assert.deepEqual(graphsRoutingTo(graphs, 'other', new Set(['srv-2'])), ['apps'])
})
