// A pin's tooltip must leave the pin's own events to React Flow. A click on a
// pin starts a click connection (React Flow's `connectOnClick`, on by
// default), and a pin given a `tip` takes it the same as one without. A tip
// that comes and goes leaves the handle element in place.
//
// The pins are the host's `OutputHandle`, drawn by a node component inside a
// real React Flow against a DOM; the click is read back from the flow's store.
import assert from 'node:assert/strict'
import test, { after, afterEach, beforeEach } from 'node:test'

import type { Node } from '@xyflow/react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// @xyflow/react measures nodes with ResizeObserver and reads their transform
// as a DOMMatrixReadOnly; jsdom has neither. Stubs are enough to mount nodes.
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
for (const scope of [globalThis, globalThis.window] as unknown as Record<string, unknown>[]) {
  scope.ResizeObserver = FakeResizeObserver
  scope.DOMMatrixReadOnly = FakeDOMMatrixReadOnly
}

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow, ReactFlowProvider, useStoreApi } = await import('@xyflow/react')
const { OutputHandle } = await import('./host')
const { loadedDeclaration } = await import('./loaded-declaration')
const { extensionRegistry } = await import('./registry')

type ExtensionDeclaration = import('./host').ExtensionDeclaration
type FlowStore = ReturnType<typeof useStoreApi>

after(() => dom.cleanup())

function Source({ data }: { data: Record<string, unknown> }) {
  const tip = typeof data.tip === 'string' ? data.tip : undefined
  return createElement(
    'div',
    null,
    createElement(OutputHandle, { type: 'info', id: 'tipped', tip }),
    createElement(OutputHandle, { type: 'info', id: 'plain' }),
  )
}

const declaration: ExtensionDeclaration = {
  manifest: {},
  handleTypes: [{ id: 'info', label: 'Info', color: 'green' }],
  nodes: [
    {
      type: 'source',
      name: 'Source',
      component: Source,
      handles: [
        { id: 'tipped', role: 'source', handleType: 'info' },
        { id: 'plain', role: 'source', handleType: 'info' },
      ],
    },
  ],
}

const defaultNodes: Node[] = [
  { id: 'source-1', type: 'acme.media.source', position: { x: 0, y: 0 }, data: { tip: '"cat_007.png"' } },
]
const nodeTypes = { 'acme.media.source': Source }

let root: ReturnType<typeof createRoot> | undefined

beforeEach(() => {
  extensionRegistry.register(loadedDeclaration(declaration, { id: 'acme.media', folder: 'acme.media' }))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  extensionRegistry.clear()
})

async function mount(): Promise<FlowStore> {
  let store: FlowStore | undefined
  function StoreProbe() {
    store = useStoreApi()
    return null
  }
  root = createRoot(dom.container)
  await act(async () => {
    root?.render(
      createElement(
        ReactFlowProvider,
        null,
        createElement(ReactFlow, { defaultNodes, nodeTypes }),
        createElement(StoreProbe),
      ),
    )
  })
  assert.ok(store)
  return store
}

async function clickPin(handleId: string) {
  const pin = dom.container.querySelector(`.react-flow__handle[data-handleid="${handleId}"]`)
  assert.ok(pin, `pin ${handleId} is drawn`)
  const MouseEventCtor = (globalThis.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent
  await act(async () => {
    pin.dispatchEvent(new MouseEventCtor('click', { bubbles: true, button: 0 }))
  })
}

test('a pin whose tip comes and goes keeps the same handle element', async () => {
  const store = await mount()
  const pin = () => dom.container.querySelector('.react-flow__handle[data-handleid="tipped"]')
  const before = pin()
  assert.ok(before, 'the pin is drawn')

  const setTip = (data: Record<string, unknown>) =>
    act(async () => {
      const { nodes, setNodes } = store.getState()
      setNodes(nodes.map((n) => ({ ...n, data })))
    })
  // Compared by identity: a failing assert.equal would print both elements,
  // and inspecting a jsdom element walks the whole document.
  await setTip({})
  assert.ok(pin() === before, 'losing the tip keeps the handle element')
  await setTip({ tip: '"cat_007.png"' })
  assert.ok(pin() === before, 'gaining the tip keeps the handle element')
})

for (const handleId of ['plain', 'tipped']) {
  test(`a click on the ${handleId} pin starts a click connection from it`, async () => {
    const store = await mount()
    assert.equal(store.getState().connectionClickStartHandle, null)

    await clickPin(handleId)
    assert.deepEqual(store.getState().connectionClickStartHandle, {
      nodeId: 'source-1',
      type: 'source',
      id: handleId,
    })
  })
}
