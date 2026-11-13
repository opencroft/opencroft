// A conversation's messages through their real gestures: a right-click left to
// the browser, text selected inside a message, and Reply from the selection
// bar that selection gets.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let bar: typeof import('./message-selection-bar')

before(async () => {
  container = installTestDom()
  // What the popover primitive reaches for beyond the shared test DOM.
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of ['DOMRect', 'AbortController', 'AbortSignal', 'PointerEvent', 'FocusEvent']) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  globals.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  // jsdom lays nothing out, so a Range has no box to place the bar against.
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect()
  // A desktop with a mouse: jsdom has no media queries.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  bar = await import('./message-selection-bar')
})

async function unmount() {
  const current = root
  root = null
  document.getSelection()?.removeAllRanges()
  if (current) {
    await act(async () => current.unmount())
  }
}

afterEach(unmount)

async function mount(onReply?: (text: string) => void) {
  await unmount()
  const next = createRoot(container)
  root = next
  const { MessageActionsProvider, MessageSelectionBar, SelectableMessage } = bar
  await act(async () =>
    next.render(
      <MessageActionsProvider value={onReply ? { onReply } : {}}>
        <MessageSelectionBar>
          <SelectableMessage>
            <p id='first'>alpha beta</p>
          </SelectableMessage>
          <SelectableMessage>
            <p id='second'>gamma delta</p>
          </SelectableMessage>
          <p id='outside'>not a message</p>
        </MessageSelectionBar>
      </MessageActionsProvider>,
    ),
  )
}

function words(id: string): Text {
  return (document.getElementById(id) as HTMLElement).firstChild as Text
}

/** Selects from `from` in one paragraph to `to` in another, as a drag would. */
async function select(start: [string, number], end: [string, number]) {
  await act(async () => {
    document.getSelection()?.setBaseAndExtent(words(start[0]), start[1], words(end[0]), end[1])
    document.dispatchEvent(new window.Event('selectionchange'))
  })
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function selectionBar(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[aria-label="Selection"]')
}

function buttons(): string[] | null {
  const found = selectionBar()
  return found ? [...found.querySelectorAll('button')].map((each) => each.getAttribute('aria-label') ?? '') : null
}

test("a right-click on a message is left to the browser's own menu", async () => {
  await mount(() => {})
  const target = document.getElementById('first') as HTMLElement
  let notCancelled = false
  await act(async () => {
    notCancelled = target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }))
  })
  assert.equal(notCancelled, true)
  assert.equal(document.querySelector('[role="menu"]'), null, 'no menu of ours opens')
})

test('text selected inside a message gets the bar, with Reply', async () => {
  await mount(() => {})
  assert.equal(buttons(), null, 'nothing selected, no bar')
  await select(['first', 6], ['first', 10])
  assert.deepEqual(buttons(), ['Reply'])
})

test('Reply quotes the selected part of the message and clears the selection', async () => {
  const replies: string[] = []
  await mount((text) => replies.push(text))
  await select(['first', 6], ['first', 10])
  const reply = selectionBar()?.querySelector<HTMLElement>('button[aria-label="Reply"]') as HTMLElement
  const down = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  reply.dispatchEvent(down)
  assert.equal(down.defaultPrevented, true, 'the press keeps the selection where it is')
  await act(async () => reply.click())
  assert.deepEqual(replies, ['beta'])
  assert.equal(document.getSelection()?.isCollapsed ?? true, true, 'the selection is cleared')
})

test('Reply shows its word beside its icon', async () => {
  await mount(() => {})
  await select(['first', 6], ['first', 10])
  const reply = selectionBar()?.querySelector<HTMLElement>('button[aria-label="Reply"]') as HTMLElement
  assert.equal(reply.textContent, 'Reply')
  assert.ok(reply.querySelector('svg'), 'and its icon')
})

test('a mouse press on Reply keeps the bar open through the click, which replies', async () => {
  const replies: string[] = []
  await mount((text) => replies.push(text))
  await select(['first', 6], ['first', 10])
  const reply = () => selectionBar()?.querySelector<HTMLElement>('button[aria-label="Reply"]') ?? null
  const pressed = reply() as HTMLElement
  const pointer = { bubbles: true, button: 0, pointerType: 'mouse' }
  await act(async () => {
    pressed.dispatchEvent(new window.PointerEvent('pointerdown', pointer))
    pressed.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  })
  assert.ok(reply() === pressed, 'the button under the press stays in place')
  await act(async () => {
    pressed.dispatchEvent(new window.PointerEvent('pointerup', pointer))
    pressed.click()
  })
  assert.deepEqual(replies, ['beta'])
})

test('a selection running on into the next message is cut to the one it starts in', async () => {
  const replies: string[] = []
  await mount((text) => replies.push(text))
  await select(['first', 6], ['second', 5])
  await act(async () => (selectionBar()?.querySelector('button[aria-label="Reply"]') as HTMLElement).click())
  assert.deepEqual(replies, ['beta'])
})

test('text selected outside the messages gets no bar', async () => {
  await mount(() => {})
  await select(['outside', 0], ['outside', 3])
  assert.equal(buttons(), null)
})

test('without a composer to reply into there is no bar, and the conversation is drawn as is', async () => {
  await mount()
  await select(['first', 6], ['first', 10])
  assert.equal(buttons(), null)
  assert.ok(document.getElementById('first'), 'the messages are still drawn')
})

test('the bar adds no box around the conversation', async () => {
  await mount(() => {})
  const wrapper = document.getElementById('first')?.closest('[data-selectable-message]')?.parentElement
  assert.ok(wrapper?.classList.contains('contents'), 'the wrapper is display: contents')
})

test('Escape closes the bar until the selection changes', async () => {
  await mount(() => {})
  await select(['first', 6], ['first', 10])
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
  })
  assert.equal(buttons(), null)
  await select(['first', 0], ['first', 5])
  assert.deepEqual(buttons(), ['Reply'])
})

test('the bar waits for a mouse drag to end before it opens', async () => {
  await mount(() => {})
  await act(async () => {
    document
      .getElementById('first')
      ?.dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
  await select(['first', 6], ['first', 10])
  assert.equal(buttons(), null, 'no bar while the button is down')
  await act(async () => {
    window.dispatchEvent(new window.PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }))
  })
  assert.deepEqual(buttons(), ['Reply'])
})

test('a mouse click on the selection puts the bar away once', async () => {
  await mount(() => {})
  await select(['first', 6], ['first', 10])
  assert.deepEqual(buttons(), ['Reply'])
  const opened: boolean[] = []
  const observer = new window.MutationObserver(() => {
    const now = selectionBar() !== null
    if (opened.at(-1) !== now) {
      opened.push(now)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true })
  const pointer = { bubbles: true, button: 0, pointerType: 'mouse' }
  try {
    await act(async () => {
      document.getElementById('first')?.dispatchEvent(new window.PointerEvent('pointerdown', pointer))
    })
    await act(async () => {
      window.dispatchEvent(new window.PointerEvent('pointerup', pointer))
    })
    assert.equal(buttons(), null, 'the release leaves the bar away, with the selection still there')
    // The browser clears the selection once the click is over.
    await act(async () => {
      document.getSelection()?.removeAllRanges()
      document.dispatchEvent(new window.Event('selectionchange'))
    })
    observer.takeRecords()
  } finally {
    observer.disconnect()
  }
  assert.deepEqual(opened, [false], 'closed on the press and never shown again')
  await select(['first', 6], ['first', 10])
  assert.deepEqual(buttons(), ['Reply'], 'the same text chosen again opens the bar')
})
