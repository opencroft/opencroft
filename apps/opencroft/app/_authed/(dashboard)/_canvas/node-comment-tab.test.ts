// Every node's inspector ends in a Comment tab, whatever its type, and the tab
// edits `data.comment` with the time it was edited. These tests render the real
// NodeInspector and NodeCommentTab against a real DOM: the tab order is what a
// user sees, and the textarea's change handling only runs on a real input event.
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
const { NodeCommentTab } = await import('./node-comment-tab')
const { extensionRegistry } = await import('@/app/_authed/(extension-runtime)/_client/registry')

type Root = ReturnType<typeof createRoot>
type InspectorProps = import('react').ComponentProps<typeof NodeInspector>
type LoadedDeclaration = import('@/app/_authed/(extension-runtime)/_client/host').LoadedExtensionDeclaration

const roots: Root[] = []

async function render(element: import('react').ReactElement) {
  const container = win.document.createElement('div')
  dom.container.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(element)
  })
  return container
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

const Empty = () => null
const Details = () => createElement('p', null, 'details body')

function registerFakeExtension(
  ownTabs: Array<{ id: string; label: string }>,
  errors?: (node: { id: string }) => Array<{ title: string }>,
): void {
  const tabs = ownTabs.map((tab) => ({ ...tab, component: Empty }))
  const decl = {
    manifest: { id: 'acme.test' },
    nodes: [
      {
        type: 'acme.test.alpha',
        name: 'Alpha',
        component: Empty,
        inspector: Details,
        inspectorTabs: tabs.length > 0 ? tabs : undefined,
        errors,
      },
    ],
  } as unknown as LoadedDeclaration
  extensionRegistry.register(decl)
}

// Inside a ReactFlow provider, as the canvas renders it: the inspector reads the graph's edges for
// the node's derived errors.
function inspectorFor(nodeId: string, data: Record<string, unknown> = {}) {
  const props: InspectorProps = {
    node: { id: nodeId, type: 'acme.test.alpha', position: { x: 0, y: 0 }, data },
    expanded: false,
    updateNodeData: () => {},
    onDeselect: () => {},
    onEditExtension: () => {},
    onExpandedChange: () => {},
  }
  return createElement(ReactFlowProvider, null, createElement(NodeInspector, props))
}

function tabLabels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[role="tab"]')).map((tab) => tab.textContent ?? '')
}

async function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  // React tracks the value it last rendered; assigning through the element's
  // own property would be swallowed as "no change", so go through the native setter.
  const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set
  assert.ok(setter, 'jsdom exposes a native textarea value setter')
  await act(async () => {
    setter.call(textarea, value)
    textarea.dispatchEvent(new win.Event('input', { bubbles: true }))
  })
}

function textareaIn(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector('textarea')
  assert.ok(textarea, 'the comment textarea is rendered')
  return textarea
}

test('a node type with two own tabs shows Details, those tabs, then Comment', async () => {
  registerFakeExtension([
    { id: 'alpha', label: 'Alpha tab' },
    { id: 'beta', label: 'Beta tab' },
  ])
  const container = await render(inspectorFor('node-1'))

  assert.deepEqual(tabLabels(container), ['Details', 'Alpha tab', 'Beta tab', 'Comment'])
})

test('a node type with no own tabs shows only Details then Comment', async () => {
  registerFakeExtension([])
  const container = await render(inspectorFor('node-2'))

  assert.deepEqual(tabLabels(container), ['Details', 'Comment'])
})

async function openTab(container: HTMLElement, label: string): Promise<void> {
  const tab = Array.from(container.querySelectorAll('[role="tab"]')).find((t) =>
    (t.textContent ?? '').startsWith(label),
  ) as HTMLElement | undefined
  assert.ok(tab, `a ${label} tab exists`)
  await act(async () => {
    tab.click()
  })
}

test('a node with stored errors shows an Errors tab with their count right after Details, and the tab lists them', async () => {
  registerFakeExtension([{ id: 'alpha', label: 'Alpha tab' }])
  const container = await render(
    inspectorFor('node-4', {
      __errors: [
        { source: 'connection', title: 'Cannot reach the daemon', detail: 'connection refused', code: 'Exit code 1' },
        'lamp is broken',
      ],
    }),
  )

  const labels = tabLabels(container)
  assert.deepEqual(
    labels.map((label) => label.replace(/\d+$/, '')),
    ['Details', 'Errors', 'Alpha tab', 'Comment'],
  )
  assert.match(labels[1], /2$/, 'the Errors tab carries the count')

  await openTab(container, 'Errors')
  const text = container.textContent ?? ''
  assert.ok(text.includes('Cannot reach the daemon'))
  assert.ok(text.includes('connection refused'))
  assert.ok(text.includes('Exit code 1'))
  assert.ok(text.includes('lamp is broken'))
})

