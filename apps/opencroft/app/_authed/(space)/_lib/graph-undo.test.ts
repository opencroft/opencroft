// Undo over a graph doc that others edit at the same time. Each test runs two
// synced docs -- "mine" with a GraphUndo, "theirs" standing for another user
// or an agent -- and pins one rule of per-writer undo:
//
// - only my steps are undone, one step per call;
// - an undo never overwrites what someone else wrote since;
// - an undo never leaves someone else's edge or child pointing at nothing.
//
// Several of these hold because of Y.UndoManager's own behaviour rather than
// code in GraphUndo; they are pinned here so a Yjs upgrade that changes it
// fails a test instead of silently changing what undo does.

import assert from 'node:assert/strict'
import test from 'node:test'

import * as Y from 'yjs'

import { applyGraphToDoc, readGraphFromDoc } from '@/app/_authed/(space)/_lib/graph-doc'
import { GraphUndo } from '@/app/_authed/(space)/_lib/graph-undo'
import type { GraphData } from '@/app/_authed/(space)/_server/types'

const ME = { writer: 'me' }
const THEM = { writer: 'them' }

interface Setup {
  mine: Y.Doc
  theirs: Y.Doc
  undo: GraphUndo
}

function setup(initial: GraphData): Setup {
  const mine = new Y.Doc()
  const theirs = new Y.Doc()
  mine.on('update', (update: Uint8Array, origin: unknown) => origin !== theirs && Y.applyUpdate(theirs, update, mine))
  theirs.on('update', (update: Uint8Array, origin: unknown) => origin !== mine && Y.applyUpdate(mine, update, theirs))
  applyGraphToDoc(theirs, initial, { origin: THEM })
  return { mine, theirs, undo: new GraphUndo(mine, ME) }
}

function node(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type: 'acme.kit.log', position: { x: 0, y: 0 }, data: { label: id }, ...extra }
}

// One writer's edit: the graph it sees, changed by `change`, written back.
function edit(doc: Y.Doc, origin: object, change: (graph: GraphData) => void): void {
  const base = readGraphFromDoc(doc)
  const next = readGraphFromDoc(doc)
  change(next)
  applyGraphToDoc(doc, next, { base, origin })
}

function nodeById(doc: Y.Doc, id: string): Record<string, unknown> | undefined {
  return readGraphFromDoc(doc).nodes.find((n) => n.id === id)
}

test('undo reverts my step and leaves a concurrent change of theirs', () => {
  const { mine, theirs, undo } = setup({ nodes: [node('n1')], edges: [] })
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 50, y: 0 }
  })
  edit(theirs, THEM, (g) => {
    ;(g.nodes[0].data as Record<string, unknown>).label = 'theirs'
  })
  assert.deepEqual(undo.undo(), { applied: true, keptNodeIds: [] })
  assert.deepEqual(nodeById(mine, 'n1')?.position, { x: 0, y: 0 })
  assert.equal((nodeById(mine, 'n1')?.data as Record<string, unknown>).label, 'theirs')
})

test('a step made under another origin is not in my history', () => {
  const { theirs, undo } = setup({ nodes: [node('n1')], edges: [] })
  edit(theirs, THEM, (g) => {
    g.nodes.push(node('n2'))
  })
  assert.equal(undo.canUndo, false)
  assert.equal(undo.undo(), null)
})

test('one write is one step, and undo takes one step per call', () => {
  const { mine, undo } = setup({ nodes: [node('n1')], edges: [] })
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 1, y: 0 }
  })
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 2, y: 0 }
  })
  undo.undo()
  assert.deepEqual(nodeById(mine, 'n1')?.position, { x: 1, y: 0 })
  undo.undo()
  assert.deepEqual(nodeById(mine, 'n1')?.position, { x: 0, y: 0 })
})

test('undo of a field they overwrote since keeps their value', () => {
  const { mine, theirs, undo } = setup({ nodes: [node('n1')], edges: [] })
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 50, y: 0 }
  })
  edit(theirs, THEM, (g) => {
    g.nodes[0].position = { x: 99, y: 0 }
  })
  undo.undo()
  assert.deepEqual(nodeById(mine, 'n1')?.position, { x: 99, y: 0 })
  assert.deepEqual(nodeById(theirs, 'n1')?.position, { x: 99, y: 0 })
})

test('a step they wholly replaced is dropped, and the older step waits for the next undo', () => {
  const { mine, theirs, undo } = setup({ nodes: [node('n1')], edges: [] })
  edit(mine, ME, (g) => {
    ;(g.nodes[0].data as Record<string, unknown>).label = 'first'
  })
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 50, y: 0 }
  })
  edit(theirs, THEM, (g) => {
    g.nodes[0].position = { x: 99, y: 0 }
  })
  assert.deepEqual(undo.undo(), { applied: false, keptNodeIds: [] })
  assert.equal((nodeById(mine, 'n1')?.data as Record<string, unknown>).label, 'first')
  assert.equal(undo.canUndo, true)
  assert.deepEqual(undo.undo(), { applied: true, keptNodeIds: [] })
  assert.equal((nodeById(mine, 'n1')?.data as Record<string, unknown>).label, 'n1')
  assert.equal(undo.canUndo, false)
})

test('undo of a move of a node they deleted changes nothing', () => {
  const { mine, theirs, undo } = setup({ nodes: [node('n1'), node('n2')], edges: [] })
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 50, y: 0 }
  })
  edit(theirs, THEM, (g) => {
    g.nodes = g.nodes.filter((n) => n.id !== 'n1')
  })
  assert.equal(undo.undo()?.applied, false)
  assert.equal(nodeById(mine, 'n1'), undefined)
  assert.equal(nodeById(theirs, 'n1'), undefined)
})

