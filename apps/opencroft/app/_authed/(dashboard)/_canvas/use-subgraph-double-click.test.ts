// Runs useSubgraphDoubleClick against the real @xyflow/react stack: the
// double click reaches the hook through React Flow's `onNodeDoubleClick`.
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

const { act, createElement, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow, ReactFlowProvider } = await import('@xyflow/react')
const { useSubgraphDoubleClick } = await import('@/app/_authed/(dashboard)/_canvas/use-subgraph-double-click')
const { SUBGRAPH_TYPE } = await import('@/app/_authed/(extension-runtime)/_builtin/core/src/nodes/subgraph-shared')

after(() => dom.cleanup())

const NODES: Node[] = [
  { id: 'sub', type: SUBGRAPH_TYPE, position: { x: 0, y: 0 }, width: 100, height: 60, data: {} },
  { id: 'other', type: 'card', position: { x: 200, y: 0 }, width: 100, height: 60, data: {} },
]

/**
 * A card with a body and a pin. The pin stops its double click from reaching
 * the node, as the canvas's input and output pins do (they disconnect on it).
 */
function Card() {
  return createElement(
    'div',
    null,
    createElement('div', { className: 'body' }, 'card'),
    createElement('div', {
      className: 'pin',
      onDoubleClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
    }),
  )
}
const NODE_TYPES = { [SUBGRAPH_TYPE]: Card, card: Card }

async function mount() {
  const opened: string[] = []
  function Canvas() {
    const [element, setElement] = useState<HTMLDivElement | null>(null)
    const onNodeDoubleClick = useSubgraphDoubleClick({ canvas: element, open: (id) => opened.push(id) })
    return createElement(
      'div',
      { ref: setElement },
      createElement(ReactFlow, { nodes: NODES, edges: [], nodeTypes: NODE_TYPES, onNodeDoubleClick }),
    )
  }
  const host = dom.container.ownerDocument.createElement('div')
  dom.container.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement(ReactFlowProvider, null, createElement(Canvas)))
  })
  const part = (id: string, selector: string) => {
    const el = host.querySelector(`.react-flow__node[data-id="${id}"] ${selector}`)
    assert.ok(el, `expected ${selector} in node ${id}`)
    return el
  }
  /** A double click on `selector` of node `id`, started by a pointer of `pointerType`. */
  const doubleClick = async (id: string, selector: string, pointerType: string) => {
    const target = part(id, selector)
    await act(async () => {
      // jsdom has no PointerEvent; the hook reads only `pointerType`.
      const down = new (win.MouseEvent as typeof MouseEvent)('pointerdown', { bubbles: true })
      Object.defineProperty(down, 'pointerType', { value: pointerType })
      target.dispatchEvent(down)
      target.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)('dblclick', { bubbles: true, detail: 2 }))
    })
  }
  return { opened, doubleClick, unmount: () => act(async () => root.unmount()) }
}

test('a mouse double click on a subgraph card opens it', async () => {
  const canvas = await mount()
  try {
    await canvas.doubleClick('sub', '.body', 'mouse')
    assert.deepEqual(canvas.opened, ['sub'])
  } finally {
    await canvas.unmount()
  }
})

test('a pen double click on a subgraph card opens it', async () => {
  const canvas = await mount()
  try {
    await canvas.doubleClick('sub', '.body', 'pen')
    assert.deepEqual(canvas.opened, ['sub'])
  } finally {
    await canvas.unmount()
  }
})

test('a double tap on a subgraph card opens nothing', async () => {
  const canvas = await mount()
  try {
    await canvas.doubleClick('sub', '.body', 'touch')
    assert.deepEqual(canvas.opened, [])
    // The next mouse double click opens it: the touch does not stick.
    await canvas.doubleClick('sub', '.body', 'mouse')
    assert.deepEqual(canvas.opened, ['sub'])
  } finally {
    await canvas.unmount()
  }
})

test('a double click on any other node opens nothing', async () => {
  const canvas = await mount()
  try {
    await canvas.doubleClick('other', '.body', 'mouse')
    assert.deepEqual(canvas.opened, [])
  } finally {
    await canvas.unmount()
  }
})

test("a double click on a subgraph card's pin opens nothing", async () => {
  const canvas = await mount()
  try {
    await canvas.doubleClick('sub', '.pin', 'mouse')
    assert.deepEqual(canvas.opened, [])
  } finally {
    await canvas.unmount()
  }
})
