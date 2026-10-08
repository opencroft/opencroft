// The kit's chat list opening and closing folders, in a real DOM: a toggle is
// reported to the host without touching the tree it publishes, and an `open`
// the host hands back is followed when it changes and only then.
//
// Lives in the app workspace beside chat-list-long-press.test.tsx, for the same
// reason: the app's test tsconfig is what renders packages/ui source.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

// Type-only, so erased: it does not reach react-dom before the DOM exists.
import type { ChatListNode } from 'ui/chat/chat-list'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>
for (const name of ['Event', 'MouseEvent', 'MutationObserver']) {
  globals[name] = win[name]
}
globals.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ChatList } = await import('ui/chat/chat-list')

after(() => dom.cleanup())

function folders(open?: boolean): ChatListNode[] {
  return [
    { type: 'folder', folder: { id: 'folder-a', name: 'Folder A', open, items: [{ id: 'chat-a', title: 'Alpha' }] } },
    { type: 'item', item: { id: 'chat-b', title: 'Bravo' } },
  ]
}

interface Mounted {
  render: (nodes: ChatListNode[]) => Promise<void>
  unmount: () => Promise<void>
  toggles: [string, boolean][]
  changes: ChatListNode[][]
}

async function mount(nodes: ChatListNode[]): Promise<Mounted> {
  const root = createRoot(dom.container)
  const toggles: [string, boolean][] = []
  const changes: ChatListNode[][] = []
  const render = async (next: ChatListNode[]) => {
    await act(async () => {
      root.render(
        <ChatList
          nodes={next}
          onChange={(n) => changes.push(n)}
          onFolderOpenChange={(id, open) => toggles.push([id, open])}
        />,
      )
    })
  }
  await render(nodes)
  return {
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
    toggles,
    changes,
  }
}

function folderShowsItsChat(): boolean {
  return dom.container.querySelector('[data-row-id="chat-a"]') !== null
}

async function clickFolderHeader() {
  const button = dom.container.querySelector('[data-folder-id="folder-a"] button')
  assert.ok(button, 'the folder header rendered')
  await act(async () => {
    button.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)('click', { bubbles: true }))
  })
}

test('a folder the host leaves alone starts open, and a click closes it and reports that', async () => {
  const list = await mount(folders())
  try {
    assert.equal(folderShowsItsChat(), true)
    await clickFolderHeader()
    assert.equal(folderShowsItsChat(), false)
    assert.deepEqual(list.toggles, [['folder-a', false]])
    assert.deepEqual(list.changes, [], 'opening a folder is not a change to the tree')
  } finally {
    await list.unmount()
  }
})

test('a folder starts the way the host says', async () => {
  const list = await mount(folders(false))
  try {
    assert.equal(folderShowsItsChat(), false)
  } finally {
    await list.unmount()
  }
})

test("a change to the host's open is followed", async () => {
  const list = await mount(folders(true))
  try {
    await list.render(folders(false))
    assert.equal(folderShowsItsChat(), false)
    await list.render(folders(true))
    assert.equal(folderShowsItsChat(), true)
  } finally {
    await list.unmount()
  }
})

// A host that does not track the toggle keeps handing back the same value; the
// user's click must still stand when the list re-renders for any other reason.
test("an unchanged host open does not undo the user's toggle", async () => {
  const list = await mount(folders(true))
  try {
    await clickFolderHeader()
    await list.render([...folders(true), { type: 'item', item: { id: 'chat-c', title: 'Charlie' } }])
    assert.equal(dom.container.querySelector('[data-row-id="chat-c"]') !== null, true, 'the re-render landed')
    assert.equal(folderShowsItsChat(), false)
  } finally {
    await list.unmount()
  }
})
