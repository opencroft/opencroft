// Runs useClickCycle against the real @xyflow/react stack: React Flow selects
// the node a click lands on before `onNodeClick` runs, and the cycled
// selection has to win over that within the same click.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { Node } from '@xyflow/react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class FakeDOMMatrixReadOnly {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0
}
const globals = globalThis as unknown as Record<string, unknown>
const win = globals.window as unknown as Record<string, unknown>
win.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
globals.ResizeObserver = FakeResizeObserver
win.ResizeObserver = FakeResizeObserver
globals.DOMMatrixReadOnly = FakeDOMMatrixReadOnly
win.DOMMatrixReadOnly = FakeDOMMatrixReadOnly
globals.SVGElement = win.SVGElement

const { act, createElement, useCallback, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow, ReactFlowProvider, useNodesState } = await import('@xyflow/react')
const { useClickCycle } = await import('@/app/_authed/(dashboard)/_canvas/use-click-cycle')
const { selectOnly } = await import('@/app/_authed/(dashboard)/_canvas/inspect-node')

after(() => dom.cleanup())

const isFrame = (n: Node) => n.type === 'frame'

// The tree as the canvas hands it to React Flow: every parent before its
// children, a child's position relative to its parent. The card's absolute
// box is (100, 100) to (150, 150).
const NODES: Node[] = [
  { id: 'outer', type: 'frame', position: { x: 0, y: 0 }, width: 400, height: 300, data: {} },
  { id: 'inner', type: 'frame', parentId: 'outer', position: { x: 50, y: 50 }, width: 200, height: 150, data: {} },
  { id: 'card', type: 'window', parentId: 'inner', position: { x: 50, y: 50 }, width: 50, height: 50, data: {} },
]

/** A window node: a title bar to drag it by, and a body marked `nodrag` holding text and a terminal. */
function WindowNode() {
  return createElement(
    'div',
    null,
    createElement('div', { className: 'title' }, 'card'),
    createElement(
      'div',
      { className: 'body nodrag' },
      createElement('span', { className: 'text' }, 'text'),
      createElement('div', { className: 'xterm' }, createElement('span', { className: 'row' }, '$')),
    ),
  )
}
const NODE_TYPES = { window: WindowNode }

/** A controlled canvas wired as flow-editor wires it: the cycle selects through the same state React Flow's changes apply to. */
function Canvas() {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState(NODES)
  const select = useCallback((id: string) => setNodes((nds) => selectOnly(nds, id)), [setNodes])
  const onNodeClick = useClickCycle({ canvas: element, select, isFrame })
  return createElement(
    'div',
    { ref: setElement },
    createElement(ReactFlow, {
      nodes,
      edges: [],
      nodeTypes: NODE_TYPES,
      onNodesChange,
      onNodeClick,
      multiSelectionKeyCode: 'Shift',
    }),
  )
}

async function mount() {
  const host = dom.container.ownerDocument.createElement('div')
  dom.container.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(ReactFlowProvider, null, createElement(Canvas)))
  })
  const selected = () =>
    [...host.querySelectorAll('.react-flow__node.selected')].map((el) => el.getAttribute('data-id'))
  const nodeAt = (id: string) => {
    const el = host.querySelector(`.react-flow__node[data-id="${id}"]`)
    assert.ok(el, `expected node ${id} to render`)
    return el
  }
  // jsdom has no layout, so the element a browser would hit is named: the card
  // is what lies on top at its own spot, and `selector` names the part of it clicked.
  const part = (id: string, selector: string) => {
    const el = nodeAt(id).querySelector(selector)
    assert.ok(el, `expected ${selector} in node ${id}`)
    return el
  }
  const click = async (id: string, x: number, y: number, init: MouseEventInit = {}, selector = '.title') => {
    const target = part(id, selector)
    await act(async () => {
      target.dispatchEvent(
        new (win.MouseEvent as typeof MouseEvent)('click', {
          bubbles: true,
          clientX: x,
          clientY: y,
          detail: 1,
          ...init,
        }),
      )
    })
    return selected()
  }
  const move = async (x: number, y: number) => {
    await act(async () => {
      nodeAt('card').dispatchEvent(
        new (win.MouseEvent as typeof MouseEvent)('pointermove', { bubbles: true, clientX: x, clientY: y }),
      )
    })
  }
  const key = async (type: 'keydown' | 'keyup') => {
    await act(async () => {
      dom.container.ownerDocument.dispatchEvent(
        new (win.KeyboardEvent as typeof KeyboardEvent)(type, { bubbles: true, key: 'Shift', code: 'ShiftLeft' }),
      )
    })
  }
  return {
    part,
    click,
    move,
    key,
    unmount: () => act(async () => root.unmount()),
  }
}

