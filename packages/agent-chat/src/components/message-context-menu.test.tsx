// The message menu through its real gesture: a press, the `contextmenu` event,
// and a choice from the menu the kit primitive opens.
//
// Mounted rather than rendered to markup, because what is under test is the
// ORDER of events: the selection is read at the press, and the right-click
// that follows may change it before the menu opens.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MessageContextMenu: typeof import('./message-context-menu').MessageContextMenu
let MessageActionsProvider: typeof import('./message-context-menu').MessageActionsProvider

const SOURCE = '**alpha** beta'
const copied: string[] = []

before(async () => {
  container = installTestDom()
  // What the menu primitive reaches for beyond the shared test DOM: a rect to
  // position against, and an abort signal jsdom's own listeners accept (Node's
  // is a different class, which jsdom refuses).
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of ['DOMRect', 'AbortController', 'AbortSignal']) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  })
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MessageContextMenu, MessageActionsProvider } = await import('./message-context-menu'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

// After every test, so each one opens its menu on a fresh mount rather than
// beside the menu the previous test left open.
afterEach(unmount)

async function mount(onReply?: (text: string) => void) {
  await unmount()
  const next = createRoot(container)
  root = next
  const message = (
    <MessageContextMenu text={SOURCE}>
      <p id='words'>alpha beta</p>
    </MessageContextMenu>
  )
  await act(async () =>
    next.render(onReply ? <MessageActionsProvider value={{ onReply }}>{message}</MessageActionsProvider> : message),
  )
}

function words(): Text {
  return (document.getElementById('words') as HTMLElement).firstChild as Text
}

// A right-click as a browser delivers it: the press, then the menu event.
// `between` runs after the press and before the menu event, which is where a
// browser's own right-click selection lands.
async function rightClick(between?: () => void) {
  const target = document.getElementById('words') as HTMLElement
  await act(async () => {
    target.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 2, pointerType: 'mouse' }))
    between?.()
    target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
}

function item(label: string): HTMLElement | undefined {
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent === label)
}

async function choose(label: string) {
  const found = item(label)
  assert.ok(found, `no "${label}" item in the open menu`)
  await act(async () => found.click())
}

test('without a composer to reply into, the menu offers Copy alone', async () => {
  await mount()
  await rightClick()
  assert.ok(item('Copy'), 'Copy is always offered')
  // A boolean, not the element: a failing comparison prints its operands, and
  // printing a jsdom element walks the whole window -- the run stalls instead
  // of reporting.
  assert.equal(item('Reply') !== undefined, false, 'Reply is offered with no composer to reply into')
})

test('with nothing selected, Reply hands over the whole message source', async () => {
  const replies: string[] = []
  await mount((text) => replies.push(text))
  document.getSelection()?.removeAllRanges()
  await rightClick()
  await choose('Reply')
  assert.deepEqual(replies, [SOURCE])
})

test('with part of the message selected, Reply hands over that part', async () => {
  const replies: string[] = []
  await mount((text) => replies.push(text))
  document.getSelection()?.setBaseAndExtent(words(), 6, words(), 10)
  await rightClick()
  await choose('Reply')
  assert.deepEqual(replies, ['beta'])
})

test('the selection is read at the press, not after the right-click has changed it', async () => {
  // macOS selects the word under the pointer on a right-click. Read at open,
  // that word would replace the whole message the reader asked for.
  const replies: string[] = []
  await mount((text) => replies.push(text))
  document.getSelection()?.removeAllRanges()
  await rightClick(() => document.getSelection()?.setBaseAndExtent(words(), 0, words(), 5))
  await choose('Reply')
  assert.deepEqual(replies, [SOURCE])
})

test('Copy puts the same text on the clipboard', async () => {
  copied.length = 0
  await mount()
  document.getSelection()?.setBaseAndExtent(words(), 0, words(), 5)
  await rightClick()
  await choose('Copy')
  assert.deepEqual(copied, ['alpha'])
})
