// Regression on top of the touch fix: the context menu now
// opens on long-press (the propagation fix works), but was closing itself
// the instant the finger lifted -- before a separate tap could ever land on
// Delete or Copy.
//
// Mechanism: NodeContextMenu's own outside-close listener
// (document-level 'touchend'/'mousedown') has no way to tell "a touch that
// started before I existed, whose release now looks like it's outside me"
// apart from a genuine dismiss tap elsewhere -- a touch's target is locked
// to wherever it started, so the release of the very gesture that opened
// the menu is targeted at the node, never at the menu itself. The fix lives
// in flow-editor.tsx's handleTouchEnd: when this touchend is the release of
// a long-press that just opened a menu (tracked via the same longPressFired
// ref the app already uses), stop it from ever reaching that listener.
//
// This exercises the real NodeContextMenu component and mirrors that exact
// handleTouchEnd logic in a minimal harness (mounting the whole FlowEditor
// pulls in space loading, SSE, and the extension registry).
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement, useRef, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NodeContextMenu } = await import('./node-context-menu')

after(() => dom.cleanup())

function touchEndEvent(target: EventTarget): Event {
  const ev = new (globalThis.window as unknown as { Event: typeof Event }).Event('touchend', {
    bubbles: true,
    cancelable: true,
  })
  const touch = { clientX: 0, clientY: 0, target }
  Object.assign(ev, { touches: [], changedTouches: [touch] })
  return ev
}

interface Harness {
  node: () => HTMLElement
  outside: () => HTMLElement
  menuPresent: () => boolean
  dispatchTouchEnd: (target: HTMLElement) => Promise<void>
}

async function mountHarness(): Promise<Harness> {
  const stateRef = { menuOpen: true }

  function TouchEndHarness() {
    const [open, setOpen] = useState(true)
    stateRef.menuOpen = open
    // Mirrors flow-editor.tsx's longPressFired ref: true for exactly the
    // touchend that is the release of the long-press which opened this
    // menu, reset immediately after -- a second touchend (a genuine outside
    // tap) always finds it false, same as production.
    const longPressFired = useRef(true)

    function handleTouchEnd(e: { preventDefault: () => void; stopPropagation: () => void }) {
      if (longPressFired.current) {
        e.preventDefault()
        e.stopPropagation()
      }
      longPressFired.current = false
    }

    return createElement(
      'div',
      { onTouchEnd: handleTouchEnd },
      createElement('div', { 'data-testid': 'node' }),
      createElement('div', { 'data-testid': 'outside' }),
      open &&
        createElement(NodeContextMenu, {
          position: { x: 0, y: 0 },
          node: { id: 'n1', type: 'default', position: { x: 0, y: 0 }, data: {}, selected: true },
          onCopy: () => {},
          onDelete: () => {},
          onClose: () => setOpen(false),
        }),
    )
  }

  const root = createRoot(dom.container)
  after(() => act(() => root.unmount()))
  await act(async () => {
    root.render(createElement(TouchEndHarness, null))
  })

  const node = () => dom.container.querySelector('[data-testid="node"]') as HTMLElement
  const outside = () => dom.container.querySelector('[data-testid="outside"]') as HTMLElement
  assert.ok(node() && outside(), 'expected the harness to render both test targets')

  return {
    node,
    outside,
    menuPresent: () => dom.container.querySelector('[data-canvas-menu]') !== null,
    dispatchTouchEnd: async (target: HTMLElement) => {
      await act(async () => {
        target.dispatchEvent(touchEndEvent(target))
      })
    },
  }
}

test('the menu opened by long-press survives the release of that same gesture', async () => {
  const h = await mountHarness()
  assert.equal(h.menuPresent(), true, 'menu should be open at the start of the test')

  // The release of the opening long-press: touchend targets the node itself
  // (a touch's target is locked to where it started), exactly as it would
  // in the app -- and the harness's longPressFired ref starts true, exactly
  // as flow-editor.tsx's does the instant the long-press timer fires.
  await h.dispatchTouchEnd(h.node())

  assert.equal(h.menuPresent(), true, 'the opening gesture releasing must not close the menu it just opened')
})

test('CONTROL: a genuine outside tap after the opening gesture still closes the menu', async () => {
  const h = await mountHarness()
  assert.equal(h.menuPresent(), true)

  // First touchend: the opening gesture's own release (as above) -- resets
  // longPressFired to false, matching production.
  await h.dispatchTouchEnd(h.node())
  assert.equal(h.menuPresent(), true, 'sanity check: still open after the opening release')

  // A second, separate touchend on a different element is a real dismiss
  // tap and must still close the menu -- the fix must not disable outside-
  // close entirely, only the one event that belongs to the opening gesture.
  await h.dispatchTouchEnd(h.outside())
  assert.equal(h.menuPresent(), false, 'a genuine outside tap must still dismiss the menu')
})
