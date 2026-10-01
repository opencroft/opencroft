// A canvas context menu is opened mid-gesture: the long-press that opens it
// (our JS timer or the browser's native contextmenu gesture) still has the
// finger down when the menu mounts, and that gesture then ends with a
// touchend targeted at the NODE (a touch's target is locked to where it
// started), followed by the browser's compatibility mousedown/click. An
// outside-close listener keyed on any of those end-of-gesture events reads
// the opening gesture's own tail as a dismiss and closes the menu before a
// separate tap can reach it -- which shipped, twice, as "the menu closes
// the moment the finger lifts", each time for one of the two open paths.
//
// The menus therefore dismiss ONLY on `pointerdown` outside
// (use-outside-dismiss.ts): a pointerdown is always the start of a NEW
// press, so no release event and no compatibility event can close the menu,
// regardless of which path opened it and in which node-drag mode. These
// tests pin that contract against the real NodeContextMenu -- no flag
// handshake to mirror, because there is none left.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NodeContextMenu } = await import('./node-context-menu')

after(() => dom.cleanup())

function gestureTailEvent(type: 'touchend' | 'mousedown' | 'click', target: EventTarget): Event {
  const ev = new (globalThis.window as unknown as { Event: typeof Event }).Event(type, {
    bubbles: true,
    cancelable: true,
  })
  const touch = { clientX: 0, clientY: 0, target }
  Object.assign(ev, { touches: [], changedTouches: [touch] })
  return ev
}

// `target` is getter-only on a dispatched Event -- dispatchEvent() sets it to
// the element the event is dispatched on, so it is not assigned here (unlike
// the synthetic Touch objects above, which are plain objects, not Events).
function pointerDownEvent(): Event {
  const ev = new (globalThis.window as unknown as { Event: typeof Event }).Event('pointerdown', {
    bubbles: true,
    cancelable: true,
  })
  Object.assign(ev, { clientX: 0, clientY: 0, pointerId: 1 })
  return ev
}

interface Harness {
  node: () => HTMLElement
  outside: () => HTMLElement
  menuButton: (label: string) => HTMLElement
  menuPresent: () => boolean
  dispatch: (ev: Event, target: HTMLElement) => Promise<void>
}

async function mountHarness(): Promise<Harness> {
  function MenuHarness() {
    const [open, setOpen] = useState(true)
    return createElement(
      'div',
      null,
      createElement('div', { 'data-testid': 'node' }),
      createElement('div', { 'data-testid': 'outside' }),
      open &&
        createElement(NodeContextMenu, {
          position: { x: 0, y: 0 },
          node: { id: 'n1', type: 'default', position: { x: 0, y: 0 }, data: {}, selected: true },
          contexts: {},
          onCopy: () => {},
          onDelete: () => {},
          onClose: () => setOpen(false),
        }),
    )
  }

  const root = createRoot(dom.container)
  after(() => act(() => root.unmount()))
  await act(async () => {
    root.render(createElement(MenuHarness, null))
  })

  const byTestId = (id: string) => {
    const el = dom.container.querySelector(`[data-testid="${id}"]`)
    assert.ok(el, `expected the harness to render [data-testid="${id}"]`)
    return el as HTMLElement
  }

  return {
    node: () => byTestId('node'),
    outside: () => byTestId('outside'),
    menuButton: (label: string) => {
      const btn = Array.from(dom.container.querySelectorAll('button')).find((b) => b.textContent?.includes(label))
      assert.ok(btn, `expected a "${label}" button in the rendered menu`)
      return btn as HTMLElement
    },
    menuPresent: () => dom.container.querySelector('[data-canvas-menu]') !== null,
    dispatch: async (ev: Event, target: HTMLElement) => {
      await act(async () => {
        target.dispatchEvent(ev)
      })
    },
  }
}

test('the opening gesture ending -- touchend on the node, then the compatibility mousedown -- does not close the menu', async () => {
  const h = await mountHarness()
  assert.equal(h.menuPresent(), true, 'menu should be open at the start of the test')

  await h.dispatch(gestureTailEvent('touchend', h.node()), h.node())
  assert.equal(h.menuPresent(), true, "the opening gesture's touchend must not close the menu it just opened")

  // Standard touch-event behavior: after touchend the browser synthesizes
  // compatibility mouse events at the release point.
  await h.dispatch(gestureTailEvent('mousedown', h.node()), h.node())
  assert.equal(h.menuPresent(), true, 'the compatibility mousedown after the opening touch must not close it either')
})

test('a NEW press outside -- pointerdown -- dismisses the menu', async () => {
  const h = await mountHarness()
  assert.equal(h.menuPresent(), true)

  await h.dispatch(pointerDownEvent(), h.outside())
  assert.equal(h.menuPresent(), false, 'a genuine new press outside must dismiss the menu')
})

test('CONTROL: a pointerdown INSIDE the menu does not dismiss it, so its buttons stay pressable', async () => {
  const h = await mountHarness()
  const del = h.menuButton('Delete')

  await h.dispatch(pointerDownEvent(), del)
  assert.equal(h.menuPresent(), true, 'pressing down on a menu item must not dismiss the menu before its click lands')
})