test('undo of my new node keeps it, whole, when they connected an edge to it', () => {
  const { mine, theirs, undo } = setup({ nodes: [node('n1')], edges: [] })
  edit(mine, ME, (g) => {
    g.nodes.push(node('mine', { position: { x: 5, y: 5 }, data: { label: 'made by me' } }))
  })
  edit(theirs, THEM, (g) => {
    g.edges.push({ id: 'their-edge', source: 'n1', target: 'mine' })
  })
  assert.deepEqual(undo.undo(), { applied: false, keptNodeIds: ['mine'] })
  assert.deepEqual(nodeById(mine, 'mine'), node('mine', { position: { x: 5, y: 5 }, data: { label: 'made by me' } }))
  assert.ok(readGraphFromDoc(mine).edges.some((e) => e.id === 'their-edge'))
  assert.deepEqual(readGraphFromDoc(theirs), readGraphFromDoc(mine))
})

test('undo of my new section keeps it when they placed a node in it', () => {
  const { mine, theirs, undo } = setup({ nodes: [], edges: [] })
  edit(mine, ME, (g) => {
    g.nodes.push(node('section'))
  })
  edit(theirs, THEM, (g) => {
    g.nodes.push(node('their-child', { parentId: 'section' }))
  })
  assert.deepEqual(undo.undo()?.keptNodeIds, ['section'])
  assert.ok(nodeById(mine, 'section'))
})

test('undo removes the nodes and edges of my step when nothing of theirs refers to them', () => {
  const { mine, undo } = setup({ nodes: [node('n1')], edges: [] })
  // A paste: nodes and the edges between them, in one write, edge first.
  edit(mine, ME, (g) => {
    g.edges.push({ id: 'pasted-edge', source: 'p1', target: 'p2' })
    g.nodes.push(node('p1'), node('p2'))
  })
  assert.deepEqual(undo.undo(), { applied: true, keptNodeIds: [] })
  assert.deepEqual(readGraphFromDoc(mine), { nodes: [node('n1')], edges: [] })
})

test('undo of a move is not blocked by edges they connected to the node', () => {
  const { mine, theirs, undo } = setup({ nodes: [node('n1'), node('n2')], edges: [] })
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 50, y: 0 }
  })
  edit(theirs, THEM, (g) => {
    g.edges.push({ id: 'their-edge', source: 'n2', target: 'n1' })
  })
  assert.deepEqual(undo.undo(), { applied: true, keptNodeIds: [] })
  assert.deepEqual(nodeById(mine, 'n1')?.position, { x: 0, y: 0 })
})

test('redo re-applies an undone step, and a new step clears redo', () => {
  const { mine, undo } = setup({ nodes: [node('n1')], edges: [] })
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 50, y: 0 }
  })
  undo.undo()
  assert.deepEqual(undo.redo(), { applied: true, keptNodeIds: [] })
  assert.deepEqual(nodeById(mine, 'n1')?.position, { x: 50, y: 0 })
  undo.undo()
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 7, y: 0 }
  })
  assert.equal(undo.canRedo, false)
})

test('redo after they overwrote the field keeps their value', () => {
  const { mine, theirs, undo } = setup({ nodes: [node('n1')], edges: [] })
  edit(mine, ME, (g) => {
    g.nodes[0].position = { x: 50, y: 0 }
  })
  undo.undo()
  edit(theirs, THEM, (g) => {
    g.nodes[0].position = { x: 99, y: 0 }
  })
  undo.redo()
  assert.deepEqual(nodeById(mine, 'n1')?.position, { x: 99, y: 0 })
})

// Typing into one field: one write per keystroke, one step for the lot.
function type(doc: Y.Doc, undo: GraphUndo, mergeKey: string | undefined, label: string): void {
  undo.beginStep(mergeKey)
  edit(doc, ME, (g) => {
    ;(g.nodes[0].data as Record<string, unknown>).label = label
  })
}

function labelOf(doc: Y.Doc): unknown {
  return (nodeById(doc, 'n1')?.data as Record<string, unknown>).label
}

test('writes carrying the same merge key are one step', () => {
  const { mine, undo } = setup({ nodes: [node('n1')], edges: [] })
  type(mine, undo, 'label', 'a')
  type(mine, undo, 'label', 'ab')
  type(mine, undo, 'label', 'abc')
  undo.undo()
  assert.equal(labelOf(mine), 'n1')
  assert.equal(undo.canUndo, false)
})

test('a write with another merge key, or none, starts a step of its own', () => {
  const { mine, undo } = setup({ nodes: [node('n1')], edges: [] })
  type(mine, undo, 'label', 'a')
  type(mine, undo, 'other', 'b')
  type(mine, undo, undefined, 'c')
  type(mine, undo, undefined, 'd')
  undo.undo()
  assert.equal(labelOf(mine), 'c')
  undo.undo()
  assert.equal(labelOf(mine), 'b')
  undo.undo()
  assert.equal(labelOf(mine), 'a')
})

test('a write after an undo never joins the step that was undone', () => {
  const { mine, undo } = setup({ nodes: [node('n1')], edges: [] })
  type(mine, undo, 'label', 'a')
  type(mine, undo, 'label', 'ab')
  undo.undo()
  type(mine, undo, 'label', 'x')
  undo.undo()
  assert.equal(labelOf(mine), 'n1')
  assert.equal(undo.canRedo, true)
})