test('clicking the card spot again selects the card, the inner section, the outer section, then the card', async () => {
  const canvas = await mount()
  try {
    assert.deepEqual(await canvas.click('card', 110, 110), ['card'])
    assert.deepEqual(await canvas.click('card', 110, 110), ['inner'])
    assert.deepEqual(await canvas.click('card', 111, 109), ['outer'])
    assert.deepEqual(await canvas.click('card', 110, 110), ['card'])
  } finally {
    await canvas.unmount()
  }
})

test('moving away between clicks starts over at the top', async () => {
  const canvas = await mount()
  try {
    assert.deepEqual(await canvas.click('card', 110, 110), ['card'])
    await canvas.move(140, 140)
    await canvas.move(110, 110)
    assert.deepEqual(await canvas.click('card', 110, 110), ['card'])
    assert.deepEqual(await canvas.click('card', 110, 110), ['inner'])
  } finally {
    await canvas.unmount()
  }
})

test('clicks on a body marked nodrag cycle, and so do quick ones', async () => {
  const canvas = await mount()
  try {
    assert.deepEqual(await canvas.click('card', 110, 110, {}, '.text'), ['card'])
    assert.deepEqual(await canvas.click('card', 110, 110, { detail: 2 }, '.text'), ['inner'])
    assert.deepEqual(await canvas.click('card', 110, 110, { detail: 3 }, '.text'), ['outer'])
    assert.deepEqual(await canvas.click('card', 110, 110, { detail: 4 }), ['card'])
  } finally {
    await canvas.unmount()
  }
})

test('a double or triple click in a terminal keeps the node, and the next click steps on', async () => {
  const canvas = await mount()
  try {
    assert.deepEqual(await canvas.click('card', 110, 110, {}, '.row'), ['card'])
    assert.deepEqual(await canvas.click('card', 110, 110, { detail: 2 }, '.row'), ['card'])
    assert.deepEqual(await canvas.click('card', 110, 110, { detail: 3 }, '.row'), ['card'])
    assert.deepEqual(await canvas.click('card', 110, 110, {}, '.row'), ['inner'])
    assert.deepEqual(await canvas.click('card', 110, 110, {}, '.row'), ['outer'])
  } finally {
    await canvas.unmount()
  }
})

test('a double-click that selects a word keeps the node, and the next click steps on', async () => {
  const canvas = await mount()
  try {
    assert.deepEqual(await canvas.click('card', 110, 110, {}, '.text'), ['card'])
    // The browser selects the word between the double-click's two clicks,
    // and clears it only after the next single click.
    const word = canvas.part('card', '.text').firstChild
    assert.ok(word)
    const text = dom.container.ownerDocument.getSelection()
    assert.ok(text)
    text.setBaseAndExtent(word, 0, word, 4)
    assert.deepEqual(await canvas.click('card', 110, 110, { detail: 2 }, '.text'), ['card'])
    assert.deepEqual(await canvas.click('card', 110, 110, {}, '.text'), ['inner'])
    text.removeAllRanges()
    assert.deepEqual(await canvas.click('card', 110, 110, {}, '.text'), ['outer'])
  } finally {
    await canvas.unmount()
  }
})

test('a Shift-click keeps React Flow selection', async () => {
  const canvas = await mount()
  try {
    assert.deepEqual(await canvas.click('card', 110, 110), ['card'])
    assert.deepEqual(await canvas.click('card', 110, 110), ['inner'])
    // React Flow reads Shift from the key itself, not from the click.
    await canvas.key('keydown')
    assert.deepEqual(await canvas.click('card', 110, 110, { shiftKey: true }), ['inner', 'card'])
    await canvas.key('keyup')
  } finally {
    await canvas.unmount()
  }
})
