import assert from 'node:assert/strict'
import test from 'node:test'

import {
  absolutePositions,
  askedToDelete,
  deleteKeepingChildren,
  dragDropTarget,
  dropAtPoint,
  dropPlaced,
  dropTarget,
  edgesAskedToDelete,
  growToHold,
  membersStayDrawn,
  minimumFrameSize,
  normaliseTree,
  parentsFirst,
  type TreeNode,
  UNSIZED_NODE,
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

// outer (100, 100) holds inner at (50, 50), drawn at (150, 150); a card sits in each.
const tree: Node[] = [
  frame('outer', 100, 100, 600, 400),
  frame('inner', 50, 50, 200, 200, 'outer'),
  card('a', 300, 20, 'outer'),
  card('b', 10, 40, 'inner'),
  card('top', 900, 900),
]

test('a node is drawn at its position plus every frame it is in', () => {
  const abs = absolutePositions(tree)
  assert.deepEqual(abs.get('inner'), { x: 150, y: 150 })
  assert.deepEqual(abs.get('b'), { x: 160, y: 190 })
  assert.deepEqual(abs.get('top'), { x: 900, y: 900 })
})

test('read absolute, every node keeps its parent and is placed where it is drawn', () => {
  const read = withAbsolutePositions(tree)
  assert.deepEqual(find(read, 'b'), { ...find(tree, 'b'), position: { x: 160, y: 190 } })
  assert.equal(find(read, 'top'), find(tree, 'top'))
})

test('a loop of parents ends the walk rather than running forever', () => {
  const loop = [frame('p', 10, 10, 100, 100, 'q'), frame('q', 5, 5, 100, 100, 'p')]
  assert.deepEqual(absolutePositions(loop).get('p'), { x: 15, y: 15 })
})

test('the corner rule takes the innermost frame holding the point', () => {
  assert.equal(dropTarget(tree, null, { x: 160, y: 160 }, isFrame), 'inner')
  assert.equal(dropTarget(tree, null, { x: 600, y: 120 }, isFrame), 'outer')
  assert.equal(dropTarget(tree, null, { x: 50, y: 50 }, isFrame), undefined)
})

test('a frame area holds its top-left corner and stops short of its far edges', () => {
  assert.equal(dropTarget(tree, null, { x: 100, y: 100 }, isFrame), 'outer')
  assert.equal(dropTarget(tree, null, { x: 700, y: 300 }, isFrame), undefined)
})

test('the corner rule never puts a frame into itself or a frame inside it', () => {
  // outer's corner, over its own area, has nowhere to go but the top level.
  assert.equal(dropTarget(tree, 'outer', { x: 160, y: 160 }, isFrame), undefined)
})

test('of two unrelated frames holding the point, the smaller wins, then the later one', () => {
  const nodes = [frame('big', 0, 0, 500, 500), frame('small', 100, 100, 100, 100), frame('same', 100, 100, 100, 100)]
  assert.equal(dropTarget(nodes, null, { x: 150, y: 150 }, isFrame), 'same')
  assert.equal(dropTarget(nodes.slice(0, 2), null, { x: 150, y: 150 }, isFrame), 'small')
})

test('a node dropped into a frame becomes its child, drawn where it was dropped', () => {
  const dropped = tree.map((n) => (n.id === 'top' ? { ...n, position: { x: 170, y: 200 } } : n))
  const next = dropPlaced(dropped, new Set(['top']), isFrame)
  assert.equal(find(next, 'top').parentId, 'inner')
  assert.deepEqual(find(next, 'top').position, { x: 20, y: 50 })
})

test('a node dragged out of every frame goes to the top level where it is drawn', () => {
  const moved = tree.map((n) => (n.id === 'b' ? { ...n, position: { x: 1000, y: 0 } } : n))
  const next = dropPlaced(moved, new Set(['b']), isFrame)
  assert.equal(find(next, 'b').parentId, undefined)
  assert.deepEqual(find(next, 'b').position, { x: 1150, y: 150 })
})

test('a node moved inside its frame stays in it, and nothing else changes: the same nodes back', () => {
  const moved = tree.map((n) => (n.id === 'a' ? { ...n, position: { x: 400, y: 300 } } : n))
  assert.equal(dropPlaced(moved, new Set(['a']), isFrame), moved)
})

test('a frame dropped elsewhere keeps its members, nested frames and theirs included', () => {
  const moved = tree.map((n) => (n.id === 'outer' ? { ...n, position: { x: 2000, y: 2000 } } : n))
  const next = dropPlaced(moved, new Set(['outer', 'a', 'inner', 'b']), isFrame)
  assert.equal(next, moved)
  assert.deepEqual(absolutePositions(next).get('b'), { x: 2060, y: 2090 })
})

test('two frames dropped over each other nest, the smaller in the larger', () => {
  const nodes = [frame('big', 0, 0, 400, 400), frame('small', 0, 0, 100, 100)]
  const next = dropPlaced(nodes, new Set(['big', 'small']), isFrame)
  assert.equal(find(next, 'small').parentId, 'big')
  assert.equal(find(next, 'big').parentId, undefined)
})

test('a drag drops into the frame under the pointer, not the one under its corner', () => {
  // top's corner lands left of outer, the pointer over inner.
  const dragged = tree.map((n) => (n.id === 'top' ? { ...n, position: { x: 90, y: 90 } } : n))
  const next = dropAtPoint(dragged, new Set(['top']), { x: 200, y: 200 }, isFrame)
  assert.equal(find(next, 'top').parentId, 'inner')
  assert.deepEqual(absolutePositions(next).get('top'), { x: 90, y: 90 })
})

test('a drag released over empty canvas goes to the top level, wherever its corner is', () => {
  // b's corner stays inside inner, the pointer is off every frame.
  const next = dropAtPoint(tree, new Set(['b']), { x: 50, y: 50 }, isFrame)
  assert.equal(find(next, 'b').parentId, undefined)
  assert.deepEqual(find(next, 'b').position, { x: 160, y: 190 })
})

test('every dragged node goes into the frame under the pointer; a dragged member of a dragged frame stays in it', () => {
  const dragged = tree.map((n) => (n.id === 'a' ? { ...n, position: { x: 900, y: -100 } } : n))
  const next = dropAtPoint(dragged, new Set(['top', 'a']), { x: 200, y: 200 }, isFrame)
  assert.equal(find(next, 'top').parentId, 'inner')
  assert.equal(find(next, 'a').parentId, 'inner')
  assert.deepEqual(absolutePositions(next).get('a'), { x: 1000, y: 0 })
  const frameAndMember = dropAtPoint(tree, new Set(['inner', 'b']), { x: 1000, y: 1000 }, isFrame)
  assert.equal(find(frameAndMember, 'inner').parentId, undefined)
  assert.equal(find(frameAndMember, 'b').parentId, 'inner')
})

test('a drag never drops into a dragged frame or a frame inside one', () => {
  assert.equal(dragDropTarget(tree, new Set(['outer']), { x: 200, y: 200 }, isFrame), undefined)
  assert.equal(dragDropTarget(tree, new Set(['inner']), { x: 200, y: 200 }, isFrame), 'outer')
  assert.equal(dragDropTarget(tree, new Set(['top']), { x: 200, y: 200 }, isFrame), 'inner')
})

test('a drag released over the frame each node is in already gives the same nodes back', () => {
  assert.equal(dropAtPoint(tree, new Set(['a']), { x: 500, y: 150 }, isFrame), tree)
})

/** A card the canvas has measured. */
function measured(id: string, x: number, y: number, width: number, height: number, parentId?: string): Node {
  return { ...card(id, x, y, parentId), measured: { width, height } }
}

test('a frame grows right and down to hold a member placed past its edges, with the padding', () => {
  const nodes = [frame('f', 0, 0, 300, 200), measured('c', 250, 150, 100, 80, 'f')]
  const next = growToHold(nodes, ['c'], () => false)
  // Right edge 350 plus 10, bottom edge 230 plus 10.
  assert.deepEqual(find(next, 'f').style, { width: 360, height: 240 })
  assert.deepEqual(find(next, 'f').position, { x: 0, y: 0 })
  assert.deepEqual(find(next, 'c').position, { x: 250, y: 150 })
})

test('a frame growing left and up moves its corner, and every member stays where it is drawn', () => {
  const nodes = [frame('f', 100, 100, 300, 200), measured('c', -25, 15, 100, 50, 'f'), card('m', 100, 100, 'f')]
  const before = absolutePositions(nodes)
  const next = growToHold(nodes, ['c'], () => false)
  // Left: -30 on the grid, less 10; top: 10 on the grid, less the 40 for the title.
  assert.deepEqual(find(next, 'f').position, { x: 60, y: 70 })
  assert.deepEqual(find(next, 'f').style, { width: 340, height: 230 })
  const after = absolutePositions(next)
  assert.deepEqual(after.get('c'), before.get('c'))
  assert.deepEqual(after.get('m'), before.get('m'))
})

test('growth goes up the chain, and stops at a frame that fits itself', () => {
  const nodes = [
    frame('outer', 0, 0, 400, 300),
    frame('inner', 300, 200, 200, 150, 'outer'),
    measured('c', 150, 100, 100, 60, 'inner'),
  ]
  const next = growToHold(nodes, ['c'], () => false)
  assert.deepEqual(find(next, 'inner').style, { width: 260, height: 170 })
  // inner now reaches to (560, 370): plus the padding.
  assert.deepEqual(find(next, 'outer').style, { width: 570, height: 380 })
  assert.equal(
    growToHold(nodes, ['c'], (f) => f.id === 'inner'),
    nodes,
  )
})

test('growth goes up the chain of frames the canvas has measured, each held at the size it grew to', () => {
  const drawn = (n: Node): Node => ({ ...n, measured: n.style as { width: number; height: number } })
  const nodes = [
    drawn(frame('outer', 0, 0, 900, 600)),
    drawn(frame('inner', 40, 60, 400, 300, 'outer')),
    measured('c', 40, 500, 200, 100, 'inner'),
  ]
  const next = growToHold(nodes, ['c'])
  assert.deepEqual(find(next, 'inner').style, { width: 400, height: 610 })
  assert.deepEqual(find(next, 'inner').measured, { width: 400, height: 610 })
  // inner now reaches down to 60 + 610: plus the padding.
  assert.deepEqual(find(next, 'outer').style, { width: 900, height: 680 })
  // Growing left and up: inner's corner moves out to (-30, 10), outer's out
  // past it, and the card stays drawn at (-20, 50).
  const leftUp = growToHold([...nodes.slice(0, 2), measured('c', -60, -10, 100, 50, 'inner')], ['c'])
  assert.deepEqual(find(leftUp, 'outer').position, { x: -40, y: -30 })
  assert.deepEqual(find(leftUp, 'outer').style, { width: 940, height: 630 })
  assert.deepEqual(find(leftUp, 'inner').position, { x: 10, y: 40 })
  assert.deepEqual(find(leftUp, 'inner').style, { width: 470, height: 350 })
  assert.deepEqual(absolutePositions(leftUp).get('c'), { x: -20, y: 50 })
})

test('a member with no size takes the unsized room, and a frame that holds it already gives the same nodes back', () => {
  const nodes = [frame('f', 0, 0, 300, 200), card('c', 150, 100, 'f')]
  assert.deepEqual(
    find(
      growToHold(nodes, ['c'], () => false),
      'f',
    ).style,
    {
      width: 150 + UNSIZED_NODE.width + 10,
      height: 100 + UNSIZED_NODE.height + 10,
    },
  )
  const held = [frame('f', 0, 0, 300, 200), measured('c', 20, 50, 100, 50, 'f')]
  assert.equal(
    growToHold(held, ['c'], () => false),
    held,
  )
})

test("a frame's smallest size reaches its members' far edges plus the padding", () => {
  const nodes = [frame('f', 0, 0, 600, 400), measured('c', 250, 150, 101, 80, 'f'), measured('d', 20, 300, 50, 45, 'f')]
  assert.deepEqual(minimumFrameSize(nodes, 'f'), { width: 370, height: 360 })
  assert.equal(minimumFrameSize(nodes, 'c'), null)
})

test('a deleted frame leaves its members where they are drawn, in the frame it was in', () => {
  const next = deleteKeepingChildren(tree, new Set(['inner']))
  assert.equal(find(next, 'b').parentId, 'outer')
  assert.deepEqual(absolutePositions(next).get('b'), { x: 160, y: 190 })
  assert.equal(
    next.some((n) => n.id === 'inner'),
    false,
  )
})

test('deleting a frame and the frame it is in leaves their members at the top level', () => {
  const next = deleteKeepingChildren(tree, new Set(['inner', 'outer']))
  assert.equal(find(next, 'b').parentId, undefined)
  assert.deepEqual(find(next, 'b').position, { x: 160, y: 190 })
})

test("a deleted frame's member goes to the nearest ancestor that holds its corner", () => {
  // inner reaches past outer's right edge (900); `far` is drawn past it, `near` inside it.
  const reaching: Node[] = [
    frame('big', 0, 0, 2000, 1000),
    frame('outer', 0, 0, 900, 600, 'big'),
    frame('inner', 800, 100, 400, 300, 'outer'),
    card('far', 300, 100, 'inner'),
    card('near', 50, 50, 'inner'),
  ]
  const next = deleteKeepingChildren(reaching, new Set(['inner']))
  assert.equal(find(next, 'far').parentId, 'big')
  assert.equal(find(next, 'near').parentId, 'outer')
  assert.deepEqual(absolutePositions(next).get('far'), { x: 1100, y: 200 })
  assert.deepEqual(absolutePositions(next).get('near'), { x: 850, y: 150 })

  const alone = deleteKeepingChildren(
    reaching.filter((n) => n.id !== 'big').map((n) => (n.id === 'outer' ? frame('outer', 0, 0, 900, 600) : n)),
    new Set(['inner']),
  )
  assert.equal(find(alone, 'far').parentId, undefined)
  assert.deepEqual(find(alone, 'far').position, { x: 1100, y: 200 })
})

test("a frame's own position changing leaves its members where they are drawn", () => {
  // A resize from outer's top-left snapped it from (100, 100) to (95, 95).
  const snapped = tree.map((n) => (n.id === 'outer' ? { ...n, position: { x: 95, y: 95 } } : n))
  const next = membersStayDrawn(tree, snapped)
  const before = absolutePositions(tree)
  const after = absolutePositions(next)
  for (const id of ['inner', 'a', 'b', 'top']) {
    assert.deepEqual(after.get(id), before.get(id), id)
  }
  assert.deepEqual(after.get('outer'), { x: 95, y: 95 })
})

test('a member moved along with its frame keeps its own move', () => {
  const both = tree.map((n) =>
    n.id === 'outer' ? { ...n, position: { x: 95, y: 95 } } : n.id === 'a' ? { ...n, position: { x: 0, y: 0 } } : n,
  )
  assert.deepEqual(find(membersStayDrawn(tree, both), 'a').position, { x: 0, y: 0 })
})

test('a deletion keeps the selected nodes and those not inside another node of it', () => {
  const requested: Node[] = [
    { ...find(tree, 'outer'), selected: true },
    find(tree, 'inner'),
    { ...find(tree, 'a'), selected: true },
    find(tree, 'b'),
  ]
  assert.deepEqual(
    askedToDelete(requested).map((n) => n.id),
    ['outer', 'a'],
  )
})

test('edges asked for with no node, as a pin double-click asks, are all deleted', () => {
  const edges = [
    { id: 'e1', source: 'a', target: 'b' },
    { id: 'e2', source: 'x', target: 'a' },
  ]
  assert.deepEqual(
    edgesAskedToDelete(edges, [], []).map((e) => e.id),
    ['e1', 'e2'],
  )
})

test('a deletion keeps the edges of the nodes that outlive it, unless selected', () => {
  const requested: Node[] = [
    { ...find(tree, 'outer'), selected: true },
    find(tree, 'inner'),
    find(tree, 'a'),
    find(tree, 'b'),
  ]
  const asked = askedToDelete(requested)
  assert.deepEqual(
    asked.map((n) => n.id),
    ['outer'],
  )
  const edges = [
    { id: 'outer-x', source: 'outer', target: 'x' },
    { id: 'a-x', source: 'a', target: 'x' },
    { id: 'x-inner', source: 'x', target: 'inner', selected: true },
    { id: 'x-y', source: 'x', target: 'y' },
  ]
  assert.deepEqual(
    edgesAskedToDelete(edges, requested, asked).map((e) => e.id),
    ['outer-x', 'x-inner', 'x-y'],
  )
})

test('a parent that is gone is cleared and the node keeps its position', () => {
  const nodes = [card('lost', 30, 40, 'gone')]
  assert.deepEqual(normaliseTree(nodes), [card('lost', 30, 40)])
})

test('a loop of parents is cut at its latest node, which stays where it is drawn', () => {
  const nodes = [frame('p', 10, 10, 300, 300, 'q'), frame('q', 5, 5, 300, 300, 'p')]
  const next = normaliseTree(nodes)
  assert.equal(find(next, 'p').parentId, 'q')
  assert.equal(find(next, 'q').parentId, undefined)
  assert.deepEqual(find(next, 'q').position, { x: 15, y: 15 })
})

test('a whole tree is returned as it is', () => {
  assert.equal(normaliseTree(tree), tree)
})

test('parents come before their children, every other node in the order given', () => {
  const nodes = [
    card('b', 0, 0, 'inner'),
    card('x', 0, 0),
    frame('inner', 0, 0, 10, 10, 'outer'),
    frame('outer', 0, 0, 10, 10),
  ]
  assert.deepEqual(
    parentsFirst(nodes).map((n) => n.id),
    ['outer', 'inner', 'b', 'x'],
  )
})
