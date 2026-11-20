// A change to the chat that the server pushes -- someone invited or removed,
// from this page, another tab or an agent -- reloads the chat screen through
// the refresh its host provides, and the members list in Chat settings shows
// the new state without a page reload.
//
// Two hosts draw this screen. The route draws its header in place; the chat
// dock takes the header (`onHeader`) and draws it in its own window header,
// outside the refresh provider it puts around the screen. Both are mounted
// here, the second exactly that way round.
//
// WHAT THIS DOES NOT COVER: the dialog's own writes. In this runner a server
// function runs its handler in-process and throws without a request, so a
// write never succeeds here; it reaches the same refresh by reading (the
// header's controls carry the screen's refresh with them). The live check is
// a browser's, on both hosts.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// cmdk observes its list's size with ResizeObserver, which jsdom lacks, and
// scrolls the active row into view; the settings dialog's scroll area waits
// on its viewport's animations, which jsdom does not run. Stubs are enough to
// mount, open and read.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
for (const scope of [globalThis, globalThis.window] as unknown as Record<string, unknown>[]) {
  scope.ResizeObserver = FakeResizeObserver
}
window.Element.prototype.scrollIntoView ??= () => {}
window.Element.prototype.getAnimations ??= () => []
// The composer's editor asks whether the pointer is coarse; jsdom has no
// matchMedia. A fine pointer, never changing.
;(globalThis.window as unknown as { matchMedia: (media: string) => unknown }).matchMedia = (media: string) => ({
  matches: false,
  media,
  addEventListener: () => {},
  removeEventListener: () => {},
})

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { GroupChatDetailScreen } = await import('@/app/_authed/(group-chats)/_components/group-chat-detail-screen')
const { GroupChatRefreshProvider } = await import('@/app/_authed/(group-chats)/_lib/group-chat-refresh')
const { receiveGroupChatChange } = await import('@/app/_authed/(group-chats)/_lib/group-chat-changes')
const { SSEEventsProvider } = await import('@/app/_authed/(sse)/_lib/sse-events-store')

type ScreenProps = Parameters<typeof GroupChatDetailScreen>[0]
type Header = Parameters<NonNullable<ScreenProps['onHeader']>>[0]
type Member = ScreenProps['chat']['members'][number]

after(() => dom.cleanup())

const CHAT_ID = 'chat-1'
const ALICE: Member = { kind: 'user', id: 'u-alice', name: 'Alice', avatarUrl: null, username: 'alice' }
const BOB: Member = { kind: 'agent', id: 'a-bob', name: 'Bob', avatarUrl: null, username: 'agent.bob' }

/** What the server answers for the chat's members when the screen reads it again. */
let serverMembers: Member[] = []
let refreshes = 0

// Everything but the chat itself, one identity for the whole file, as a host's
// loaded data is between reloads.
const LOADED = {
  groupChatId: CHAT_ID,
  threads: [],
  directory: [{ id: ALICE.id, name: ALICE.name, avatarUrl: null }],
  agents: [{ id: BOB.id, name: BOB.name, avatarUrl: null }],
  pins: [],
  layout: { layout: { entries: [] }, version: 0 },
  onOpenThread: () => {},
  onThreadStarted: () => {},
}

function screenProps(chat: ScreenProps['chat']): Omit<ScreenProps, 'onHeader'> {
  return { ...LOADED, chat } as unknown as Omit<ScreenProps, 'onHeader'>
}

function chatWith(members: Member[]): ScreenProps['chat'] {
  return { id: CHAT_ID, name: 'Planning', topic: '', members, archivedThreadCount: 0 }
}

/**
 * A host that loads the chat itself and reloads it on refresh, as both hosts
 * do. `takesHeader` draws the screen's header outside the provider, the way
 * the chat dock does. The refresh is a new function on every render, which a
 * host is free to pass: a header that changed with it would never settle in a
 * host that holds the header in state.
 */
function Host({ takesHeader }: { takesHeader: boolean }): ReactNode {
  const [chat, setChat] = useState(() => chatWith(serverMembers))
  const [header, setHeader] = useState<Header>(null)
  const refresh = async () => {
    refreshes++
    setChat(chatWith(serverMembers))
  }
  return createElement(
    SSEEventsProvider,
    null,
    takesHeader ? createElement('div', { 'data-host-header': '' }, header?.actions) : null,
    createElement(GroupChatRefreshProvider, {
      refresh,
      children: createElement(GroupChatDetailScreen, {
        ...screenProps(chat),
        ...(takesHeader ? { onHeader: setHeader } : {}),
      }),
    }),
  )
}

/** The member list's row names, as Chat settings → Members draws them. */
function memberNames(): string[] {
  return [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].map(
    (row) => row.querySelector('.truncate')?.textContent ?? '',
  )
}

async function openSettings() {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Chat settings"]')
  assert.ok(button, 'the header has the settings control')
  await act(async () => button.click())
}

async function mount(takesHeader: boolean) {
  refreshes = 0
  const root = createRoot(dom.container)
  await act(async () => root.render(createElement(Host, { takesHeader })))
  return root
}

for (const takesHeader of [false, true]) {
  const host = takesHeader ? 'a host that draws the header itself' : 'the screen drawing its own header'

  test(`with ${host}, a pushed change shows an invited member in the open members list`, async () => {
    serverMembers = [ALICE]
    const root = await mount(takesHeader)
    try {
      await openSettings()
      assert.deepEqual(memberNames(), ['Alice'])

      serverMembers = [ALICE, BOB]
      await act(async () => receiveGroupChatChange(CHAT_ID))
      assert.equal(refreshes, 1, 'one reload per change, the dialog being open or not')
      assert.deepEqual(memberNames(), ['Alice', 'Bob'])

      serverMembers = [BOB]
      await act(async () => receiveGroupChatChange(CHAT_ID))
      assert.deepEqual(memberNames(), ['Bob'], 'a removed member leaves the list')
    } finally {
      await act(async () => root.unmount())
    }
  })
}

test('a pushed change reloads the screen while Chat settings is closed, and only for this chat', async () => {
  serverMembers = [ALICE]
  const root = await mount(false)
  try {
    await act(async () => receiveGroupChatChange('another-chat'))
    assert.equal(refreshes, 0, 'a change to another chat reads nothing')

    serverMembers = [ALICE, BOB]
    await act(async () => receiveGroupChatChange(CHAT_ID))
    assert.equal(refreshes, 1)

    // Opened after the change, the dialog draws the members the reload brought.
    await openSettings()
    assert.deepEqual(memberNames(), ['Alice', 'Bob'])
  } finally {
    await act(async () => root.unmount())
  }
})
