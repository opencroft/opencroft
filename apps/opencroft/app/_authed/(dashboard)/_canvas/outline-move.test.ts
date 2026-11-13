import assert from 'node:assert/strict'
import test from 'node:test'

import { moveFromOutline, OUTLINE_KEEPS_LEVEL } from '@/app/_authed/(dashboard)/_canvas/outline-move'
import { drawnOrder } from '@/app/_authed/(dashboard)/_canvas/outline-tree'
import { type AutolayoutNode, autolayoutSections } from '@/app/_authed/(dashboard)/_canvas/section-autolayout'
import {
  isAutolayoutSection,
  SECTION_TYPE,
} from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/section-shared'
import { SUBGRAPH_TYPE } from '@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared'
import { absolutePositions } from '@/app/_authed/(extension-runtime)/_frame-tree'

// Positions of members are relative to their frame, as the canvas stores them.
// Outer (0,0) 900x600 holds Inner (40,60) 400x300, which holds Card A; Top is at the top level.
function frame(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  parentId?: string,
  autolayout = false,
): AutolayoutNode {
  return {
    id,
    type: SECTION_TYPE,
    position: { x, y },
    style: { width, height },
    data: { label: id, color: 'red', ...(autolayout ? { autolayout: true } : {}) },
    ...(parentId ? { parentId } : {}),
  }
}

function card(id: string, x: number, y: number, parentId?: string): AutolayoutNode {
  return {
    id,
    type: 'log',
    position: { x, y },
    measured: { width: 200, height: 100 },
    data: {},
    ...(parentId ? { parentId } : {}),
  }
}

const isFrame = (n: AutolayoutNode) => n.type === SECTION_TYPE

const GRAPH = [
  frame('outer', 0, 0, 900, 600),
  frame('inner', 40, 60, 400, 300, 'outer'),
  card('a', 40, 80, 'inner'),
  card('top', 1200, 100),
]

function moved(result: ReturnType<typeof moveFromOutline<AutolayoutNode>>): AutolayoutNode[] {
  assert.ok(result && 'nodes' in result, `moved, got ${JSON.stringify(result)}`)
  return result.nodes
}

const nodeOf = (nodes: AutolayoutNode[], id: string) => nodes.find((n) => n.id === id) as AutolayoutNode

test('a node dropped on a frame row goes into it, drawn inside it below its members', () => {
  const nodes = moved(moveFromOutline(GRAPH, 'top', { parentId: 'inner' }, isFrame, isAutolayoutSection))
  const top = nodeOf(nodes, 'top')
  assert.equal(top.parentId, 'inner')
  const abs = absolutePositions(nodes)
  const inner = abs.get('inner') as { x: number; y: number }
  const at = abs.get('top') as { x: number; y: number }
  assert.ok(at.x >= inner.x && at.y > (abs.get('a') as { y: number }).y, `inside, below Card A: ${JSON.stringify(at)}`)
})

test('a frame row moved carries its subtree: its members keep their places in it', () => {
  const nodes = moved(moveFromOutline(GRAPH, 'inner', { parentId: null }, isFrame, isAutolayoutSection))
  assert.equal(nodeOf(nodes, 'inner').parentId, undefined)
  assert.deepEqual(absolutePositions(nodes).get('inner'), { x: 40, y: 60 }, 'out at the top level where it is drawn')
  assert.equal(nodeOf(nodes, 'a').parentId, 'inner')
  assert.deepEqual(nodeOf(nodes, 'a').position, { x: 40, y: 80 })
})

test('a member dropped at the top level leaves every frame where it is drawn', () => {
  const nodes = moved(moveFromOutline(GRAPH, 'a', { parentId: null }, isFrame, isAutolayoutSection))
  assert.equal(nodeOf(nodes, 'a').parentId, undefined)
  assert.deepEqual(nodeOf(nodes, 'a').position, { x: 80, y: 140 })
})

test('a frame cannot go into a frame inside it', () => {
  const result = moveFromOutline(GRAPH, 'outer', { parentId: 'inner' }, isFrame, isAutolayoutSection)
  assert.ok(result && 'refused' in result)
})

test('a new place among the siblings of a plain frame changes nothing', () => {
  const result = moveFromOutline(
    GRAPH,
    'inner',
    { parentId: 'outer', beside: { id: 'inner', side: 'after' } },
    isFrame,
    isAutolayoutSection,
  )
  assert.equal(result, null)
})

