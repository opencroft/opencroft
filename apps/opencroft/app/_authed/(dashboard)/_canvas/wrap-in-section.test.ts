import assert from 'node:assert/strict'
import test from 'node:test'

import { sectionBoxAround, withSectionAround, wrapInSection } from '@/app/_authed/(dashboard)/_canvas/wrap-in-section'
import { absolutePositions } from '@/app/_authed/(extension-runtime)/_frame-tree'
import { GRID_STEP, type GridBox } from '@/app/_authed/(extension-runtime)/_grid'

const onGrid = (box: GridBox) => [box.x, box.y, box.width, box.height].every((v) => v % GRID_STEP === 0)

test('one node: one grid step left, right and below it, four above it', () => {
  const box = sectionBoxAround([{ x: 100, y: 200, width: 200, height: 60 }])
  assert.deepEqual(box, { x: 90, y: 160, width: 220, height: 110 })
})

test('three nodes: the padding is measured from the outermost node on each side', () => {
  const nodes = [
    { x: 40, y: 100, width: 200, height: 60 },
    { x: 300, y: 50, width: 440, height: 60 },
    { x: 120, y: 300, width: 200, height: 260 },
  ]
  const box = sectionBoxAround(nodes) as GridBox
  assert.equal(40 - box.x, GRID_STEP, 'left')
  assert.equal(50 - box.y, 4 * GRID_STEP, 'top')
  assert.equal(box.x + box.width - 740, GRID_STEP, 'right')
  assert.equal(box.y + box.height - 560, GRID_STEP, 'bottom')
  assert.ok(onGrid(box))
})

test('a node edge between grid lines takes the line outside it, so the padding never shrinks', () => {
  const box = sectionBoxAround([{ x: 103, y: 207, width: 205.5, height: 61 }]) as GridBox
  assert.ok(onGrid(box), JSON.stringify(box))
  assert.ok(103 - box.x >= GRID_STEP)
  assert.ok(207 - box.y >= 4 * GRID_STEP)
  assert.ok(box.x + box.width - (103 + 205.5) >= GRID_STEP)
  assert.ok(box.y + box.height - (207 + 61) >= GRID_STEP)
})

test('a size measured a hair over a grid line does not add a step', () => {
  const box = sectionBoxAround([{ x: 0, y: 0, width: 200.00000001, height: 60 }]) as GridBox
  assert.equal(box.width, 220)
})

test('nothing selected wraps nothing', () => {
  assert.equal(sectionBoxAround([]), null)
})

interface Placed {
  id: string
  position: { x: number; y: number }
  parentId?: string
  selected?: boolean
  width?: number
  height?: number
  style?: { width: number; height: number }
}

const sectionAt = (box: GridBox): Placed => ({
  id: 's',
  position: { x: box.x, y: box.y },
  style: { width: box.width, height: box.height },
})

test('the wrapped nodes become the section members where they are drawn, so dragging it carries them', () => {
  const nodes: Placed[] = [
    { id: 'a', position: { x: 40, y: 100 }, width: 200, height: 60, selected: true },
    { id: 'b', position: { x: 300, y: 50 }, width: 440, height: 60, selected: true },
    { id: 'c', position: { x: 120, y: 300 }, width: 200, height: 260, selected: true },
  ]
  const box = sectionBoxAround(
    nodes.map((n) => ({ ...n.position, width: n.width ?? 0, height: n.height ?? 0 })),
  ) as GridBox
  const next = wrapInSection(nodes, new Set(['a', 'b', 'c']), sectionAt(box))
  const abs = absolutePositions(next)
  for (const node of nodes) {
    const wrapped = next.find((n) => n.id === node.id) as Placed
    assert.equal(wrapped.parentId, 's', node.id)
    assert.deepEqual(abs.get(node.id), node.position, `${node.id} is drawn where it was`)
  }
  assert.equal(next.find((n) => n.id === 's')?.parentId, undefined)
})

test('a section wrapped inside a frame goes into that frame; a member of a wrapped frame stays in it', () => {
  const nodes: Placed[] = [
    { id: 'outer', position: { x: 0, y: 0 }, style: { width: 1000, height: 1000 } },
    {
      id: 'inner',
      parentId: 'outer',
      position: { x: 100, y: 100 },
      style: { width: 300, height: 200 },
      selected: true,
    },
    { id: 'kid', parentId: 'inner', position: { x: 20, y: 40 }, width: 50, height: 50, selected: true },
    { id: 'a', parentId: 'outer', position: { x: 500, y: 150 }, width: 100, height: 50, selected: true },
  ]
  const next = wrapInSection(
    nodes,
    new Set(['inner', 'kid', 'a']),
    sectionAt({ x: 90, y: 60, width: 520, height: 260 }),
  )
  const parent = (id: string) => next.find((n) => n.id === id)?.parentId
  assert.equal(parent('s'), 'outer')
  assert.equal(parent('inner'), 's')
  assert.equal(parent('a'), 's')
  assert.equal(parent('kid'), 'inner')
  assert.deepEqual(absolutePositions(next).get('kid'), { x: 120, y: 140 })
})

test('a section goes into the frame its nodes shared even where its corner lies outside that frame', () => {
  const nodes: Placed[] = [
    { id: 'f', position: { x: 100, y: 100 }, style: { width: 300, height: 300 } },
    { id: 'a', parentId: 'f', position: { x: 10, y: 20 }, width: 50, height: 50, selected: true },
  ]
  // The section's corner, (100, 80), is above f's top edge.
  const next = wrapInSection(nodes, new Set(['a']), sectionAt({ x: 100, y: 80, width: 70, height: 100 }))
  assert.equal(next.find((n) => n.id === 's')?.parentId, 'f')
  assert.deepEqual(absolutePositions(next).get('a'), { x: 110, y: 120 })
})

test('nodes from different frames wrap into a section at the top level', () => {
  const nodes: Placed[] = [
    { id: 'f', position: { x: 0, y: 0 }, style: { width: 300, height: 300 } },
    { id: 'a', parentId: 'f', position: { x: 100, y: 100 }, width: 50, height: 50, selected: true },
    { id: 'b', position: { x: 400, y: 100 }, width: 50, height: 50, selected: true },
  ]
  const next = wrapInSection(nodes, new Set(['a', 'b']), sectionAt({ x: 90, y: 60, width: 370, height: 100 }))
  assert.equal(next.find((n) => n.id === 's')?.parentId, undefined)
})

test('the section goes just before the first wrapped node and is the only one selected', () => {
  const nodes = [
    { id: 'outer', selected: false },
    { id: 'x', selected: true },
    { id: 'other', selected: false },
    { id: 'y', selected: true },
  ]
  const next = withSectionAround(nodes, new Set(['x', 'y']), { id: 's', selected: false })
  assert.deepEqual(
    next.map((n) => n.id),
    ['outer', 's', 'x', 'other', 'y'],
  )
  assert.deepEqual(
    next.filter((n) => n.selected).map((n) => n.id),
    ['s'],
  )
})