test('errors a node type derives from the canvas show in the Errors tab too, and a check that throws shows none', async () => {
  registerFakeExtension([], (node) => [{ title: `No handler on ${node.id}` }])
  const container = await render(inspectorFor('node-5'))
  await openTab(container, 'Errors')
  assert.ok((container.textContent ?? '').includes('No handler on node-5'))

  extensionRegistry.clear()
  registerFakeExtension([], () => {
    throw new Error('broken check')
  })
  const original = console.error
  console.error = () => {}
  try {
    const other = await render(inspectorFor('node-6'))
    assert.deepEqual(tabLabels(other), ['Details', 'Comment'])
  } finally {
    console.error = original
  }
})

test('selecting the Comment tab shows the textarea holding the node comment', async () => {
  registerFakeExtension([{ id: 'alpha', label: 'Alpha tab' }])
  const container = await render(inspectorFor('node-3', { comment: 'Feeds the nightly export.' }))
  // A boolean, not assert.equal against null: a failing equal would try to diff the jsdom element.
  assert.ok(!container.querySelector('textarea'), 'the comment is not shown on the Details tab')

  const commentTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
    (tab) => tab.textContent === 'Comment',
  ) as HTMLElement | undefined
  assert.ok(commentTab, 'a Comment tab exists')
  await act(async () => {
    commentTab.click()
  })

  assert.equal(textareaIn(container).value, 'Feeds the nightly export.')
})

test('typing a comment calls updateData with the text and a valid ISO edit time', async () => {
  const patches: Array<Record<string, unknown>> = []
  const container = await render(createElement(NodeCommentTab, { data: {}, updateData: (p) => patches.push(p) }))

  await setTextareaValue(textareaIn(container), 'Owned by the data team.')

  assert.equal(patches.length, 1)
  assert.equal(patches[0].comment, 'Owned by the data team.')
  const stamp = patches[0].commentUpdatedAt
  assert.equal(typeof stamp, 'string')
  const parsed = new Date(stamp as string)
  assert.ok(!Number.isNaN(parsed.getTime()), 'commentUpdatedAt parses as a date')
  assert.equal(parsed.toISOString(), stamp, 'commentUpdatedAt is in ISO form')
})

test('clearing the comment calls updateData with comment and commentUpdatedAt both undefined', async () => {
  const patches: Array<Record<string, unknown>> = []
  const container = await render(
    createElement(NodeCommentTab, {
      data: { comment: 'Old note.', commentUpdatedAt: '2026-01-02T03:04:05.000Z' },
      updateData: (p) => patches.push(p),
    }),
  )

  await setTextareaValue(textareaIn(container), '')

  assert.equal(patches.length, 1)
  // `in` matters: a patch that merely omitted the keys would leave the old values in the node.
  assert.ok('comment' in patches[0] && patches[0].comment === undefined)
  assert.ok('commentUpdatedAt' in patches[0] && patches[0].commentUpdatedAt === undefined)
})

test('with no comment the label reads "No comment yet."', async () => {
  const container = await render(createElement(NodeCommentTab, { data: {}, updateData: () => {} }))

  assert.equal(container.querySelector('p')?.textContent, 'No comment yet.')
})

test('a comment with an edit time shows "Edited " followed by the local time', async () => {
  const stamp = '2026-01-02T03:04:05.000Z'
  const container = await render(
    createElement(NodeCommentTab, { data: { comment: 'A note.', commentUpdatedAt: stamp }, updateData: () => {} }),
  )

  const label = container.querySelector('p')?.textContent ?? ''
  assert.ok(label.startsWith('Edited '), `label was "${label}"`)
  assert.equal(label, `Edited ${new Date(stamp).toLocaleString()}`)
})

test('a comment without an edit time shows "Edit time not recorded."', async () => {
  const container = await render(createElement(NodeCommentTab, { data: { comment: 'A note.' }, updateData: () => {} }))

  assert.equal(container.querySelector('p')?.textContent, 'Edit time not recorded.')
})
