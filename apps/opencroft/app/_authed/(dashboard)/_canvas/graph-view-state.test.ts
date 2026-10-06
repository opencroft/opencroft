// A save must not carry the tab's selection, and a load must not adopt one.
// Both halves were live on stage: graphs held `selected: true` rows, and every
// reload of the page came up with those nodes picked.

import assert from 'node:assert/strict'
import test from 'node:test'

import type { Edge, Node } from '@xyflow/react'

import type { GraphData } from '@/app/_authed/(space)/_server/types'
import {
  liveGraphOf,
  mergeRemoteEdges,
  mergeRemoteNodes,
  persistedNodes,
  withCurrentSelection,
} from './graph-view-state'

const node = (id: string, extra: Partial<Node> = {}): Node => ({
  id,
  type: 'agent',
  position: { x: 0, y: 0 },
  data: {},
  ...extra,
})

test('a save drops the view flags and the comment overlays, and keeps the rest', () => {
  const saved = persistedNodes([
    node('a', { selected: true, dragging: false, measured: { width: 200, height: 80 } }),
    node('comment-a', { type: 'comment', selectable: false }),
  ])
  assert.deepEqual(
    saved.map((n) => n.id),
    ['a'],
  )
  assert.equal('selected' in saved[0], false)
  assert.equal('dragging' in saved[0], false)
  assert.equal('selectable' in saved[0], false)
  assert.deepEqual(saved[0].measured, { width: 200, height: 80 })
})

test('a fetched graph takes the selection this tab has, not the one the rows carry', () => {
  const incoming = [node('a', { selected: true }), node('b'), node('c', { selected: true })]
  const current = [node('a'), node('b', { selected: true })]
  assert.deepEqual(
    withCurrentSelection(incoming, current).map((n) => [n.id, n.selected]),
    [
      ['a', false],
      ['b', true],
      ['c', false],
    ],
  )
})

test('a first load, with nothing on the canvas yet, selects nothing', () => {
  const loaded = withCurrentSelection([node('a', { selected: true })], [])
  assert.equal(loaded[0].selected, false)
})

// A change someone else made to a live graph, merged into this tab.
const graph = (nodes: Node[], edges: Edge[] = []): GraphData => ({
  nodes: nodes as unknown as GraphData['nodes'],
  edges: edges as unknown as GraphData['edges'],
})

test('a remote change replaces the nodes it changed and leaves the tab its copy of the rest', () => {
  const before = graph([node('a'), node('b')])
  const after = graph([node('a', { position: { x: 50, y: 0 } }), node('b')])
  // This tab has an edit to b it has not written yet.
  const current = [node('a', { selected: true }), node('b', { data: { label: 'typing' } })]
  const merged = mergeRemoteNodes(before, after, current)
  assert.deepEqual(merged[0].position, { x: 50, y: 0 })
  assert.equal(merged[0].selected, true)
  assert.deepEqual(merged[1].data, { label: 'typing' })
})

test('a node being dragged here keeps its local position through a remote change to it', () => {
  const before = graph([node('a')])
  const after = graph([node('a', { position: { x: 50, y: 0 } })])
  const dragging = node('a', { position: { x: 7, y: 7 }, dragging: true })
  assert.equal(mergeRemoteNodes(before, after, [dragging])[0], dragging)
})

test('a changed node keeps the size this tab measured for it', () => {
  const before = graph([node('a')])
  const after = graph([node('a', { data: { label: 'renamed' }, measured: { width: 1, height: 1 } })])
  const current = [node('a', { measured: { width: 200, height: 80 } })]
  assert.deepEqual(mergeRemoteNodes(before, after, current)[0].measured, { width: 200, height: 80 })
})

test('a remote removal removes, and a node added here but not written yet stays', () => {
  const before = graph([node('a'), node('gone')])
  const after = graph([node('a')])
  const current = [node('a'), node('gone'), node('mine-new'), node('comment-a', { type: 'comment' })]
  assert.deepEqual(
    mergeRemoteNodes(before, after, current).map((n) => n.id),
    ['a', 'mine-new', 'comment-a'],
  )
})

test('a remote addition appears unselected', () => {
  const merged = mergeRemoteNodes(graph([]), graph([node('theirs', { selected: true })]), [])
  assert.deepEqual(
    merged.map((n) => [n.id, n.selected]),
    [['theirs', false]],
  )
})

test("edges merge the same way and keep this tab's selection", () => {
  const edge = (id: string, extra: Partial<Edge> = {}): Edge => ({ id, source: 'a', target: 'b', ...extra })
  const before = graph([], [edge('e1'), edge('e2')])
  const after = graph([], [edge('e1', { targetHandle: 'other' }), edge('e3')])
  const merged = mergeRemoteEdges(before, after, [edge('e1', { selected: true }), edge('e2')])
  assert.deepEqual(
    merged.map((e) => [e.id, e.targetHandle ?? null, e.selected]),
    [
      ['e1', 'other', true],
      ['e3', null, false],
    ],
  )
})

test('a live write carries no selection, and leaves measured sizes as the base holds them', () => {
  const base = graph([node('a', { measured: { width: 10, height: 10 } }), node('b')])
  const written = liveGraphOf(
    [
      node('a', { selected: true, measured: { width: 200, height: 80 } }),
      node('b', { measured: { width: 50, height: 50 } }),
    ],
    [{ id: 'e1', source: 'a', target: 'b', selected: true }],
    base,
  )
  assert.deepEqual(
    written.nodes.map((n) => [n.id, n.measured ?? null, 'selected' in n]),
    [
      ['a', { width: 10, height: 10 }, false],
      ['b', null, false],
    ],
  )
  assert.deepEqual(written.edges, [{ id: 'e1', source: 'a', target: 'b' }])
})
