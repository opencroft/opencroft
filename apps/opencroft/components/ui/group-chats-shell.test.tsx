// The chats page's kit parts in a real DOM: the chat list under its groups'
// headings, the Recent section under the list, and which panel the shell
// hides below md.
//
// jsdom applies no media queries, so what is observable is the attribute that
// hides a panel below md, not whether it shows at a given width.
//
// Lives in the app workspace because the app's tsconfig.test.json claims
// packages/ui source for rendering under a runner that has a DOM.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// The shell's resizable panels measure with ResizeObserver and DOMRect and
// pick their below-md arrangement through matchMedia. jsdom has no
// ResizeObserver or matchMedia, and keeps DOMRect on its window rather than
// the global the library reads. A query that never matches is the md-and-up
// arrangement, where the handle is live.
;(globalThis as unknown as { DOMRect: unknown }).DOMRect = window.DOMRect
;(globalThis.window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis.window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
// With a ResizeObserver present, the left panel's scroll area waits on its
// viewport's animations, which jsdom does not implement: there are none.
;(window.Element.prototype as unknown as { getAnimations: () => unknown[] }).getAnimations = () => []

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { GroupChatList } = await import('ui/components/ui/group-chat/group-chat-list')
const { GroupChatsShell } = await import('ui/components/ui/group-chat/group-chats-shell')
const { RecentThreads, recentThreadLeaf } = await import('ui/components/ui/group-chat/recent-threads')
type RecentThread = Parameters<typeof recentThreadLeaf>[0]

// Recent's threads loose at the top level, in the given order.
const loose = (threads: RecentThread[]) =>
  threads.map((thread) => ({ type: 'item' as const, item: recentThreadLeaf(thread) }))
const { GroupChatThreadList } = await import('ui/components/ui/group-chat/group-chat-thread-list')

after(() => dom.cleanup())

async function mount(node: ReactNode) {
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(node)
  })
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

const headings = () => [...dom.container.querySelectorAll('h3')].map((h) => h.textContent)
const rowTitles = (section: Element) =>
  [...section.querySelectorAll('[role="button"]')].map((row) => row.textContent?.split(/\d+ threads?/)[0])

test('chats with a group are listed under its heading, in arrival order, and the rest last', async () => {
  const chat = (id: string, name: string, group?: { id: string; name: string }) => ({
    id,
    name,
    members: [],
    threadCount: 1,
    ...(group ? { group } : {}),
  })
  const { unmount } = await mount(
    <GroupChatList
      chats={[
        chat('c1', 'Alpha', { id: 's1', name: 'Space One' }),
        chat('c2', 'Loose'),
        chat('c3', 'Beta', { id: 's2', name: 'Space Two' }),
        chat('c4', 'Gamma', { id: 's1', name: 'Space One' }),
      ]}
    />,
  )
  try {
    assert.deepEqual(headings(), ['Space One', 'Space Two', 'Other chats'])
    const sections = [...dom.container.querySelectorAll('section')]
    assert.deepEqual(sections.map(rowTitles), [['Alpha', 'Gamma'], ['Beta'], ['Loose']])
  } finally {
    await unmount()
  }
})

test('with no groups the list is flat, with no headings', async () => {
  const { unmount } = await mount(<GroupChatList chats={[{ id: 'c1', name: 'Alpha', members: [], threadCount: 2 }]} />)
  try {
    assert.deepEqual(headings(), [])
    assert.equal(dom.container.querySelectorAll('[role="button"]').length, 1)
  } finally {
    await unmount()
  }
})

