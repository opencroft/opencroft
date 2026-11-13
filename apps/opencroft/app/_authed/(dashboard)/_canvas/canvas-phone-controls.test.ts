// The canvas's controls on a phone: the inspector, which already covers the
// screen there, has no Expand button. These render the real NodeInspector.
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
const { extensionRegistry } = await import('@/app/_authed/(extension-runtime)/_client/registry')

type Root = ReturnType<typeof createRoot>
type InspectorProps = import('react').ComponentProps<typeof NodeInspector>
type LoadedDeclaration = import('@/app/_authed/(extension-runtime)/_client/host').LoadedExtensionDeclaration

const Empty = () => null

extensionRegistry.register({
  manifest: { id: 'acme.test' },
  nodes: [{ type: 'acme.test.app', name: 'App', component: Empty, inspector: Empty }],
} as unknown as LoadedDeclaration)

const roots: Root[] = []

async function render(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const container = win.document.createElement('div')
  dom.container.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => root.render(element))
  return container
}

function inspector(props: Partial<InspectorProps>) {
  return createElement(
    ReactFlowProvider,
    null,
    createElement(NodeInspector, {
      node: { id: 'app-a', type: 'acme.test.app', position: { x: 0, y: 0 }, data: {} },
      expanded: false,
      updateNodeData: () => {},
      onDeselect: () => {},
      onEditExtension: () => {},
      ...props,
    }),
  )
}

function buttonTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('button')).map((b) => b.title)
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  dom.container.replaceChildren()
})

after(() => {
  extensionRegistry.clear()
  dom.cleanup()
})

test('the inspector offers Expand where it can expand, and only Close where it cannot', async () => {
  const docked = await render(inspector({ onExpandedChange: () => {} }))
  assert.ok(buttonTitles(docked).includes('Expand'))
  assert.ok(buttonTitles(docked).includes('Close'))

  const phone = await render(inspector({}))
  assert.ok(!buttonTitles(phone).includes('Expand'))
  assert.ok(!buttonTitles(phone).includes('Collapse'))
  assert.ok(buttonTitles(phone).includes('Close'))
})
