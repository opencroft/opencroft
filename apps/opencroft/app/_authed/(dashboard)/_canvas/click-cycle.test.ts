import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'
import {
  type Cycle,
  clickCycle,
  isPlainClick,
  MOUSE_SLOP_PX,
  movedAway,
  type NodeClick,
  type StackedBox,
  selectsText,
  slopFor,
  stackAt,
  TOUCH_SLOP_PX,
} from './click-cycle'

const box = (id: string, x: number, y: number, width: number, height: number, more: Partial<StackedBox> = {}) => ({
  id,
  x,
  y,
  width,
  height,
  frame: false,
  depth: 0,
  zIndex: 0,
  ...more,
})

test('the stack under a point lists only the nodes whose box holds it', () => {
  const boxes = [box('a', 0, 0, 10, 10), box('b', 20, 20, 10, 10), box('c', 5, 5, 10, 10)]
  assert.deepEqual(stackAt(boxes, { x: 7, y: 7 }), ['c', 'a'])
  assert.deepEqual(stackAt(boxes, { x: 25, y: 25 }), ['b'])
  assert.deepEqual(stackAt(boxes, { x: 50, y: 50 }), [])
  // The right and bottom edges are outside, as on screen.
  assert.deepEqual(stackAt(boxes, { x: 10, y: 2 }), [])
})

test('a node comes before the sections under it, and a nested section before its parent', () => {
  // The outer section is drawn after the inner one, so it lies over it in
  // drawing order; nesting decides instead.
  const boxes = [
    box('inner', 50, 50, 200, 150, { frame: true, depth: 1 }),
    box('outer', 0, 0, 400, 300, { frame: true }),
    box('node', 100, 100, 50, 50, { depth: 2 }),
  ]
  assert.deepEqual(stackAt(boxes, { x: 110, y: 110 }), ['node', 'inner', 'outer'])
})

test('sections go by nesting, not by size', () => {
  // A nested section larger than the part of its parent under the point
  // still comes first: only depth orders sections.
  const boxes = [
    box('parent', 0, 0, 100, 100, { frame: true }),
    box('child', 0, 0, 300, 300, { frame: true, depth: 1 }),
    box('grandchild', 0, 0, 500, 500, { frame: true, depth: 2 }),
  ]
  assert.deepEqual(stackAt(boxes, { x: 10, y: 10 }), ['grandchild', 'child', 'parent'])
})

test('overlapping sections at one depth go by drawing order, the last drawn first', () => {
  const boxes = [
    box('first', 0, 0, 100, 100, { frame: true }),
    box('second', 50, 50, 100, 100, { frame: true }),
    box('nested', 60, 60, 20, 20, { frame: true, depth: 1 }),
  ]
  assert.deepEqual(stackAt(boxes, { x: 70, y: 70 }), ['nested', 'second', 'first'])
})

test('nodes go by z-index, then the one drawn last first', () => {
  const boxes = [box('low', 0, 0, 10, 10), box('raised', 0, 0, 10, 10, { zIndex: 5 }), box('last', 0, 0, 10, 10)]
  assert.deepEqual(stackAt(boxes, { x: 1, y: 1 }), ['raised', 'last', 'low'])
})

const click = (over: Partial<NodeClick> = {}): NodeClick => ({
  x: 100,
  y: 100,
  slop: MOUSE_SLOP_PX,
  nodeId: 'node',
  plain: true,
  selectsText: false,
  selectedIds: [],
  ...over,
})

/** Clicks the same spot `times` times, the selection following each answer. */
function clickRepeatedly(times: number, stack: string[]): string[] {
  let cycle: Cycle | null = null
  let selected: string[] = []
  const seen: string[] = []
  for (let i = 0; i < times; i++) {
    const next = clickCycle(cycle, click({ nodeId: stack[0], selectedIds: selected }), () => stack)
    cycle = next.cycle
    // With no `select`, React Flow's selection of the node clicked stands.
    selected = [next.select ?? stack[0]]
    seen.push(selected[0])
  }
  return seen
}

