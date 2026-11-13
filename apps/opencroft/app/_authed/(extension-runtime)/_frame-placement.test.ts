import assert from 'node:assert/strict'
import test from 'node:test'

import { NODE_CARD_MIN_WIDTH } from 'ui/nodes/node-card'

import {
  type PlacementRequest,
  type PlacementResult,
  placeAbsolute,
  withoutStandingPlaces,
} from '@/app/_authed/(extension-runtime)/_frame-placement'
import { absolutePositions, type TreeNode, UNSIZED_NODE } from '@/app/_authed/(extension-runtime)/_frame-tree'

type Node = TreeNode & { measured?: { width?: number; height?: number } }

const isFrame = (n: Node) => n.type === 'section'

function section(id: string, x: number, y: number, width: number, height: number, parentId?: string): Node {
  return { id, type: 'section', position: { x, y }, style: { width, height }, ...(parentId ? { parentId } : {}) }
}

function card(id: string, x: number, y: number, parentId?: string, height = 60): Node {
  return { id, type: 'card', position: { x, y }, measured: { width: 200, height }, ...(parentId ? { parentId } : {}) }
}

// S at (100, 100), 600 by 400, holding A; T elsewhere, empty; C at the top level.
const graph: Node[] = [
  section('S', 100, 100, 600, 400),
  card('A', 10, 40, 'S'),
  section('T', 1000, 0, 300, 300),
  card('C', 2000, 2000),
]

function placed(result: PlacementResult<Node>): Node[] {
  assert.ok('nodes' in result, `expected it placed, got: ${JSON.stringify(result)}`)
  return result.nodes
}

function refusal(result: PlacementResult<Node>): string {
  assert.ok('refused' in result, 'expected it refused')
  return result.refused
}

const place = (requests: PlacementRequest[], nodes = graph) => placeAbsolute(nodes, requests, isFrame)
const node = (nodes: Node[], id: string) => nodes.find((n) => n.id === id) as Node

test('a position alone puts the node in the frame under its corner, stored relative to it', () => {
  const next = placed(place([{ id: 'C', position: { x: 300, y: 300 } }]))
  assert.equal(node(next, 'C').parentId, 'S')
  assert.deepEqual(node(next, 'C').position, { x: 200, y: 200 })
})

test('a position outside every frame takes the node to the top level', () => {
  const next = placed(place([{ id: 'A', position: { x: 50, y: 900 } }]))
  assert.equal(node(next, 'A').parentId, undefined)
  assert.deepEqual(node(next, 'A').position, { x: 50, y: 900 })
})

test('a position inside the frame named is placed there', () => {
  const next = placed(place([{ id: 'C', position: { x: 1100, y: 100 }, parentId: 'T' }]))
  assert.equal(node(next, 'C').parentId, 'T')
  assert.deepEqual(node(next, 'C').position, { x: 100, y: 100 })
})

test('a position outside the frame named is refused, giving its area', () => {
  const message = refusal(place([{ id: 'C', position: { x: 300, y: 300 }, parentId: 'T' }]))
  assert.match(message, /outside frame T, whose area is x 1000 to 1300, y 0 to 300/)
})

test('a parent that is not a frame, or the node itself or inside it, is refused', () => {
  assert.match(refusal(place([{ id: 'C', parentId: 'A' }])), /not a frame/)
  assert.match(refusal(place([{ id: 'S', parentId: 'S' }])), /cannot go into itself/)
  const nested = [...graph, section('inner', 10, 120, 100, 100, 'S')]
  assert.match(refusal(place([{ id: 'S', parentId: 'inner' }], nested)), /cannot go into itself or a frame inside it/)
  assert.match(refusal(place([{ id: 'C', parentId: 'nope' }])), /no such node/)
})

test('null takes a node to the top level where it is drawn', () => {
  const next = placed(place([{ id: 'A', parentId: null }]))
  assert.equal(node(next, 'A').parentId, undefined)
  assert.deepEqual(node(next, 'A').position, { x: 110, y: 140 })
})

test('a parent alone puts the node below the lowest member, the frame growing to hold it', () => {
  const next = placed(place([{ id: 'C', parentId: 'S' }]))
  assert.equal(node(next, 'C').parentId, 'S')
  // A ends at 40 + 60 = 100: one grid step below.
  assert.deepEqual(node(next, 'C').position, { x: 10, y: 110 })
  const tall = placed(
    place(
      [{ id: 'C', parentId: 'S' }],
      graph.map((n) => (n.id === 'A' ? card('A', 10, 300, 'S', 120) : n)),
    ),
  )
  assert.deepEqual(node(tall, 'C').position, { x: 10, y: 430 })
  assert.deepEqual(node(tall, 'S').style, { width: 600, height: 430 + 60 + 10 })
})

