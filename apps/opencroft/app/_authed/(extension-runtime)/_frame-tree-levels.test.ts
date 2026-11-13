import assert from 'node:assert/strict'
import test from 'node:test'

import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import {
  absolutePositions,
  askedToDelete,
  byIdOf,
  deleteKeepingChildren,
  dragDropTarget,
  dropAtPoint,
  dropPlaced,
  growToHold,
  levelOf,
  type TreeNode,
  withAbsolutePositions,
} from '@/app/_authed/(extension-runtime)/_frame-tree'

interface Node extends TreeNode {
  selected?: boolean
}

const isFrame = (n: Node) => n.type === 'frame'

function frame(id: string, x: number, y: number, width: number, height: number, parentId?: string): Node {
  return { id, type: 'frame', position: { x, y }, style: { width, height }, ...(parentId ? { parentId } : {}) }
}

function card(id: string, x: number, y: number, parentId?: string): Node {
  return { id, type: 'card', position: { x, y }, ...(parentId ? { parentId } : {}) }
}

const find = (nodes: Node[], id: string) => nodes.find((n) => n.id === id) as Node

// A subgraph `sub` sits in the frame `outer`, drawn at (140, 160) on the top
// level. Inside it, on its own canvas: the frame `inside` at (-80, 30) holding
// the card `c`, and the card `d` straight in the subgraph. `outer` covers
// (100, 100) to (700, 500) of the top level, which on the inner canvas is
// empty space: a placement there must not reach it.
const graph: Node[] = [
  frame('outer', 100, 100, 600, 400),
  { id: 'sub', type: SUBGRAPH_TYPE, position: { x: 40, y: 60 }, parentId: 'outer' },
  frame('inside', -80, 30, 200, 200, 'sub'),
  card('c', 20, 40, 'inside'),
  card('d', 500, -120, 'sub'),
  card('top', -400, -300),
]

test('positions add up to the nearest subgraph, whose canvas has its origin at its corner', () => {
  const abs = absolutePositions(graph)
  assert.deepEqual(abs.get('sub'), { x: 140, y: 160 })
  assert.deepEqual(abs.get('inside'), { x: -80, y: 30 })
  assert.deepEqual(abs.get('c'), { x: -60, y: 70 })
  assert.deepEqual(abs.get('d'), { x: 500, y: -120 })
  assert.deepEqual(find(withAbsolutePositions(graph), 'c').position, { x: -60, y: 70 })
})

test("a node's level is the nearest subgraph it is in", () => {
  const byId = byIdOf(graph)
  assert.equal(levelOf('c', byId), 'sub')
  assert.equal(levelOf('inside', byId), 'sub')
  assert.equal(levelOf('d', byId), 'sub')
  assert.equal(levelOf('sub', byId), undefined)
  assert.equal(levelOf('top', byId), undefined)
})

test('placed by its corner, an inner node goes into a frame on its own level, else into the subgraph', () => {
  // (150, 150) lies in `outer` on the top level, and in nothing on the inner canvas.
  const moved = graph.map((n) => (n.id === 'd' ? { ...n, position: { x: 150, y: 150 } } : n))
  assert.equal(dropPlaced(moved, new Set(['d']), isFrame), moved, 'd stays straight in the subgraph')
  const intoFrame = graph.map((n) => (n.id === 'd' ? { ...n, position: { x: -50, y: 100 } } : n))
  const placed = find(dropPlaced(intoFrame, new Set(['d']), isFrame), 'd')
  assert.equal(placed.parentId, 'inside')
  assert.deepEqual(placed.position, { x: 30, y: 70 })
})

test('a node taken out of an inner frame by its corner lands in the subgraph, where it is drawn', () => {
  const out = graph.map((n) => (n.id === 'c' ? { ...n, position: { x: 400, y: 400 } } : n))
  const placed = find(dropPlaced(out, new Set(['c']), isFrame), 'c')
  assert.equal(placed.parentId, 'sub')
  assert.deepEqual(placed.position, { x: 320, y: 430 })
})

test('a drag on the inner canvas drops into a frame there or into the subgraph, never a frame of another level', () => {
  assert.equal(dragDropTarget(graph, new Set(['d']), { x: 150, y: 150 }, isFrame), undefined)
  assert.equal(dragDropTarget(graph, new Set(['d']), { x: 0, y: 100 }, isFrame), 'inside')
  const intoFrame = dropAtPoint(
    graph.map((n) => (n.id === 'd' ? { ...n, position: { x: -10, y: 60 } } : n)),
    new Set(['d']),
    { x: 0, y: 100 },
    isFrame,
  )
  assert.deepEqual(find(intoFrame, 'd'), { ...card('d', 70, 30, 'inside') })
  const outOfFrame = dropAtPoint(
    graph.map((n) => (n.id === 'c' ? { ...n, position: { x: 300, y: -200 } } : n)),
    new Set(['c']),
    { x: 250, y: -150 },
    isFrame,
  )
  assert.deepEqual(find(outOfFrame, 'c'), card('c', 220, -170, 'sub'))
})

test('a subgraph never grows to hold its members', () => {
  assert.equal(growToHold(graph, ['d']), graph)
})

test('deleting a subgraph deletes everything inside it', () => {
  const left = deleteKeepingChildren(graph, new Set(['sub']))
  assert.deepEqual(
    left.map((n) => n.id),
    ['outer', 'top'],
  )
})

test("an inner frame's members outlive it in the subgraph, where they are drawn", () => {
  const left = deleteKeepingChildren(graph, new Set(['inside']))
  assert.deepEqual(find(left, 'c'), card('c', -60, 70, 'sub'))
})

test("React Flow's deletion of a selected subgraph keeps its contents in the deletion", () => {
  const requested = [
    { ...find(graph, 'sub'), selected: true },
    find(graph, 'inside'),
    find(graph, 'c'),
    find(graph, 'd'),
  ]
  assert.deepEqual(
    askedToDelete(requested).map((n) => n.id),
    ['sub', 'inside', 'c', 'd'],
  )
})
