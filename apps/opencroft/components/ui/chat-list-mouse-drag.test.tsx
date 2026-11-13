// The kit's chat list under a mouse, in a real DOM: native drag and drop files
// a chat into a folder, out to the top level and between rows, and reorders
// folders by the header the pointer is over -- never onto the folder itself.
//
// Lives in the app workspace, like chat-list-long-press.test.tsx, because the
// app's tsconfig.test.json claims packages/ui source for rendering a shared
// component under a runner that has a DOM.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

// Type-only, so erased: it does not reach react-dom before the DOM exists.
import type { ChatListNode } from 'ui/chat/chat-list'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>
for (const name of ['Event', 'MouseEvent']) {
  globals[name] = win[name]
}

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ChatList } = await import('ui/chat/chat-list')

after(() => dom.cleanup())

const NODES: ChatListNode[] = [
  { type: 'folder', folder: { id: 'folder-a', name: 'Folder A', items: [] } },
  { type: 'folder', folder: { id: 'folder-b', name: 'Folder B', items: [{ id: 'chat-c', title: 'Charlie' }] } },
  { type: 'item', item: { id: 'chat-a', title: 'Alpha' } },
  { type: 'item', item: { id: 'chat-b', title: 'Bravo' } },
]

async function mount(nodes: ChatListNode[] = NODES) {
  const changes: ChatListNode[][] = []
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(<ChatList nodes={nodes} onChange={(next) => changes.push(next)} />)
  })
  return {
    changes,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

const rowOf = (id: string) => dom.container.querySelector(`[data-row-id="${id}"]`) as HTMLElement
const headerOf = (id: string) => dom.container.querySelector(`[data-folder-id="${id}"]`) as HTMLElement
const rowOrder = () =>
  [...dom.container.querySelectorAll('[data-row-id]')].map((el) => (el as HTMLElement).dataset.rowId)
const folderOrder = () =>
  [...dom.container.querySelectorAll('[data-folder-header]')].map((el) => (el as HTMLElement).dataset.folderId)

// jsdom lays nothing out; a box gives the pointer a half of the element to be in.
function giveBox(el: HTMLElement, top: number, height: number) {
  el.getBoundingClientRect = () =>
    ({ top, height, bottom: top + height, left: 0, right: 200, width: 200, x: 0, y: top }) as DOMRect
}

// One native drag event; jsdom has no DragEvent, so a plain event carries what React reads.
async function dragEvent(type: string, target: Element, y = 0): Promise<Event> {
  const EventCtor = win.Event as typeof Event
  const event = new EventCtor(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    clientX: 10,
    clientY: y,
    dataTransfer: { effectAllowed: '', dropEffect: '', setData() {}, getData: () => '' },
  })
  await act(async () => {
    target.dispatchEvent(event)
  })
  return event
}

// Drags `from` and releases it over `to` at height `y`; whether `to` took the drag.
async function dragOnto(from: HTMLElement, to: Element, y = 0): Promise<boolean> {
  await dragEvent('dragstart', from)
  const over = await dragEvent('dragover', to, y)
  await dragEvent('drop', to, y)
  await dragEvent('dragend', from)
  return over.defaultPrevented
}

test('a chat dropped on a folder header is filed into that folder', async () => {
  const { changes, unmount } = await mount()
  try {
    assert.equal(await dragOnto(rowOf('chat-a'), headerOf('folder-a')), true)
    assert.equal(changes.length, 1)
    const folder = changes[0].find((n) => n.type === 'folder' && n.folder.id === 'folder-a')
    assert.deepEqual(folder?.type === 'folder' ? folder.folder.items.map((i) => i.id) : null, ['chat-a'])
  } finally {
    await unmount()
  }
})

test('a chat dropped on the upper half of a row lands before it, across lists', async () => {
  const { unmount } = await mount()
  try {
    giveBox(rowOf('chat-a'), 100, 40)
    await dragOnto(rowOf('chat-c'), rowOf('chat-a'), 110)
    assert.deepEqual(rowOrder(), ['chat-c', 'chat-a', 'chat-b'])
  } finally {
    await unmount()
  }
})

test('a folder dropped on the upper half of another header moves above it', async () => {
  const { unmount } = await mount()
  try {
    giveBox(headerOf('folder-a'), 0, 20)
    assert.equal(await dragOnto(headerOf('folder-b'), headerOf('folder-a'), 5), true)
    assert.deepEqual(folderOrder(), ['folder-b', 'folder-a'])
  } finally {
    await unmount()
  }
})

test('a folder over its own header or a chat row offers no drop', async () => {
  const { changes, unmount } = await mount()
  try {
    assert.equal(await dragOnto(headerOf('folder-b'), headerOf('folder-b')), false)
    assert.equal(await dragOnto(headerOf('folder-b'), rowOf('chat-a')), false)
    assert.deepEqual(changes, [])
  } finally {
    await unmount()
  }
})

test('with no loose chats, a chat dragged out of its folder lands on the top-level zone', async () => {
  const { unmount } = await mount([NODES[0], NODES[1]])
  try {
    await dragEvent('dragstart', rowOf('chat-c'))
    const zone = dom.container.querySelector('[data-top-level-zone]')
    assert.ok(zone, 'the zone shows during the drag')
    await dragEvent('dragover', zone)
    await dragEvent('drop', zone)
    await dragEvent('dragend', rowOf('chat-c'))
    assert.equal(dom.container.querySelector('[data-top-level-zone]'), null)
    // The chat is loose now, below the folders.
    const loose = [...dom.container.querySelectorAll('[data-row-list="items"]')].map(
      (el) => (el as HTMLElement).dataset.rowId,
    )
    assert.deepEqual(loose, ['chat-c'])
  } finally {
    await unmount()
  }
})
