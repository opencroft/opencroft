import assert from 'node:assert/strict'
import test from 'node:test'

import { Box } from 'lucide-react'
import type { GraphOutlineItem } from 'ui/nodes/graph-outline'

import {
  collapsedRows,
  foldsFor,
  foldsShowingLevel,
  NO_FOLDS,
  outlineTree,
} from '@/app/_authed/(dashboard)/_canvas/outline-tree'
import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { byIdOf, type TreeNode } from '@/app/_authed/(extension-runtime)/_frame-tree'

const isFrame = (n: TreeNode) => n.type === 'frame'
const describe = (n: TreeNode) => ({ label: n.id, icon: Box })

function node(id: string, type: string, x: number, y: number, parentId?: string): TreeNode {
  return { id, type, position: { x, y }, ...(parentId ? { parentId } : {}) }
}

/** The tree as ids, a frame's members in brackets. */
function shape(items: GraphOutlineItem[]): unknown[] {
  return items.map((item) => (item.members ? { [item.id]: shape(item.members) } : item.id))
}

test('frames hold their members, nested frames included, and the top level comes first', () => {
  const nodes = [
    node('card', 'card', 10, 10, 'inner'),
    node('outer', 'frame', 0, 0),
    node('inner', 'frame', 20, 20, 'outer'),
    node('loose', 'card', 500, 500),
  ]
  assert.deepEqual(shape(outlineTree(nodes, isFrame, describe)), [{ outer: [{ inner: ['card'] }] }, 'loose'])
})

test('siblings are listed as they are drawn: top to bottom, then left to right', () => {
  const nodes = [
    node('low', 'card', 0, 300),
    node('right', 'card', 200, 100),
    node('left', 'card', 0, 100),
    node('high', 'card', 900, 0),
  ]
  assert.deepEqual(shape(outlineTree(nodes, isFrame, describe)), ['high', 'left', 'right', 'low'])
})

test('an empty frame is still a frame row, with no members', () => {
  const [frame] = outlineTree([node('empty', 'frame', 0, 0)], isFrame, describe)
  assert.deepEqual(frame.members, [])
})

test('a node whose parent is missing is listed at the top level', () => {
  const nodes = [node('orphan', 'card', 0, 0, 'gone')]
  assert.deepEqual(shape(outlineTree(nodes, isFrame, describe)), ['orphan'])
})

// Sub at the top level holds Frame F (which holds Inner, a subgraph holding
// Card D) and Card C; Section S and Card T are beside it.
const LEVELS = [
  node('sub', SUBGRAPH_TYPE, 0, 0),
  node('f', 'frame', 0, 0, 'sub'),
  node('inner', SUBGRAPH_TYPE, 10, 10, 'f'),
  node('d', 'card', 0, 0, 'inner'),
  node('c', 'card', 0, 400, 'sub'),
  node('s', 'frame', 0, 300),
  node('t', 'card', 0, 600),
]

test('the tree holds every level: a subgraph is marked and lists what it holds, at every depth', () => {
  const items = outlineTree(LEVELS, isFrame, describe)
  assert.deepEqual(shape(items), [{ sub: [{ f: [{ inner: ['d'] }] }, 'c'] }, { s: [] }, 't'])
  const marked = (rows: GraphOutlineItem[]): string[] =>
    rows.flatMap((r) => [...(r.subgraph ? [r.id] : []), ...marked(r.members ?? [])])
  assert.deepEqual(marked(items), ['sub', 'inner'])
})

test('an empty subgraph is still a row that expands', () => {
  const [row] = outlineTree([node('sub', SUBGRAPH_TYPE, 0, 0)], isFrame, describe)
  assert.deepEqual(row.members, [])
  assert.equal(row.subgraph, true)
})

test('subgraphs start collapsed and frames expanded', () => {
  assert.deepEqual([...collapsedRows(NO_FOLDS, LEVELS)].sort(), ['inner', 'sub'])
})

test('rows folded in the Outline are kept: frames collapsed, subgraphs expanded', () => {
  const folds = foldsFor(new Set(['s', 'inner']), LEVELS)
  assert.deepEqual([...folds.collapsedFrames], ['s'])
  assert.deepEqual([...folds.expandedSubgraphs], ['sub'])
  assert.deepEqual([...collapsedRows(folds, LEVELS)].sort(), ['inner', 's'])
})

test("opening a level expands it and everything it lies in, and leaves other rows' folds", () => {
  const byId = byIdOf(LEVELS)
  const before = foldsFor(new Set(['sub', 'inner', 'f', 's']), LEVELS)
  const after = foldsShowingLevel(before, 'inner', byId)
  assert.deepEqual([...collapsedRows(after, LEVELS)], ['s'])
  assert.equal(foldsShowingLevel(after, 'inner', byId), after, 'nothing to open returns the folds as they are')
  assert.equal(foldsShowingLevel(before, undefined, byId), before, 'the top level opens nothing')
})

test('each row carries what describe says of its node', () => {
  const [row] = outlineTree([node('n1', 'card', 0, 0)], isFrame, (n) => ({
    label: `Label ${n.id}`,
    typeName: 'Card',
    icon: Box,
    accent: 'red',
  }))
  assert.deepEqual(row, { id: 'n1', label: 'Label n1', typeName: 'Card', icon: Box, accent: 'red' })
})
