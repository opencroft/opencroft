// The kit's chat list under a finger, in a real DOM: one continuous hold first
// picks a row up and then opens its menu, with no release in between.
//
// The list runs that press itself -- its own pickup and menu timers -- and
// keeps the context-menu trigger's built-in touch long-press out of it. What
// has to hold is the hand-over at the menu timer: the menu opens there, on the
// same hold, and the trigger's own long-press never opens it earlier. A hold
// that moves is a drag instead, however short the move, and a release that
// ended a drag or lifted off the open menu is cancelled so no click follows it.
//
// Lives in the app workspace, like list-row-as-child.test.tsx, because the
// app's tsconfig.test.json claims packages/ui source for rendering a shared
// component under a runner that has a DOM.

import assert from 'node:assert/strict'
import test, { after, mock } from 'node:test'

// Type-only, so erased: it does not reach react-dom before the DOM exists.
import type { ChatListNode } from 'ui/chat/chat-list'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// What an open menu needs from the platform beyond the shared helper -- the
// same set, for the same reasons, as list-row-as-child.test.tsx.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>

globals.ResizeObserver = FakeResizeObserver
win.ResizeObserver = FakeResizeObserver
for (const name of [
  'Event',
  'CustomEvent',
  'MouseEvent',
  'KeyboardEvent',
  'DOMRect',
  'MutationObserver',
  'AbortController',
  'AbortSignal',
]) {
  globals[name] = win[name]
}
for (const name of ['getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  globals[name] = (win[name] as (...args: unknown[]) => unknown).bind(win)
}

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ChatList } = await import('ui/chat/chat-list')

after(() => dom.cleanup())

const doc = dom.container.ownerDocument

const NODES = [
  { type: 'item' as const, item: { id: 'chat-a', title: 'Alpha' } },
  { type: 'item' as const, item: { id: 'chat-b', title: 'Bravo' } },
]

// jsdom does no layout, so it has no `elementFromPoint`. Under a finger that
// has not moved, the element at the press point is the row it went down on.
let elementUnderFinger: Element | null = null
;(doc as unknown as Record<string, unknown>).elementFromPoint = () => elementUnderFinger

const FOLDERS = [
  { type: 'folder' as const, folder: { id: 'folder-a', name: 'Folder A', items: [] } },
  {
    type: 'folder' as const,
    folder: { id: 'folder-b', name: 'Folder B', items: [{ id: 'chat-c', title: 'Charlie' }] },
  },
  ...NODES,
]

async function mount(onChange?: (nodes: ChatListNode[]) => void, nodes: ChatListNode[] = NODES) {
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(<ChatList nodes={nodes} onDelete={() => {}} onChange={onChange} />)
  })
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

function rowOf(id: string): HTMLElement {
  const row = dom.container.querySelector(`[data-row-id="${id}"] [role="button"]`)
  assert.ok(row, `row ${id} rendered`)
  return row as HTMLElement
}

function menuIsOpen(): boolean {
  return /Move to new folder/.test(doc.body.textContent ?? '')
}

// A finger going down on `target`: the pointer event first, then the touch,
// in the order a browser raises them. jsdom has neither a PointerEvent nor a
// Touch constructor, so both are plain events carrying the fields React reads.
async function fingerDown(target: HTMLElement, x: number, y: number) {
  const EventCtor = win.Event as typeof Event
  const pointer = new EventCtor('pointerdown', { bubbles: true, cancelable: true })
  Object.assign(pointer, { pointerType: 'touch', clientX: x, clientY: y, button: 0 })
  const touch = new EventCtor('touchstart', { bubbles: true, cancelable: true })
  const point = { clientX: x, clientY: y, target }
  Object.assign(touch, { touches: [point], targetTouches: [point], changedTouches: [point] })
  await act(async () => {
    target.dispatchEvent(pointer)
  })
  await act(async () => {
    target.dispatchEvent(touch)
  })
}

