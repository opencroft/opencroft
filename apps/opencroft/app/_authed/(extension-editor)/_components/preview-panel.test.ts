// The extension editor's preview draws the node type being edited, and each
// successful compile bumps its version. These tests render the real
// PreviewPanel against the real @xyflow/react library and swap the registered
// component between versions, the way a compile reloads the extension.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { after, afterEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

// The panel imports the canvas stylesheet, which only the bundler can load.
// Styles play no part in what these tests read, so it loads as nothing.
const emptyStylesheets = `export async function load(url, context, nextLoad) {
  return url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : nextLoad(url, context)
}`
register(`data:text/javascript,${encodeURIComponent(emptyStylesheets)}`)

const dom = await installDomEnvironment()

;(globalThis.window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})

// @xyflow/react measures nodes via ResizeObserver, which jsdom does not implement.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis.window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver

// @xyflow/react reads each node's transform; jsdom has no DOMMatrixReadOnly.
// The identity transform is enough to draw a node.
class FakeDOMMatrixReadOnly {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0
}
;(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = FakeDOMMatrixReadOnly
;(globalThis.window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = FakeDOMMatrixReadOnly

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { PreviewPanel } = await import('./preview-panel')
const { extensionRegistry } = await import('@/app/_authed/(extension-runtime)/_client/registry')

type Root = ReturnType<typeof createRoot>
type LoadedDeclaration = import('@/app/_authed/(extension-runtime)/_client/host').LoadedExtensionDeclaration

const TYPE = 'acme.preview.card'

function Throwing(): never {
  throw new Error('card failed to render')
}

function Working() {
  return createElement('span', { 'data-card-body': '' }, 'card body')
}

// What a compile does to the registry: the extension is loaded again and its
// node type now resolves to the newly built component.
function compile(component: () => unknown): void {
  const decl = {
    manifest: { id: 'acme.preview' },
    nodes: [{ type: TYPE, name: 'Card', component }],
  } as unknown as LoadedDeclaration
  extensionRegistry.register(decl)
}

const roots: Root[] = []

async function mountPreview(version: number) {
  const root = createRoot(dom.container)
  roots.push(root)
  await act(async () => root.render(createElement(PreviewPanel, { previewType: TYPE, version })))
  return {
    rerender: async (next: number) => {
      await act(async () => root.render(createElement(PreviewPanel, { previewType: TYPE, version: next })))
    },
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount())
  }
  dom.container.replaceChildren()
  // Nothing else registers in this process, so clearing removes exactly the fake type.
  extensionRegistry.clear()
})

after(() => dom.cleanup())

test('a compile that fixes a throwing component draws the fixed component', async () => {
  const consoleError = console.error
  // React and the render boundary both report the deliberate throw.
  console.error = () => {}
  try {
    compile(Throwing)
    const preview = await mountPreview(1)
    assert.match(dom.container.textContent ?? '', /card failed to render/, 'the failed render shows its error')

    compile(Working)
    await preview.rerender(2)
  } finally {
    console.error = consoleError
  }

  assert.ok(dom.container.querySelector('[data-card-body]'), 'the fixed component is drawn')
  assert.doesNotMatch(dom.container.textContent ?? '', /card failed to render/, 'the error is gone')
})

test('a compile draws the newly built component in place of the previous one', async () => {
  compile(() => createElement('span', { 'data-build': 'first' }))
  const preview = await mountPreview(1)
  assert.ok(dom.container.querySelector('[data-build="first"]'), 'the first build is drawn')

  compile(() => createElement('span', { 'data-build': 'second' }))
  await preview.rerender(2)

  assert.ok(dom.container.querySelector('[data-build="second"]'), 'the second build is drawn')
  assert.equal(dom.container.querySelector('[data-build="first"]'), null, 'the first build is gone')
})
