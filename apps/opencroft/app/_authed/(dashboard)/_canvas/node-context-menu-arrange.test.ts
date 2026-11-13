// The node menu's Align submenu: offered only when the canvas hands it an
// arrange callback (two or more nodes selected), and a choice in it reaches
// that callback although the submenu is drawn outside the menu, together with
// the tidy-up column gap set on the submenu's slider. Wrap in section is
// offered likewise only with its callback (one or more nodes selected).
import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'

import type { ArrangeAction } from '@/app/_authed/(dashboard)/_canvas/arrange-layout'
import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// What the kit's menu reaches without `window.`, as in the kit menu tests.
const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>
for (const name of ['Event', 'CustomEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'FocusEvent', 'DOMRect']) {
  if (win[name]) {
    globals[name] = win[name]
  }
}
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globals.ResizeObserver = FakeResizeObserver
win.ResizeObserver = FakeResizeObserver
globals.getComputedStyle = (win.getComputedStyle as (...args: unknown[]) => unknown).bind(win)
// The kit's slider captures the pointer on a press; the DOM here has no pointer capture.
const elementProto = (win.Element as typeof Element).prototype as unknown as Record<string, unknown>
elementProto.setPointerCapture = () => {}
elementProto.releasePointerCapture = () => {}
elementProto.hasPointerCapture = () => false

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NodeContextMenu } = await import('./node-context-menu')

after(() => dom.cleanup())

let unmount: (() => Promise<void>) | null = null
afterEach(async () => {
  await unmount?.()
  unmount = null
})

interface Seen {
  arranged: [ArrangeAction, number][]
  wrapped: number
  closed: number
}

const GAP_KEY = 'opencroft.canvas.tidyColumnGap'

async function openMenu(withArrange: boolean, { withWrap = false }: { withWrap?: boolean } = {}): Promise<Seen> {
  const seen: Seen = { arranged: [], wrapped: 0, closed: 0 }
  const root = createRoot(dom.container)
  unmount = async () => {
    await act(async () => root.unmount())
  }
  await act(async () => {
    root.render(
      createElement(NodeContextMenu, {
        position: { x: 0, y: 0 },
        node: { id: 'n-1', type: 'acme.stack.app', position: { x: 0, y: 0 }, data: {} },
        contexts: {},
        onCopy: () => {},
        onDelete: () => {},
        onArrange: withArrange
          ? (action: ArrangeAction, gap: number) => {
              seen.arranged.push([action, gap])
            }
          : undefined,
        onWrapInSection: withWrap
          ? () => {
              seen.wrapped++
            }
          : undefined,
        onClose: () => {
          seen.closed++
        },
      }),
    )
  })
  return seen
}

function named(label: string): HTMLElement | undefined {
  return Array.from(document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')).find(
    (b) => b.textContent?.trim() === label,
  )
}

// Let the menu's own effects and transitions settle.
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

async function dispatch(element: Element, events: string[]) {
  const view = globalThis.window
  await act(async () => {
    for (const type of events) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent
      element.dispatchEvent(
        new Ctor(type, {
          bubbles: true,
          button: 0,
          view,
          ...(type.startsWith('pointer') ? { pointerType: 'mouse' } : {}),
        }),
      )
    }
  })
  await settle()
}

const PRESS = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']

test('without an arrange callback the menu has no Align', async () => {
  await openMenu(false)
  assert.ok(named('Copy'), 'expected the menu to render')
  assert.equal(named('Align'), undefined)
})

test('without a wrap callback the menu has no Wrap in section', async () => {
  await openMenu(true)
  assert.ok(named('Copy'), 'expected the menu to render')
  assert.equal(named('Wrap in section'), undefined)
})

test('Wrap in section wraps once and closes the menu, with or without Align beside it', async () => {
  for (const withArrange of [false, true]) {
    const seen = await openMenu(withArrange, { withWrap: true })
    const item = named('Wrap in section')
    assert.ok(item, `expected a Wrap in section row (Align ${withArrange ? 'shown' : 'absent'})`)
    await dispatch(item, PRESS)
    assert.equal(seen.wrapped, 1)
    assert.equal(seen.closed, 1)
    await unmount?.()
    unmount = null
  }
})

test('choosing from the Align submenu arranges and closes the menu; pressing in it does not dismiss first', async () => {
  const seen = await openMenu(true)
  const trigger = named('Align')
  assert.ok(trigger, 'expected an Align row')
  await dispatch(trigger, PRESS)

  const item = named('Arrange in a row')
  assert.ok(item, 'expected the submenu to open with "Arrange in a row"')
  assert.equal(dom.container.contains(item), false, 'the submenu is drawn outside the menu')
  assert.equal(seen.closed, 0)

  await dispatch(item, ['pointerdown'])
  assert.equal(seen.closed, 0, 'a press inside the submenu dismissed the menu')

  await dispatch(item, ['mousedown', 'pointerup', 'mouseup', 'click'])
  assert.deepEqual(seen.arranged, [['row', 2]])
  assert.equal(seen.closed, 1)
})

async function openSubmenu(): Promise<Seen> {
  const seen = await openMenu(true)
  const trigger = named('Align')
  assert.ok(trigger, 'expected an Align row')
  await dispatch(trigger, PRESS)
  return seen
}

function gapThumb(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('[data-slot="slider"] input')
  assert.ok(input, 'expected the column gap slider under Tidy up')
  return input
}

test('the column gap slider moves by key, is kept in the browser, and Tidy up uses it', async () => {
  window.localStorage.setItem(GAP_KEY, '5')
  try {
    const seen = await openSubmenu()
    const thumb = gapThumb()
    assert.equal(thumb.getAttribute('aria-valuenow') ?? thumb.value, '5')

    await dispatch(thumb, ['pointerdown'])
    assert.equal(seen.closed, 0, 'a press on the slider dismissed the menu')

    const press = async (key: string) => {
      await act(async () => {
        thumb.focus()
        thumb.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
      })
      await settle()
    }
    // In a menu ArrowDown moves to an item and ArrowLeft closes a submenu; on
    // the slider they move the slider and nothing else.
    await press('ArrowDown')
    await press('ArrowLeft')
    await press('ArrowRight')
    await press('ArrowRight')
    assert.equal(window.localStorage.getItem(GAP_KEY), '5')
    assert.equal(document.activeElement, thumb, 'a key on the slider moved focus away from it')
    assert.ok(named('Tidy up'), 'a key on the slider closed the submenu')
    await press('ArrowRight')
    assert.equal(window.localStorage.getItem(GAP_KEY), '6')
    assert.equal(seen.closed, 0, 'moving the slider closed the menu')

    const tidy = named('Tidy up')
    assert.ok(tidy, 'expected a Tidy up item')
    await dispatch(tidy, PRESS)
    assert.deepEqual(seen.arranged, [['tidy', 6]])
  } finally {
    window.localStorage.removeItem(GAP_KEY)
  }
})

test('a stored column gap that is out of bounds or not a number reads as the nearest allowed one', async () => {
  for (const [stored, gap] of [
    ['99', 10],
    ['"wide"', 2],
  ] as const) {
    window.localStorage.setItem(GAP_KEY, stored)
    try {
      const seen = await openSubmenu()
      const tidy = named('Tidy up')
      assert.ok(tidy, 'expected a Tidy up item')
      await dispatch(tidy, PRESS)
      assert.deepEqual(seen.arranged, [['tidy', gap]], `stored ${stored}`)
    } finally {
      window.localStorage.removeItem(GAP_KEY)
      await unmount?.()
      unmount = null
    }
  }
})