// Subgraph Sub at the top level holds Frame F, which holds Card M; Card N is in Sub itself.
const LEVELS: AutolayoutNode[] = [
  ...GRAPH,
  { id: 'sub', type: SUBGRAPH_TYPE, position: { x: 0, y: 800 }, measured: { width: 240, height: 120 }, data: {} },
  frame('f', 100, 100, 400, 300, 'sub'),
  card('m', 40, 80, 'f'),
  card('n', 600, 100, 'sub'),
]

for (const [what, nodeId, drop] of [
  ['into a subgraph', 'top', { parentId: 'sub' }],
  ['into a frame inside a subgraph', 'top', { parentId: 'f' }],
  ['beside a member of a subgraph', 'top', { parentId: 'f', beside: { id: 'm', side: 'after' } }],
  ['from a subgraph to the top level', 'n', { parentId: null }],
  ['from a frame in a subgraph to the top level', 'm', { parentId: null }],
  ['from a subgraph into a frame at the top level', 'n', { parentId: 'inner' }],
] as const) {
  test(`the Outline keeps a node on its level: a move ${what} is refused`, () => {
    assert.deepEqual(moveFromOutline(LEVELS, nodeId, drop, isFrame, isAutolayoutSection), {
      refused: OUTLINE_KEEPS_LEVEL,
    })
  })
}

test('inside a subgraph, the Outline moves a node between its frames', () => {
  const nodes = moved(moveFromOutline(LEVELS, 'n', { parentId: 'f' }, isFrame, isAutolayoutSection))
  assert.equal(nodeOf(nodes, 'n').parentId, 'f')
  const out = moved(moveFromOutline(LEVELS, 'm', { parentId: 'sub' }, isFrame, isAutolayoutSection))
  assert.equal(nodeOf(out, 'm').parentId, 'sub')
})

test('a subgraph itself moves into a frame on its own level', () => {
  const nodes = moved(moveFromOutline(LEVELS, 'sub', { parentId: 'outer' }, isFrame, isAutolayoutSection))
  assert.equal(nodeOf(nodes, 'sub').parentId, 'outer')
})

// An autolayout section S holding A, B, C in a column, laid out once.
function column(): AutolayoutNode[] {
  return autolayoutSections(
    [
      frame('S', 0, 0, 300, 600, undefined, true),
      card('a', 10, 40, 'S'),
      card('b', 10, 160, 'S'),
      card('c', 10, 280, 'S'),
      card('x', 600, 0),
    ],
    [],
  )
}

function columnOrder(nodes: AutolayoutNode[]): string[] {
  const laidOut = autolayoutSections(nodes, [])
  return laidOut
    .filter((n) => n.parentId === 'S')
    .sort(drawnOrder)
    .map((n) => n.id)
}

for (const [beside, side, expected] of [
  ['a', 'before', ['x', 'a', 'b', 'c']],
  ['a', 'after', ['a', 'x', 'b', 'c']],
  ['b', 'before', ['a', 'x', 'b', 'c']],
  ['c', 'before', ['a', 'b', 'x', 'c']],
  ['c', 'after', ['a', 'b', 'c', 'x']],
] as const) {
  test(`in an autolayout section, a node dropped ${side} ${beside.toUpperCase()} is laid out there`, () => {
    const nodes = moved(
      moveFromOutline(column(), 'x', { parentId: 'S', beside: { id: beside, side } }, isFrame, isAutolayoutSection),
    )
    assert.equal(nodeOf(nodes, 'x').parentId, 'S')
    assert.deepEqual(columnOrder(nodes), expected)
  })
}

test('in an autolayout section, a member moved to a new place among its siblings is laid out there', () => {
  const start = moved(moveFromOutline(column(), 'x', { parentId: 'S' }, isFrame, isAutolayoutSection))
  assert.deepEqual(columnOrder(start), ['a', 'b', 'c', 'x'])
  const nodes = moved(
    moveFromOutline(
      autolayoutSections(start, []),
      'c',
      { parentId: 'S', beside: { id: 'a', side: 'before' } },
      isFrame,
      isAutolayoutSection,
    ),
  )
  assert.deepEqual(columnOrder(nodes), ['c', 'a', 'b', 'x'])
})
