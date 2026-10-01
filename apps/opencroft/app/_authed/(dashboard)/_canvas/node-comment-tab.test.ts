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

function registerFakeExtension(ownTabs: Array<{ id: string; label: string }>): void {
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
      },
    ],
  } as unknown as LoadedDeclaration
  extensionRegistry.register(decl)
}

function inspectorFor(nodeId: string, data: Record<string, unknown> = {}) {
  const props: InspectorProps = {
    node: { id: nodeId, type: 'acme.test.alpha', position: { x: 0, y: 0 }, data },
    expanded: false,
    updateNodeData: () => {},
    onDeselect: () => {},
    onEditExtension: () => {},
    onExpandedChange: () => {},
  }
  return createElement(NodeInspector, props)
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