async function fingerMove(target: HTMLElement, x: number, y: number) {
  const EventCtor = win.Event as typeof Event
  const touch = new EventCtor('touchmove', { bubbles: true, cancelable: true })
  const point = { clientX: x, clientY: y, target }
  Object.assign(touch, { touches: [point], targetTouches: [point], changedTouches: [point] })
  await act(async () => {
    target.dispatchEvent(touch)
  })
}

// The finger moving as pointer events alone report it. A browser withholds
// `touchmove` until the finger leaves its touch slop, so a short drag is seen
// only this way.
async function pointerMoveTo(x: number, y: number) {
  const EventCtor = win.Event as typeof Event
  const pointer = new EventCtor('pointermove', { bubbles: true, cancelable: true })
  Object.assign(pointer, { pointerType: 'touch', isPrimary: true, clientX: x, clientY: y })
  await act(async () => {
    window.dispatchEvent(pointer)
  })
}

function folderOrder(): string[] {
  return [...dom.container.querySelectorAll('[data-folder-header]')].map(
    (el) => (el as HTMLElement).dataset.folderId ?? '',
  )
}

function folderHeaderOf(id: string): HTMLElement {
  const toggle = dom.container.querySelector(`[data-folder-id="${id}"] button`)
  assert.ok(toggle, `folder ${id} rendered`)
  return toggle as HTMLElement
}

// A `contextmenu` the list did not send: the browser's own on a touch long
// press, or a right-click.
async function contextMenuOn(target: HTMLElement, x: number, y: number) {
  await act(async () => {
    target.dispatchEvent(
      new (win.MouseEvent as typeof MouseEvent)('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      }),
    )
  })
}

function rowOrder(): string[] {
  return [...dom.container.querySelectorAll('[data-row-id]')].map((el) => (el as HTMLElement).dataset.rowId ?? '')
}

// Returns whether the release was cancelled -- which is what keeps a browser
// from following it with mouse events and a click.
async function fingerUp(target: HTMLElement, x: number, y: number): Promise<boolean> {
  const EventCtor = win.Event as typeof Event
  const touch = new EventCtor('touchend', { bubbles: true, cancelable: true })
  const point = { clientX: x, clientY: y, target }
  Object.assign(touch, { touches: [], targetTouches: [], changedTouches: [point] })
  await act(async () => {
    target.dispatchEvent(touch)
  })
  return touch.defaultPrevented
}

async function hold(ms: number) {
  await act(async () => {
    mock.timers.tick(ms)
  })
}

test('one continuous hold picks the row up, then opens its menu without a release', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row

    await fingerDown(row, 20, 20)

    await hold(500)
    assert.equal(menuIsOpen(), false, 'the pickup stage does not open the menu')
    assert.match(row.parentElement?.className ?? '', /ring-primary/, 'the pickup stage lifts the row')

    await hold(500)
    assert.equal(menuIsOpen(), true, 'the second stage opens the menu while the finger is still down')
  } finally {
    await fingerUp(rowOf('chat-a'), 20, 20)
    await unmount()
    mock.timers.reset()
  }
})

test('a second hold on another row opens its menu the same way', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    // A first press that only taps: arms nothing, leaves nothing behind.
    const first = rowOf('chat-a')
    elementUnderFinger = first
    await fingerDown(first, 20, 20)
    await hold(100)
    await fingerUp(first, 20, 20)

    const second = rowOf('chat-b')
    elementUnderFinger = second
    await fingerDown(second, 20, 60)
    await hold(1000)
    assert.equal(menuIsOpen(), true, 'the menu opens at the second stage of the second press')
  } finally {
    await fingerUp(rowOf('chat-b'), 20, 60)
    await unmount()
    mock.timers.reset()
  }
})

test("the browser's own long-press contextmenu does not open the menu at the pickup stage", async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(500)

    await contextMenuOn(row, 20, 20)
    assert.equal(menuIsOpen(), false, 'a contextmenu the list did not send is kept out mid-press')

    await hold(500)
    assert.equal(menuIsOpen(), true, 'the menu still opens at its own stage')
  } finally {
    await fingerUp(rowOf('chat-a'), 20, 20)
    await unmount()
    mock.timers.reset()
  }
})