test('a given group keeps its heading and its action with no chat in it, and comes before the other groups', async () => {
  const action = <button type='button' aria-label='New group chat' />
  const channels = { id: 'channels', name: 'Channels', action }
  const empty = await mount(<GroupChatList chats={[]} groups={[channels]} />)
  try {
    assert.deepEqual(headings(), ['Channels'])
    const plus = dom.container.querySelector('button[aria-label="New group chat"]')
    assert.ok(plus, 'the action is drawn while the list is empty')
    assert.equal(plus.closest('div')?.parentElement?.querySelector('h3')?.textContent, 'Channels')
    assert.match(dom.container.textContent ?? '', /No group chats yet/)
  } finally {
    await empty.unmount()
  }

  const listed = await mount(
    <GroupChatList
      groups={[channels]}
      chats={[
        { id: 'c1', name: 'Alpha', members: [], threadCount: 1, group: { id: 's1', name: 'Space One' } },
        { id: 'c2', name: 'Beta', members: [], threadCount: 1, group: { id: 'channels', name: 'Channels' } },
        { id: 'c3', name: 'Loose', members: [], threadCount: 1 },
      ]}
    />,
  )
  try {
    assert.deepEqual(headings(), ['Channels', 'Space One', 'Other chats'])
    const sections = [...dom.container.querySelectorAll('section')]
    assert.deepEqual(sections.map(rowTitles), [['Beta'], ['Alpha'], ['Loose']])
    assert.equal(dom.container.querySelectorAll('button[aria-label="New group chat"]').length, 1)
    assert.doesNotMatch(dom.container.textContent ?? '', /No group chats yet/)
  } finally {
    await listed.unmount()
  }
})

test('Recent lists its threads under their chat with the agent, its state and the draft mark, marks the open one, and reports a press', async () => {
  const pressed: string[] = []
  const { unmount } = await mount(
    <RecentThreads
      activeId='t2'
      onSelect={(id) => pressed.push(id)}
      nodes={loose([
        {
          id: 't1',
          title: 'First',
          groupChatName: 'Chat A',
          agent: { name: 'Agent A' },
          status: 'working',
          hasDraft: true,
        },
        { id: 't2', title: null, groupChatName: 'Chat B', agent: { name: 'Agent B' } },
      ])}
    />,
  )
  try {
    assert.deepEqual(headings(), ['Recent'])
    const rows = [...dom.container.querySelectorAll<HTMLElement>('[role="button"]')]
    assert.equal(rows.length, 2)
    const lines = (row: HTMLElement) => [...row.querySelectorAll('span.truncate')].map((line) => line.textContent)
    assert.deepEqual(lines(rows[0]), ['Chat A / First', 'Agent A · Working'])
    assert.deepEqual(lines(rows[1]), ['Chat B / Thread', 'Agent B'], 'an untitled thread reads as Thread')
    assert.ok(rows[0].querySelector('[title="Unsent draft"]'), 'a thread with a draft shows the mark')
    assert.equal(rows[1].querySelector('[title="Unsent draft"]'), null)
    assert.equal(rows[0].dataset.active, 'false')
    assert.equal(rows[1].dataset.active, 'true')
    await act(async () => {
      rows[0].click()
    })
    assert.deepEqual(pressed, ['t1'])
  } finally {
    await unmount()
  }
})

test("a chat's thread list draws the same row with no close button and the plain title", async () => {
  const { unmount } = await mount(
    <GroupChatThreadList
      onSelect={() => {}}
      threads={[
        { id: 't1', title: 'First', agent: { nodeId: 'a', name: 'Agent A' }, createdAt: new Date(0), hasDraft: true },
      ]}
    />,
  )
  try {
    const rows = [...dom.container.querySelectorAll<HTMLElement>('[role="button"]')]
    assert.equal(rows.length, 1)
    assert.equal(rows[0].querySelector('span.truncate')?.textContent, 'First')
    assert.ok(rows[0].querySelector('[title="Unsent draft"]'))
    assert.equal(dom.container.querySelectorAll('button').length, 0)
  } finally {
    await unmount()
  }
})

test('Recent with nothing opened keeps its heading over an empty line', async () => {
  const { unmount } = await mount(<RecentThreads nodes={[]} />)
  try {
    assert.deepEqual(headings(), ['Recent'])
    assert.match(dom.container.textContent ?? '', /Threads you open appear here\./)
  } finally {
    await unmount()
  }
})

