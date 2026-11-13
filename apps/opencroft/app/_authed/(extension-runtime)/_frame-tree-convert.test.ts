import assert from 'node:assert/strict'
import test from 'node:test'

import { absolutePositions, type TreeNode } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { toTree } from '@/app/_authed/(extension-runtime)/_frame-tree-convert'

const isFrame = (n: TreeNode) => n.type === 'section' || n.type === 'network'

function frame(id: string, x: number, y: number, width: number, height: number, type = 'section'): TreeNode {
  return { id, type, position: { x, y }, style: { width, height } }
}

function card(id: string, x: number, y: number, type = 'card'): TreeNode {
  return { id, type, position: { x, y } }
}

const parentOf = (nodes: TreeNode[], id: string) => nodes.find((n) => n.id === id)?.parentId

/** Every node drawn where it was: the absolute positions of a stored graph. */
function drawnAsBefore(before: TreeNode[], after: TreeNode[]): void {
  const abs = absolutePositions(after)
  for (const node of before) {
    assert.deepEqual(abs.get(node.id), node.position, `${node.id} moved`)
  }
}

test('each node goes into the innermost frame holding its corner, and nothing moves on screen', () => {
  const nodes = [
    frame('outer', 0, 0, 1000, 800),
    frame('inner', 100, 100, 400, 300),
    card('a', 150, 200),
    card('b', 700, 100),
    card('top', 2000, 0),
  ]
  const { nodes: tree, changes } = toTree(nodes, isFrame)
  assert.equal(parentOf(tree, 'inner'), 'outer')
  assert.equal(parentOf(tree, 'a'), 'inner')
  assert.equal(parentOf(tree, 'b'), 'outer')
  assert.equal(parentOf(tree, 'top'), undefined)
  assert.deepEqual(tree.find((n) => n.id === 'a')?.position, { x: 50, y: 100 })
  drawnAsBefore(nodes, tree)
  assert.deepEqual(changes, [])
})

test('two overlapping frames whose corners lie inside each other nest, and a node in both stays in both', () => {
  const nodes = [
    frame('net-a', 0, 0, 400, 400, 'network'),
    frame('net-b', 300, 300, 300, 300, 'network'),
    card('app', 350, 350, 'application'),
  ]
  const { nodes: tree, changes } = toTree(nodes, isFrame)
  assert.equal(parentOf(tree, 'net-b'), 'net-a')
  assert.equal(parentOf(tree, 'app'), 'net-b')
  assert.deepEqual(changes, [])
})

test('a node in two crossing frames keeps the smaller, and the conversion reports the one it left', () => {
  // Neither frame's corner lies in the other: a cross.
  const nodes = [
    frame('net-a', 0, 100, 400, 200, 'network'),
    frame('net-b', 100, 0, 200, 300, 'network'),
    card('app', 150, 150, 'application'),
  ]
  const { nodes: tree, changes } = toTree(nodes, isFrame)
  assert.equal(parentOf(tree, 'app'), 'net-b')
  drawnAsBefore(nodes, tree)
  assert.deepEqual(changes, [
    { nodeId: 'app', type: 'application', left: [{ id: 'net-a', type: 'network' }], gained: [] },
  ])
})

test('of two equal frames over each other the later goes into the earlier, never both ways', () => {
  const nodes = [frame('first', 0, 0, 300, 300), frame('second', 0, 0, 300, 300), card('c', 10, 10)]
  const { nodes: tree } = toTree(nodes, isFrame)
  assert.equal(parentOf(tree, 'second'), 'first')
  assert.equal(parentOf(tree, 'first'), undefined)
  assert.equal(parentOf(tree, 'c'), 'second')
})

test('a large frame whose corner a small one covers stays out of it', () => {
  const nodes = [frame('small', 0, 0, 100, 100), frame('large', 50, 50, 500, 500)]
  const { nodes: tree } = toTree(nodes, isFrame)
  assert.equal(parentOf(tree, 'large'), undefined)
})

test('a node inside a frame that reaches past its own frame reports the frame it is now inside', () => {
  // inner's corner is in outer, its area reaches past it; c lies in inner beyond outer.
  const nodes = [frame('outer', 0, 0, 500, 500), frame('inner', 400, 400, 300, 300), card('c', 600, 600)]
  const { nodes: tree, changes } = toTree(nodes, isFrame)
  assert.equal(parentOf(tree, 'c'), 'inner')
  assert.deepEqual(changes, [{ nodeId: 'c', type: 'card', left: [], gained: [{ id: 'outer', type: 'section' }] }])
})

test('a node that already has a parent keeps it', () => {
  const nodes = [frame('f', 0, 0, 400, 400), frame('g', 1000, 0, 400, 400), { ...card('kid', 10, 10), parentId: 'g' }]
  const { nodes: tree } = toTree(nodes, isFrame)
  assert.equal(parentOf(tree, 'kid'), 'g')
})