test('a parent alone leaves room for a member the graph holds no size for', () => {
  // As a write sees the stored graph: cards carry no size; only the canvas measures them.
  const stored: Node[] = [
    section('inner', 40, 60, 400, 300),
    { id: 'log', type: 'card', position: { x: 40, y: 80 }, parentId: 'inner' },
    { id: 'new', type: 'card', position: { x: 0, y: 0 } },
  ]
  const next = placed(place([{ id: 'new', parentId: 'inner' }], stored))
  // 80 + 140 (room for the unsized log), then one grid step.
  assert.deepEqual(node(next, 'new').position, { x: 10, y: 230 })
  // The frame grows to hold the new card's room too: 230 + 140 + 10.
  assert.deepEqual(node(next, 'inner').style, { width: 400, height: 380 })
})

test("an unsized node takes a card's narrowest width", () => {
  assert.equal(UNSIZED_NODE.width, NODE_CARD_MIN_WIDTH)
})

test('a parent alone puts the node in an empty frame under its label', () => {
  const next = placed(place([{ id: 'C', parentId: 'T' }]))
  assert.deepEqual(node(next, 'C').position, { x: 10, y: 40 })
})

test('moving a frame carries its members, whose stored positions do not change', () => {
  const next = placed(place([{ id: 'S', position: { x: 3000, y: 3000 } }]))
  assert.deepEqual(node(next, 'A'), node(graph, 'A'))
  assert.deepEqual(absolutePositions(next).get('A'), { x: 3010, y: 3040 })
})

test('a frame and its members moved in one call land where each was put', () => {
  const next = placed(
    place([
      { id: 'S', position: { x: 200, y: 200 } },
      { id: 'A', position: { x: 250, y: 300 } },
    ]),
  )
  assert.equal(node(next, 'A').parentId, 'S')
  assert.deepEqual(absolutePositions(next).get('A'), { x: 250, y: 300 })
})

test('a node placed past its frame edges grows the frame and the frames around it', () => {
  const nested = [
    section('outer', 0, 0, 800, 600),
    { ...section('S', 100, 100, 600, 400), parentId: 'outer' },
    card('C', 2000, 2000),
  ]
  const next = placed(place([{ id: 'C', position: { x: 650, y: 450 } }], nested))
  assert.equal(node(next, 'C').parentId, 'S')
  // C's box reaches (850, 510): S grows to hold it plus one grid step, then outer to hold S.
  assert.deepEqual(node(next, 'S').style, { width: 760, height: 420 })
  assert.deepEqual(node(next, 'outer').style, { width: 870, height: 600 })
  assert.deepEqual(absolutePositions(next).get('C'), { x: 650, y: 450 })
})

test('a frame that fits itself is not grown by a placement', () => {
  const next = placed(placeAbsolute(graph, [{ id: 'C', position: { x: 650, y: 450 } }], isFrame, (f) => f.id === 'S'))
  assert.deepEqual(node(next, 'S').style, { width: 600, height: 400 })
})

test('a size too small for the members is refused, naming the smallest it can be', () => {
  const nodes = [...graph, card('far', 500, 300, 'S')]
  const message = refusal(place([{ id: 'S', size: { width: 200, height: 160 } }], nodes))
  // far's box reaches (700, 360) inside S: plus one grid step.
  assert.match(message, /it needs at least 710 × 370/)
  placed(place([{ id: 'S', size: { width: 710, height: 370 } }], nodes))
})

test('a size equal to the one the frame has is never refused', () => {
  const nodes = [...graph, card('far', 900, 0, 'S')]
  placed(place([{ id: 'S', size: { width: 600, height: 400 } }], nodes))
})

test('writing back where a node is drawn leaves it in its frame, even with its corner outside it', () => {
  const nodes = [...graph, card('far', 900, 0, 'S')]
  const requests = withoutStandingPlaces(nodes, [{ id: 'far', position: { x: 1000, y: 100 }, parentId: 'S' }])
  assert.deepEqual(requests, [{ id: 'far' }])
  const next = placed(place(requests, nodes))
  assert.equal(node(next, 'far').parentId, 'S')
  assert.deepEqual(node(next, 'far').position, { x: 900, y: 0 })
})

test('a place written back is kept when its frame moves in the same call, or with another parent', () => {
  const moving: PlacementRequest[] = [
    { id: 'S', position: { x: 200, y: 200 } },
    { id: 'A', position: { x: 110, y: 140 } },
  ]
  assert.deepEqual(withoutStandingPlaces(graph, moving), moving)
  const elsewhere: PlacementRequest[] = [{ id: 'A', position: { x: 110, y: 140 }, parentId: null }]
  assert.deepEqual(withoutStandingPlaces(graph, elsewhere), elsewhere)
})

test('a member already outside its frame does not refuse an unrelated write', () => {
  const stray = [...graph, card('far', 900, 0, 'S')]
  placed(place([{ id: 'C', position: { x: 2100, y: 2100 } }], stray))
})