test('Recent rows end in a close button beside the row that reports the thread and does not open it', async () => {
  const pressed: string[] = []
  const removed: string[] = []
  const { unmount } = await mount(
    <RecentThreads
      onSelect={(id) => pressed.push(id)}
      onRemove={(id) => removed.push(id)}
      nodes={loose([
        { id: 't1', title: 'First', groupChatName: 'Chat A', agent: { name: 'Agent A' } },
        { id: 't2', title: 'Second', groupChatName: 'Chat B', agent: { name: 'Agent B' } },
      ])}
    />,
  )
  try {
    const closes = [...dom.container.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove from Recent"]')]
    assert.equal(closes.length, 2)
    assert.ok(
      closes.every((close) => close.parentElement?.closest('[role="button"]') === null),
      'the close button is not nested inside the row, itself a button',
    )
    await act(async () => {
      closes[1].click()
    })
    await act(async () => {
      closes[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    assert.deepEqual(removed, ['t2'])
    assert.deepEqual(pressed, [], 'neither the click nor the key press reaches the row')
  } finally {
    await unmount()
  }
})

test('Recent without onRemove draws no close button', async () => {
  const { unmount } = await mount(
    <RecentThreads
      nodes={loose([{ id: 't1', title: 'First', groupChatName: 'Chat A', agent: { name: 'Agent A' } }])}
    />,
  )
  try {
    assert.equal(dom.container.querySelector('button[aria-label="Remove from Recent"]'), null)
  } finally {
    await unmount()
  }
})

test('Recent draws its folders above the loose threads, each thread a draggable row with its close button', async () => {
  const [first, second, third] = [
    { id: 't1', title: 'First', groupChatName: 'Chat A', agent: { name: 'Agent A' } },
    { id: 't2', title: 'Second', groupChatName: 'Chat B', agent: { name: 'Agent B' } },
    { id: 't3', title: 'Third', groupChatName: 'Chat A', agent: { name: 'Agent A' } },
  ].map(recentThreadLeaf)
  const { unmount } = await mount(
    <RecentThreads
      onRemove={() => {}}
      nodes={[
        { type: 'item', item: third },
        { type: 'folder', folder: { id: 'folder-1', name: 'Launch', items: [second, first] } },
      ]}
    />,
  )
  try {
    const header = dom.container.querySelector<HTMLElement>('[data-folder-header]')
    assert.equal(header?.textContent, 'Launch')
    const rows = [...dom.container.querySelectorAll<HTMLElement>('[data-row-id]')]
    assert.deepEqual(
      rows.map((row) => [row.dataset.rowId, row.dataset.rowList]),
      [
        ['t2', 'folder:folder-1'],
        ['t1', 'folder:folder-1'],
        ['t3', 'items'],
      ],
    )
    assert.equal(dom.container.querySelectorAll('button[aria-label="Remove from Recent"]').length, 3)
  } finally {
    await unmount()
  }
})

test('below md the shell hides the left panel while something is open, and the open panel while nothing is', async () => {
  const panels = () => {
    const [left, right] = [...dom.container.querySelectorAll('[data-panel]')]
    return { left, right }
  }
  const shell = (isOpened: boolean) => (
    <GroupChatsShell isOpened={isOpened} chats={<nav>Chats</nav>} recent={<aside>Recent</aside>}>
      <p>Open chat</p>
    </GroupChatsShell>
  )

  const opened = await mount(shell(true))
  try {
    const { left, right } = panels()
    assert.match(left?.textContent ?? '', /Chats.*Recent/, 'Recent sits under the chats in the left panel')
    assert.ok(left?.hasAttribute('data-hidden-below-md'))
    assert.equal(right?.textContent, 'Open chat')
    assert.ok(!right?.hasAttribute('data-hidden-below-md'))
    assert.equal(dom.container.querySelector('button[aria-label="Back"]'), null, 'the shell draws no Back of its own')
    assert.ok(
      dom.container.querySelector('[role="separator"][aria-label="Resize menu"]'),
      'the boundary between the panels is a resize handle',
    )
  } finally {
    await opened.unmount()
  }

  const closed = await mount(shell(false))
  try {
    const { left, right } = panels()
    assert.ok(!left?.hasAttribute('data-hidden-below-md'))
    assert.ok(right?.hasAttribute('data-hidden-below-md'))
  } finally {
    await closed.unmount()
  }
})