test('a row picked up and moved in the same hold is dropped where the finger lifts, with no menu', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const changes: ChatListNode[][] = []
  const { unmount } = await mount((nodes) => changes.push(nodes))
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(500)

    // jsdom lays nothing out, so every box is empty and any point lands in
    // the lower half of the row under it: the drop goes after that row.
    elementUnderFinger = rowOf('chat-b')
    await fingerMove(row, 20, 60)
    await hold(1000)
    assert.equal(menuIsOpen(), false, 'a hold that became a drag does not open the menu')

    await fingerUp(row, 20, 60)
    assert.deepEqual(rowOrder(), ['chat-b', 'chat-a'], 'the row moved below the one it was dropped on')
    assert.equal(changes.length, 1, 'the move was reported once')
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

test('a drag that only pointer events report is still a drag, and its release is cancelled', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(500)

    elementUnderFinger = rowOf('chat-b')
    await pointerMoveTo(20, 40)
    await hold(1000)
    assert.equal(menuIsOpen(), false, 'the move was seen, so the menu stage never came')

    assert.equal(await fingerUp(row, 20, 40), true, 'the release is cancelled, so no click lands on the drop')
    assert.deepEqual(rowOrder(), ['chat-b', 'chat-a'])
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

test('a hold that opened the menu cancels its release, and the menu stays open', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(1000)
    assert.equal(menuIsOpen(), true)

    assert.equal(await fingerUp(row, 20, 20), true)
    assert.equal(menuIsOpen(), true)
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

test('a tap keeps its release, so the browser still raises the click that selects the row', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(100)
    assert.equal(await fingerUp(row, 20, 20), false)
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

// jsdom lays nothing out, so every folder header's box sits at height 0: a
// finger above 0 is above every header, one below it is below every header.
test('a folder dragged above every header lands first, even with no header under the finger', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount(undefined, FOLDERS)
  try {
    assert.deepEqual(folderOrder(), ['folder-a', 'folder-b'])
    const header = folderHeaderOf('folder-b')
    elementUnderFinger = null
    await fingerDown(header, 20, 30)
    await hold(500)
    await pointerMoveTo(20, -40)
    assert.equal(await fingerUp(header, 20, -40), true)
    assert.deepEqual(folderOrder(), ['folder-b', 'folder-a'])
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

test('a folder dragged below every header lands last', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount(undefined, FOLDERS)
  try {
    const header = folderHeaderOf('folder-a')
    elementUnderFinger = null
    await fingerDown(header, 20, 0)
    await hold(500)
    await pointerMoveTo(20, 40)
    await fingerUp(header, 20, 40)
    assert.deepEqual(folderOrder(), ['folder-b', 'folder-a'])
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

// A finger held "still" drifts a few pixels, and the pointer stream reports
// every one of them. A hold has to survive that: the platforms' own long press
// allows about 8-10 px.
test('a few pixels of wobble before the pickup still lift the row', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(200)
    await pointerMoveTo(27, 26)
    await hold(300)
    assert.match(row.parentElement?.className ?? '', /ring-primary/, 'the row is lifted')
  } finally {
    await fingerUp(rowOf('chat-a'), 27, 26)
    await unmount()
    mock.timers.reset()
  }
})

test('a move past the tolerance before the pickup is not a hold: no lift, no menu, the release keeps its click', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(200)
    await pointerMoveTo(20, 32)
    await hold(800)
    assert.doesNotMatch(row.parentElement?.className ?? '', /ring-primary/, 'nothing lifted')
    assert.equal(menuIsOpen(), false, 'no menu')
    assert.equal(await fingerUp(row, 20, 32), false, 'the release is left to the browser')
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

test('a few pixels of wobble after the pickup start no drag, and the menu still opens', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(500)
    elementUnderFinger = rowOf('chat-b')
    await pointerMoveTo(20, 28)
    await hold(500)
    assert.equal(menuIsOpen(), true, 'the menu opens at its stage')

    assert.equal(await fingerUp(row, 20, 28), true, 'the release is cancelled, so it selects nothing')
    assert.deepEqual(rowOrder(), ['chat-a', 'chat-b'], 'nothing moved')
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

// A finger moving at 20 px/s from just after the pickup: inside the tolerance
// when the menu is due, past it a quarter of a second later.
async function slowMoveDown(fromY: number, steps: number) {
  for (let i = 1; i <= steps; i++) {
    await pointerMoveTo(20, fromY + 2 * i)
    await hold(100)
  }
}

test('a slow drag still inside the tolerance when the menu is due puts the menu off and becomes a drag', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(650)
    elementUnderFinger = rowOf('chat-b')
    for (let i = 1; i <= 6; i++) {
      await pointerMoveTo(20, 20 + 2 * i)
      await hold(100)
      assert.equal(menuIsOpen(), false, `no menu at ${650 + 100 * i} ms, ${2 * i} px from the start`)
    }
    await hold(500)
    assert.equal(menuIsOpen(), false)

    assert.equal(await fingerUp(row, 20, 32), true)
    assert.deepEqual(rowOrder(), ['chat-b', 'chat-a'], 'it was a drag')
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

test('a slow drift that stops inside the tolerance gets the menu once the finger rests', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(650)
    await slowMoveDown(20, 4)
    assert.equal(menuIsOpen(), false, 'still moving at 1050 ms: the menu waits')
    await hold(600)
    assert.equal(menuIsOpen(), true, 'at rest 8 px from the start: the menu opens')

    assert.equal(await fingerUp(row, 20, 28), true)
    assert.deepEqual(rowOrder(), ['chat-a', 'chat-b'], 'nothing moved')
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

// The finger rolls a few pixels as it lifts: past the menu's moment, inside
// the tolerance, and not yet at rest. A hold that long is a menu, not a tap.
test('a hold past the menu delay that is still moving when the finger lifts opens the menu, not a tap', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(950)
    await pointerMoveTo(20, 25)
    await hold(100)
    assert.equal(menuIsOpen(), false, 'due, but the finger is still moving')

    assert.equal(await fingerUp(row, 20, 25), true, 'the release is cancelled, so no click selects the row')
    assert.equal(menuIsOpen(), true, 'the lift counts as coming to rest: the menu opens')
    assert.deepEqual(rowOrder(), ['chat-a', 'chat-b'], 'nothing moved')
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

test('a move just past the tolerance after the pickup is a drag', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount()
  try {
    const row = rowOf('chat-a')
    elementUnderFinger = row
    await fingerDown(row, 20, 20)
    await hold(500)
    elementUnderFinger = rowOf('chat-b')
    await pointerMoveTo(20, 31)
    await hold(500)
    assert.equal(menuIsOpen(), false)

    await fingerUp(row, 20, 31)
    assert.deepEqual(rowOrder(), ['chat-b', 'chat-a'])
  } finally {
    await unmount()
    mock.timers.reset()
  }
})

test('a folder header held with a wobble lifts, and its menu still opens', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  const { unmount } = await mount(undefined, FOLDERS)
  try {
    const header = folderHeaderOf('folder-b')
    elementUnderFinger = header
    await fingerDown(header, 20, 20)
    await hold(200)
    await pointerMoveTo(27, 20)
    await hold(300)
    const headerRow = dom.container.querySelector('[data-folder-id="folder-b"]')
    assert.match(headerRow?.className ?? '', /ring-primary/, 'the header is lifted')

    await pointerMoveTo(20, 28)
    await hold(500)
    assert.match(doc.body.textContent ?? '', /Rename/, 'the folder menu opens')
    assert.deepEqual(folderOrder(), ['folder-a', 'folder-b'], 'nothing moved')
  } finally {
    await fingerUp(folderHeaderOf('folder-b'), 20, 28)
    await unmount()
    mock.timers.reset()
  }
})

test('a right-click opens the menu', async () => {
  const { unmount } = await mount()
  try {
    await contextMenuOn(rowOf('chat-a'), 20, 20)
    assert.equal(menuIsOpen(), true)
  } finally {
    await unmount()
  }
})
