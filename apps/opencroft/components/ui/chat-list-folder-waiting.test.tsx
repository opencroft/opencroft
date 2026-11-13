// The kit's chat list marking a closed folder whose chats are waiting, in a
// real DOM: the header shows the waiting count while the folder is closed,
// follows the items' status as the host re-renders, and draws nothing while the
// folder is open, where each row shows its own dot.
//
// Lives in the app workspace beside chat-list-folder-open.test.tsx, for the
// same reason: the app's test tsconfig is what renders packages/ui source.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

// Type-only, so erased: it does not reach react-dom before the DOM exists.
import type { ChatListNode } from 'ui/chat/chat-list'
import type { ChatStatus } from 'ui/chat/chat-list-item'

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

// Folder A holds three chats; a loose waiting chat beside it must never count
// towards the folder.
function nodes(open: boolean | undefined, statuses: [ChatStatus?, ChatStatus?, ChatStatus?]): ChatListNode[] {
  return [
    {
      type: 'folder',
      folder: {
        id: 'folder-a',
        name: 'Folder A',
        open,
        items: statuses.map((status, i) => ({ id: `chat-${i}`, title: `Chat ${i}`, status })),
      },
    },
    { type: 'item', item: { id: 'loose', title: 'Loose', status: 'waiting' } },
  ]
}

async function mount(initial: ChatListNode[]) {
  const root = createRoot(dom.container)
  const render = async (next: ChatListNode[]) => {
    await act(async () => {
      root.render(<ChatList nodes={next} />)
    })
  }
  await render(initial)
  return {
    render,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

function waitingBadge(): string | null {
  const badge = dom.container.querySelector<HTMLElement>('[data-folder-id="folder-a"] [data-folder-waiting]')
  return badge ? (badge.textContent ?? '') : null
}

test('a closed folder shows how many of its chats are waiting', async () => {
  const list = await mount(nodes(false, ['waiting', 'working', 'waiting']))
  try {
    assert.equal(waitingBadge(), '2 waiting')
  } finally {
    await list.unmount()
  }
})

test('a closed folder with no waiting chat shows no badge', async () => {
  const list = await mount(nodes(false, ['working', 'idle', undefined]))
  try {
    assert.equal(waitingBadge(), null)
  } finally {
    await list.unmount()
  }
})

test('an open folder shows no badge, since its rows show their own dots', async () => {
  const list = await mount(nodes(true, ['waiting', 'waiting', 'idle']))
  try {
    assert.ok(dom.container.querySelector('[data-row-id="chat-0"]'), 'the folder is drawn open')
    assert.equal(waitingBadge(), null)
  } finally {
    await list.unmount()
  }
})

test('the badge follows the chats as their status changes, and clears when none waits', async () => {
  const list = await mount(nodes(false, ['idle', 'idle', 'idle']))
  try {
    assert.equal(waitingBadge(), null)
    await list.render(nodes(false, ['waiting', 'idle', 'idle']))
    assert.equal(waitingBadge(), '1 waiting')
    await list.render(nodes(false, ['waiting', 'waiting', 'idle']))
    assert.equal(waitingBadge(), '2 waiting')
    await list.render(nodes(false, ['working', 'idle', 'idle']))
    assert.equal(waitingBadge(), null)
  } finally {
    await list.unmount()
  }
})

test('closing a folder by hand brings its badge up', async () => {
  const list = await mount(nodes(true, ['waiting', 'idle', 'idle']))
  try {
    assert.equal(waitingBadge(), null)
    const button = dom.container.querySelector('[data-folder-id="folder-a"] button')
    assert.ok(button, 'the folder header rendered')
    await act(async () => {
      button.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)('click', { bubbles: true }))
    })
    assert.equal(waitingBadge(), '1 waiting')
  } finally {
    await list.unmount()
  }
})
