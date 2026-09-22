import assert from 'node:assert/strict'
import test from 'node:test'

import { assignPasteIds } from './paste-ids'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const ROUTER = '33333333-3333-4333-8333-333333333333'
const EDGE = '44444444-4444-4444-8444-444444444444'

function counter() {
  let n = 0
  return () => `fresh-${++n}`
}

function payload() {
  return {
    nodes: [
      { id: A, data: { name: 'server' } },
      { id: B, parentId: A, data: {} },
      // A router inside the pasted set, routing to a terminal that is also pasted.
      {
        id: ROUTER,
        data: { routes: [{ id: 'r1', target: `${A}/terminal` }], __resolvedContexts: { x: { sourceNodeId: A } } },
      },
    ],
    edges: [{ id: EDGE, source: A, target: B }],
  }
}

test('nothing taken: a paste keeps every id, so outside references still hold (cut-and-paste)', () => {
  const { nodes, edges } = payload()
  const result = assignPasteIds(nodes, edges, new Set(), counter())
  assert.deepEqual(
    result.nodes.map((n) => n.id),
    [A, B, ROUTER],
  )
  assert.equal(result.edges[0].id, EDGE)
  assert.equal(result.renamed.size, 0)
  assert.deepEqual(result.nodes[2].data, nodes[2].data)
})

test('a taken id is replaced, and every reference to it inside the pasted set follows', () => {
  const { nodes, edges } = payload()
  const result = assignPasteIds(nodes, edges, new Set([A]), counter())
  const fresh = result.renamed.get(A)
  assert.equal(fresh, 'fresh-1')
  assert.deepEqual(
    result.nodes.map((n) => n.id),
    [fresh, B, ROUTER],
  )
  assert.equal(result.nodes[1].parentId, fresh)
  assert.equal(result.edges[0].source, fresh)
  assert.equal(result.edges[0].target, B)
  const data = result.nodes[2].data as {
    routes: Array<{ target: string }>
    __resolvedContexts: { x: { sourceNodeId: string } }
  }
  assert.equal(data.routes[0].target, `${fresh}/terminal`)
  assert.equal(data.__resolvedContexts.x.sourceNodeId, fresh)
})

test('edge ids are checked too, and a repeat inside the payload counts as a conflict', () => {
  const nodes = [
    { id: A, data: {} },
    { id: A, data: {} },
  ]
  const edges = [{ id: EDGE, source: A, target: A }]
  const result = assignPasteIds(nodes, edges, new Set([EDGE]), counter())
  assert.notEqual(result.nodes[0].id, result.nodes[1].id)
  assert.equal(result.edges[0].id, 'fresh-2')
})

test('an edge whose other end is not pasted is dropped, not left dangling', () => {
  const result = assignPasteIds([{ id: A, data: {} }], [{ id: EDGE, source: A, target: B }], new Set(), counter())
  assert.deepEqual(result.edges, [])
})