test('clicking one spot again walks down the stack and wraps to the top', () => {
  assert.deepEqual(clickRepeatedly(4, ['node', 'inner', 'outer']), ['node', 'inner', 'outer', 'node'])
})

test('a click with one node under it starts no walk', () => {
  assert.deepEqual(clickRepeatedly(3, ['alone']), ['alone', 'alone', 'alone'])
})

test('the first click keeps React Flow selection and asks for the stack once', () => {
  let asked = 0
  const first = clickCycle(null, click(), () => {
    asked++
    return ['node', 'inner']
  })
  assert.equal(first.select, undefined)
  assert.deepEqual(first.cycle?.stack, ['node', 'inner'])
  const second = clickCycle(first.cycle, click({ selectedIds: ['node'] }), () => {
    asked++
    return []
  })
  assert.equal(second.select, 'inner')
  assert.equal(asked, 1, 'the stack found on the first click is kept')
})

test('a click beyond the slop starts over at the node clicked', () => {
  const first = clickCycle(null, click(), () => ['node', 'inner'])
  const near = clickCycle(first.cycle, click({ x: 103, selectedIds: ['node'] }), () => ['node', 'inner'])
  assert.equal(near.select, 'inner', 'within the slop is the same spot')
  const far = clickCycle(first.cycle, click({ x: 100 + MOUSE_SLOP_PX + 1, selectedIds: ['node'] }), () => [
    'node',
    'inner',
  ])
  assert.equal(far.select, undefined)
  assert.equal(far.cycle?.index, 0)
})

test('a click that is not plain ends the cycle without selecting', () => {
  const first = clickCycle(null, click(), () => ['node', 'inner'])
  const shifted = clickCycle(first.cycle, click({ plain: false, selectedIds: ['node'] }), () => ['node', 'inner'])
  assert.deepEqual(shifted, { cycle: null })
})

test('a click that selects text keeps the cycle where it is, and the next click steps on', () => {
  const first = clickCycle(null, click(), () => ['node', 'inner', 'outer'])
  const word = clickCycle(first.cycle, click({ selectsText: true, selectedIds: ['node'] }), () => [])
  assert.deepEqual(word, { cycle: first.cycle })
  const next = clickCycle(word.cycle, click({ selectedIds: ['node'] }), () => [])
  assert.equal(next.select, 'inner')
  assert.deepEqual(
    clickCycle(null, click({ selectsText: true }), () => ['node']),
    { cycle: null },
  )
})

test('a selection changed elsewhere since the last click starts over', () => {
  const first = clickCycle(null, click(), () => ['node', 'inner'])
  for (const selectedIds of [[], ['other'], ['node', 'other']]) {
    const next = clickCycle(first.cycle, click({ selectedIds }), () => ['node', 'inner'])
    assert.equal(next.select, undefined, `selection ${JSON.stringify(selectedIds)}`)
  }
})

test('a cycle started on a node below the top continues around the stack from it', () => {
  const first = clickCycle(null, click({ nodeId: 'inner' }), () => ['node', 'inner', 'outer'])
  assert.deepEqual(first.cycle?.stack, ['inner', 'outer', 'node'])
  const lost = clickCycle(null, click({ nodeId: 'unknown' }), () => ['node'])
  assert.deepEqual(lost.cycle?.stack, ['unknown'])
})

test('the pointer leaving the spot is told apart from staying on it', () => {
  const cycle: Cycle = { x: 100, y: 100, slop: 4, stack: ['a', 'b'], index: 0 }
  assert.equal(movedAway(cycle, 102, 103), false)
  assert.equal(movedAway(cycle, 104, 104), true)
})

test('a finger gets a wider slop than a mouse', () => {
  assert.equal(slopFor('mouse'), MOUSE_SLOP_PX)
  assert.equal(slopFor('touch'), TOUCH_SLOP_PX)
  assert.equal(slopFor('pen'), TOUCH_SLOP_PX)
  assert.ok(TOUCH_SLOP_PX > MOUSE_SLOP_PX)
})

