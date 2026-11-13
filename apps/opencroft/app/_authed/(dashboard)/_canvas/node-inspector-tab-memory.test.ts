// The inspector opens a node on the tab last picked for its node type, so
// moving between nodes of one type keeps the same view. These tests render the
// real NodeInspector and switch the inspected node in one mounted inspector,
// as selecting another node on the canvas does. And the Details tab scrolls
// with its content unless its node type asks it to fill the panel.
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
const { inspectorIntent, registerNodeTypes } = await import('./inspector-intent')
const { extensionRegistry } = await import('@/app/_authed/(extension-runtime)/_client/registry')

type Root = ReturnType<typeof createRoot>
type InspectorProps = import('react').ComponentProps<typeof NodeInspector>
type LoadedDeclaration = import('@/app/_authed/(extension-runtime)/_client/host').LoadedExtensionDeclaration

const Empty = () => null
const Details = () => createElement('span', { 'data-details': '' })

// Each test declares its own node types, so what one test remembers for a type
// is not what another test reads.
function registerTypes(types: Array<{ type: string; tabs: string[]; inspectorFullHeight?: boolean }>): void {
  const decl = {
    manifest: { id: 'acme.test' },
    nodes: types.map(({ type, tabs, inspectorFullHeight }) => ({
      type,
      name: type,
      component: Empty,
      inspector: Details,
      inspectorFullHeight,
      inspectorTabs: tabs.map((id) => ({ id, label: id, component: Empty })),
    })),
  } as unknown as LoadedDeclaration
  extensionRegistry.register(decl)
}

interface Inspected {
  id: string
  type: string
  data?: Record<string, unknown>
}

function inspector(node: Inspected) {
  const props: InspectorProps = {
    node: { id: node.id, type: node.type, position: { x: 0, y: 0 }, data: node.data ?? {} },
    expanded: false,
    updateNodeData: () => {},
    onDeselect: () => {},
    onEditExtension: () => {},
    onExpandedChange: () => {},
  }
  return createElement(ReactFlowProvider, null, createElement(NodeInspector, props))
}

const roots: Root[] = []

// One mounted inspector whose node is swapped, the way a new selection reaches it.
async function mount(first: Inspected) {
  const container = win.document.createElement('div')
  dom.container.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(inspector(first)))
  return {
    container,
    async show(node: Inspected) {
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

function activeTab(container: HTMLElement): string {
  const active = container.querySelector('[role="tab"][aria-selected="true"]')
  return (active?.textContent ?? '').replace(/\d+$/, '')
}

async function pick(container: HTMLElement, label: string): Promise<void> {
  const tab = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
    (t.textContent ?? '').startsWith(label),
  ) as HTMLElement | undefined
  assert.ok(tab, `a ${label} tab exists`)
  await act(async () => tab.click())
}

test('a tab picked on one node is open on the next node of the same type', async () => {
  registerTypes([{ type: 'acme.test.app', tabs: ['logs', 'terminal'] }])
  const view = await mount({ id: 'app-a', type: 'acme.test.app' })
  assert.equal(activeTab(view.container), 'Details')

  await pick(view.container, 'logs')
  await view.show({ id: 'app-b', type: 'acme.test.app' })
  assert.equal(activeTab(view.container), 'logs')
})

test('a node of another type keeps its own tab', async () => {
  registerTypes([
    { type: 'acme.test.app2', tabs: ['logs'] },
    { type: 'acme.test.agent2', tabs: ['tts', 'asr'] },
  ])
  const view = await mount({ id: 'agent-a', type: 'acme.test.agent2' })
  await pick(view.container, 'tts')
  await view.show({ id: 'app-c', type: 'acme.test.app2' })
  await pick(view.container, 'logs')

  await view.show({ id: 'agent-b', type: 'acme.test.agent2' })
  assert.equal(activeTab(view.container), 'tts')
})

test('a node without the remembered tab opens on Details, and the next node that has it opens on it', async () => {
  registerTypes([{ type: 'acme.test.app3', tabs: [] }])
  const failing = { id: 'app-d', type: 'acme.test.app3', data: { __errors: ['container exited'] } }
  const view = await mount(failing)
  await pick(view.container, 'Errors')

  await view.show({ id: 'app-e', type: 'acme.test.app3' })
  assert.equal(activeTab(view.container), 'Details')

  await view.show({ id: 'app-f', type: 'acme.test.app3', data: { __errors: ['image not found'] } })
  assert.equal(activeTab(view.container), 'Errors')
})

test('a tab a node opens on purpose becomes the tab of its type', async () => {
  registerTypes([{ type: 'acme.test.app4', tabs: ['logs', 'terminal'] }])
  const stop = registerNodeTypes((nodeId) => (nodeId.startsWith('app4-') ? 'acme.test.app4' : undefined))
  try {
    const view = await mount({ id: 'app4-a', type: 'acme.test.app4' })
    await act(async () => inspectorIntent.open('app4-a', 'terminal'))
    assert.equal(activeTab(view.container), 'terminal')

    await view.show({ id: 'app4-b', type: 'acme.test.app4' })
    assert.equal(activeTab(view.container), 'terminal')
  } finally {
    stop()
  }
})

test('Details is in a scroll area unless its node type asks to fill the panel', async () => {
  registerTypes([
    { type: 'acme.test.form', tabs: [] },
    { type: 'acme.test.editor', tabs: [], inspectorFullHeight: true },
  ])
  const inScrollArea = (container: HTMLElement) => {
    const details = container.querySelector('[data-details]')
    assert.ok(details, 'the Details tab is rendered')
    return details.closest('[data-slot="scroll-area"]') !== null
  }

  const view = await mount({ id: 'form-a', type: 'acme.test.form' })
  assert.equal(inScrollArea(view.container), true)

  await view.show({ id: 'editor-a', type: 'acme.test.editor' })
  assert.equal(inScrollArea(view.container), false)
})
