import assert from 'node:assert/strict'
import test from 'node:test'

import { NODE_CARD_MAX_WIDTH } from 'ui/nodes/node-card'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { BOUNDARY_GAP, BOUNDARY_WIDTH, boundaryAt } from '@/app/_authed/(extension-runtime)/_subgraph-boundaries'
import { normaliseSubgraphs, type WiringNode } from '@/app/_authed/(extension-runtime)/_wired-edges'

// A subgraph away from the origin, so a position on its canvas and one on the
// top level's never coincide.
const sub: WiringNode = {
  id: 'sub',
  type: SUBGRAPH_TYPE,
  position: { x: 700, y: -260 },
  data: { name: 'Sub', ports: { inputs: [], outputs: [] } },
}

function member(id: string, x: number, y: number): WiringNode {
  return { id, type: 'acme.t.node', parentId: 'sub', position: { x, y }, width: 160, height: 80 }
}

function places(nodes: readonly unknown[]): unknown {
  const s = (nodes as WiringNode[]).find((n) => n.id === 'sub') as WiringNode
  const data = s.data as { inputsAt?: unknown; outputsAt?: unknown }
  return { inputsAt: data.inputsAt, outputsAt: data.outputsAt }
}

// Each write is normalised, as the server does with every change.
function write(nodes: WiringNode[]): WiringNode[] {
  return normaliseSubgraphs({ nodes, edges: [] }).nodes
}

test('a new subgraph’s boundaries are placed on its first write and stay put as nodes are added and dragged', () => {
  const created = write([sub])
  const first = places(created)
  // Room for one unsized card (200) between them, a card at its widest (240)
  // clear of each: Inputs (260) + 240 + 200 + 240.
  assert.deepEqual(first, { inputsAt: { x: 0, y: 0 }, outputsAt: { x: 940, y: 0 } })

  const oneInside = write([...created, member('a', -500, 300)])
  assert.deepEqual(places(oneInside), first, 'adding the first node moves neither boundary')

  const dragged = write(oneInside.map((n) => (n.id === 'a' ? { ...n, position: { x: -900, y: 620 } } : n)))
  assert.deepEqual(places(dragged), first, 'dragging it moves neither')

  const twoInside = write([...dragged, member('b', 400, -120)])
  const each = write(
    twoInside.map((n) =>
      n.id === 'a' ? { ...n, position: { x: 40, y: 40 } } : n.id === 'b' ? { ...n, position: { x: 1200, y: -800 } } : n,
    ),
  )
  assert.deepEqual(places(each), first, 'nor does dragging each of two')
  assert.deepEqual(places(write(each.filter((n) => n.parentId !== 'sub'))), first, 'nor emptying it')
})

test('a subgraph written with its contents gets its boundaries a card’s width clear of them, level with the top one', () => {
  const nodes = write([sub, member('a', -300, 140), member('b', 220, -60)])
  // Inputs (260 wide) ends a card at its widest (240) left of the leftmost
  // member; Outputs starts 240 right of the rightmost member's right edge (380).
  assert.deepEqual(places(nodes), { inputsAt: { x: -800, y: -60 }, outputsAt: { x: 620, y: -60 } })
})

test('the gap beside the contents holds a card at its widest, and a boundary is counted at least as wide as it is drawn', () => {
  assert.equal(BOUNDARY_GAP, NODE_CARD_MAX_WIDTH)
  // A boundary with no ports is drawn 258 wide (measured in a browser, 2026-11-01).
  assert.ok(BOUNDARY_WIDTH >= 258)
})

test('a placed boundary is kept, and a graph whose boundaries are all placed comes back as it is', () => {
  const placed = {
    ...sub,
    data: { ...(sub.data as object), inputsAt: { x: -80, y: 20 }, outputsAt: { x: 900, y: 20 } },
  }
  const graph = { nodes: [placed, member('a', 40, 40)], edges: [] }
  assert.equal(normaliseSubgraphs(graph), graph)
  assert.deepEqual(boundaryAt(placed, 'inputs', graph.nodes), { x: -80, y: 20 })

  const halfPlaced = { ...sub, data: { ...(sub.data as object), outputsAt: { x: 900, y: 20 } } }
  assert.deepEqual(places(write([halfPlaced, member('a', 40, 40)])), {
    inputsAt: { x: -460, y: 40 },
    outputsAt: { x: 900, y: 20 },
  })
})
