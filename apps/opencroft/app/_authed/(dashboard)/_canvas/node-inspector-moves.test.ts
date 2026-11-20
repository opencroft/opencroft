// While a node is dragged or resized, React Flow hands the inspector a new node object on every
// pointer move, with a new position or size and the same `data`. These tests render the real
// NodeInspector and pass it such objects, as the canvas does, and count the renders of the
// node type's own tab and the `updateData` it is given.
import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

;(globalThis.window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})

// The inspector's ScrollArea measures itself through ResizeObserver, which jsdom lacks.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis.window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

const win = globalThis.window as unknown as Window & typeof globalThis

// Radix's ScrollViewport reads Element.getAnimations(), which jsdom lacks.
;(
  globalThis.window as unknown as { Element: { prototype: { getAnimations: () => unknown[] } } }
).Element.prototype.getAnimations = () => []

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlowProvider } = await import('@xyflow/react')
const { NodeInspector } = await import('./node-inspector')
const { inspectorTabs } = await import('./inspector-intent')
const { extensionRegistry } = await import('@/app/_authed/(extension-runtime)/_client/registry')

type Root = ReturnType<typeof createRoot>
type InspectorProps = import('react').ComponentProps<typeof NodeInspector>
type LoadedDeclaration = import('@/app/_authed/(extension-runtime)/_client/host').LoadedExtensionDeclaration
type UpdateData = (patch: Record<string, unknown>) => void
type UpdateNodeData = InspectorProps['updateNodeData']

interface TabRender {
  tab: string
  nodeId: string
  data: unknown
  updateData: UpdateData
}

const Empty = () => null

// Each test declares its own node type: the tab picked is remembered per type.
function registerType(type: string, renders: TabRender[]): void {
  const recording = (tab: string) =>
    function Recording(props: { nodeId: string; data: unknown; updateData: UpdateData }) {
      renders.push({ tab, ...props })
      return createElement('span', { 'data-tab': tab }, tab)
    }
  const decl = {
    manifest: { id: 'acme.test' },
    nodes: [
      {
        type,
        name: type,
        component: Empty,
        inspector: recording('details'),
        inspectorTabs: [{ id: 'shell', label: 'shell', keepMounted: true, component: recording('shell') }],
      },
    ],
  } as unknown as LoadedDeclaration
  extensionRegistry.register(decl)
}

interface Shown {
  id: string
  type: string
  x: number
  y: number
  width?: number
  data: Record<string, unknown>
  updateNodeData: UpdateNodeData
}

// A new node object each time, as React Flow makes one per move.
function inspector(node: Shown) {
  const props: InspectorProps = {
    node: {
      id: node.id,
      type: node.type,
      position: { x: node.x, y: node.y },
      width: node.width,
      data: node.data,
    },
    expanded: false,
    updateNodeData: node.updateNodeData,
    onDeselect: () => {},
    onEditExtension: () => {},
    onExpandedChange: () => {},
  }
  return createElement(ReactFlowProvider, null, createElement(NodeInspector, props))
}

const roots: Root[] = []

async function mount(first: Shown) {
  const container = win.document.createElement('div')
  dom.container.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(inspector(first)))
  return {
    async show(node: Shown) {
      await act(async () => root.render(inspector(node)))
    },
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  dom.container.replaceChildren()
  // Nothing else registers in this process, so clearing removes exactly the fake types.
  extensionRegistry.clear()
})

after(() => dom.cleanup())

const noWrite: UpdateNodeData = () => {}

test('dragging and resizing the node does not render its tab, and its updateData keeps its identity', async () => {
  const renders: TabRender[] = []
  registerType('acme.test.drag', renders)
  const data = { name: 'web' }
  const at = (x: number, y: number, width?: number): Shown => ({
    id: 'node-a',
    type: 'acme.test.drag',
    x,
    y,
    width,
    data,
    updateNodeData: noWrite,
  })
  const view = await mount(at(-40, -25))
  const first = renders.length
  assert.ok(first > 0, 'the Details tab rendered on mount')
  const updateData = renders[renders.length - 1].updateData

  for (let step = 1; step <= 5; step++) {
    await view.show(at(-40 + step * 7, -25 + step * 3))
  }
  for (let step = 1; step <= 5; step++) {
    await view.show(at(-5, -10, 200 + step * 11))
  }

  assert.equal(renders.length, first, 'no render of the tab across 10 moves')
  await view.show({ ...at(0, 0), data: { name: 'web' } })
  assert.equal(renders.length, first + 1, 'a new data object renders the tab once')
  assert.equal(renders[renders.length - 1].updateData, updateData)
})

test('a kept-mounted tab does not render while its node moves, and does when its data changes', async () => {
  const renders: TabRender[] = []
  registerType('acme.test.kept', renders)
  inspectorTabs.set('acme.test.kept', 'shell')
  const data = { name: 'db' }
  const at = (x: number, y: number): Shown => ({
    id: 'node-k',
    type: 'acme.test.kept',
    x,
    y,
    data,
    updateNodeData: noWrite,
  })
  const view = await mount(at(30, -60))
  const shell = () => renders.filter((r) => r.tab === 'shell').length
  const first = shell()
  assert.ok(first > 0, 'the kept tab rendered on mount')

  for (let step = 1; step <= 5; step++) {
    await view.show(at(30 + step * 9, -60 - step * 4))
  }
  assert.equal(shell(), first, 'no render of the kept tab across 5 moves')

  await view.show({ ...at(0, 0), data: { name: 'db2' } })
  assert.equal(shell(), first + 1, 'a new data object renders the kept tab once')
})

test('updateData keeps its identity when the canvas passes a new updateNodeData, and writes through the new one', async () => {
  const renders: TabRender[] = []
  registerType('acme.test.write', renders)
  const data = { name: 'api' }
  const before: Array<[string, Record<string, unknown>]> = []
  const latest: Array<[string, Record<string, unknown>]> = []
  const shown = (updateNodeData: UpdateNodeData): Shown => ({
    id: 'node-w',
    type: 'acme.test.write',
    x: 12,
    y: 8,
    data,
    updateNodeData,
  })
  const view = await mount(shown((id, patch) => before.push([id, patch])))
  const first = renders.length
  const updateData = renders[renders.length - 1].updateData

  await view.show(shown((id, patch) => latest.push([id, patch])))
  assert.equal(renders.length, first, 'a new updateNodeData alone does not render the tab')

  await act(async () => updateData({ name: 'api-2' }))
  assert.deepEqual(latest, [['node-w', { name: 'api-2' }]])
  assert.deepEqual(before, [])
})

test('another node gets an updateData of its own, writing to that node', async () => {
  const renders: TabRender[] = []
  registerType('acme.test.other', renders)
  const writes: Array<[string, Record<string, unknown>]> = []
  const write: UpdateNodeData = (id, patch) => writes.push([id, patch])
  const node = (id: string): Shown => ({ id, type: 'acme.test.other', x: 0, y: 0, data: { id }, updateNodeData: write })
  const view = await mount(node('node-1'))
  const firstUpdate = renders[renders.length - 1].updateData

  await view.show(node('node-2'))
  const last = renders[renders.length - 1]
  assert.equal(last.nodeId, 'node-2')
  assert.notEqual(last.updateData, firstUpdate)

  await act(async () => last.updateData({ x: 1 }))
  assert.deepEqual(writes, [['node-2', { x: 1 }]])
})