/** A window-style node: a title bar, and a body with text, a button, a terminal and an edge handle. */
function windowNode(container: HTMLElement): { node: HTMLElement; at: (selector: string) => Element | null } {
  const node = container.ownerDocument.createElement('div')
  node.innerHTML =
    '<div class="title">t</div><div class="body"><span class="text">t</span><button><b class="inside">x</b></button>' +
    '<div class="nodrag"><div class="xterm"><span class="term">$</span></div></div>' +
    '<div class="react-flow__handle"></div></div>'
  container.append(node)
  return { node, at: (selector) => node.querySelector(selector) }
}

const PLAIN = { shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, detail: 1 }

test('what makes a click select text', async () => {
  const dom = await installDomEnvironment()
  try {
    const doc = dom.container.ownerDocument
    const { node, at } = windowNode(dom.container)
    const click = { ...PLAIN, target: at('.text') }

    assert.equal(selectsText(click, node), false)
    assert.equal(selectsText({ ...click, detail: 2 }, node), false, 'a quick click with nothing selected')
    assert.equal(selectsText({ ...click, target: at('.term') }, node), false, 'a terminal, click 1')
    for (const detail of [2, 3]) {
      assert.equal(selectsText({ ...click, detail, target: at('.term') }, node), true, `a terminal, click ${detail}`)
    }

    // Text selected in the node, as a double-click on a word leaves it.
    const word = at('.text')?.firstChild
    assert.ok(word)
    const text = doc.getSelection()
    assert.ok(text)
    text.setBaseAndExtent(word, 0, word, 1)
    const again = { ...click, detail: 2 }
    assert.equal(selectsText(again, node), true, 'text selected where the click landed')
    assert.equal(selectsText(click, node), false, 'a single click on selected text, which clears it after the click')
    assert.equal(selectsText({ ...again, target: at('.title') }, node), false, 'text selected elsewhere in the node')
    text.collapse(word, 0)
    assert.equal(selectsText(again, node), false, 'a caret is not a selection')
    const elsewhere = doc.createElement('p')
    elsewhere.textContent = 'elsewhere'
    dom.container.append(elsewhere)
    const other = elsewhere.firstChild
    assert.ok(other)
    text.setBaseAndExtent(other, 0, other, 4)
    assert.equal(selectsText(again, node), false, 'text selected outside the node')
    text.removeAllRanges()
  } finally {
    dom.cleanup()
  }
})

test('what makes a click plain', async () => {
  const dom = await installDomEnvironment()
  try {
    const doc = dom.container.ownerDocument
    const { node, at } = windowNode(dom.container)
    const plain = { ...PLAIN, target: at('.text') }

    assert.equal(isPlainClick(plain, node), true)
    assert.equal(isPlainClick({ ...plain, detail: 2 }, node), true, 'a quick click')
    assert.equal(isPlainClick({ ...plain, target: at('.term') }, node), true, 'a terminal in a body marked nodrag')
    for (const key of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey'] as const) {
      assert.equal(isPlainClick({ ...plain, [key]: true }, node), false, key)
    }
    for (const selector of ['.inside', '.react-flow__handle']) {
      assert.equal(isPlainClick({ ...plain, target: at(selector) }, node), false, selector)
    }

    // Only what is inside the node counts: a node drawn inside a button
    // still cycles.
    const outside = doc.createElement('div')
    outside.setAttribute('role', 'button')
    outside.append(node)
    dom.container.append(outside)
    assert.equal(isPlainClick(plain, node), true)

    // A resize control drawn outside the node, through a portal, is still its own.
    const portal = doc.createElement('div')
    portal.innerHTML = '<div class="react-flow__resize-control"><span class="dot"></span></div>'
    dom.container.append(portal)
    assert.equal(isPlainClick({ ...plain, target: portal.querySelector('.dot') }, node), false)
  } finally {
    dom.cleanup()
  }
})
