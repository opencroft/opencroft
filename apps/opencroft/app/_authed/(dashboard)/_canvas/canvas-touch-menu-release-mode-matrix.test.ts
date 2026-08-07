// Touch context menu, third round: a real phone reported the
// closes-on-release behaviour as MODE-DEPENDENT -- "Move nodes" ON
// (nodesDraggable true) survives release; "Pan canvas" OFF (the mobile
// default) still closed on release. That observation predates the fix
// (menuOpenedDuringTouch) landing.
//
// The earlier fixes' own regression tests (node-context-menu-survives-release.
// test.ts) mirror handleTouchEnd's logic in a plain-div harness -- accurate
// for what OUR code does with a touch, but blind to whether our code ever
// gets a chance to run at all, which is exactly what's in question for the
// draggable case: xyflow's own per-node drag handler (XYDrag, backed by
// d3-drag) claims the touchstart via stopImmediatePropagation before it ever
// reaches flow-editor.tsx's ancestor handleTouchStart (proven directly this
// session, see canvas-touch-pan-node-guard.test.ts and the investigation
// notes) -- so touchActiveRef, which the release fix depends on to mark
// menuOpenedDuringTouch, never becomes true for that gesture at all (proven
// below). And yet the menu survives release in that mode regardless: XYDrag
// also claims the SAME touch's touchend the same way, for its own reasons
// (suppressing a ghost click after a claimed-but-unmoved touch), which
// incidentally stops that touchend from ever reaching NodeContextMenu's own
// document-level outside-close listener either -- entirely independent of
// the release fix, or of anything in flow-editor.tsx.
//
// So the "mode-dependent" split had two different real causes, not one:
// non-draggable relied on an explicit release-suppression guard; draggable
// was never broken by that mechanism, because XYDrag's own
// propagation-claiming already protected it, incidentally, the same way.
//
// SINCE SUPERSEDED: dismissal now keys on pointerdown-outside
// (use-outside-dismiss.ts), so no release event can close a menu in ANY
// mode, by construction -- the flag guard this file was written to exercise
// is gone, and the harness below mirrors the current, simpler handlers
// (ghost-click suppression only). The matrix keeps its value: it proves,
// against a real @xyflow/react + d3-drag/d3-zoom stack, that the menu
// survives its opening gesture's release in both draggable modes and both
// open paths -- a fake-harness mirror cannot observe whether flow-editor's
// own handlers even get a turn, which is exactly what differs by mode.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

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

class FakeDOMMatrixReadOnly {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0
}
;(globalThis as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = FakeDOMMatrixReadOnly
;(globalThis.window as unknown as { DOMMatrixReadOnly: unknown }).DOMMatrixReadOnly = FakeDOMMatrixReadOnly

// See canvas-touch-pan-node-guard.test.ts for why this one matters: without
// it, d3-zoom's defaultExtent() throws on a bare-global lookup and jsdom
// swallows the exception inside event dispatch, silently skipping the very
// stopImmediatePropagation this file exists to observe.
;(globalThis as unknown as { SVGElement: unknown }).SVGElement = (
  globalThis.window as unknown as { SVGElement: unknown }
).SVGElement

const { act, createElement, useCallback, useRef, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow } = await import('@xyflow/react')
const { NodeContextMenu } = await import('./node-context-menu')

after(() => dom.cleanup())

function touchEvent(type: string, target: EventTarget, { withTouches = true }: { withTouches?: boolean } = {}): Event {
  const ev = new (globalThis.window as unknown as { Event: typeof Event }).Event(type, {
    bubbles: true,
    cancelable: true,
  })
  const touch = { clientX: 10, clientY: 10, identifier: 0, target }
  Object.assign(ev, {
    touches: withTouches ? [touch] : [],
    changedTouches: [touch],
    targetTouches: withTouches ? [touch] : [],
  })
  return ev
}

function contextMenuEvent(): Event {
  // 'target' is a getter-only property on a dispatched Event, set
  // automatically by dispatchEvent() to whatever element it's dispatched on
  // -- unlike the synthetic Touch objects above (plain objects, not Events),
  // it can't be assigned here.
  const ev = new (globalThis.window as unknown as { Event: typeof Event }).Event('contextmenu', {
    bubbles: true,
    cancelable: true,
  })
  Object.assign(ev, { clientX: 10, clientY: 10 })
  return ev
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface Harness {
  node: () => Element
  menuPresent: () => boolean
  touchStartReachedOurHandler: () => boolean
  dispatch: (type: string, opts?: { withTouches?: boolean }) => Promise<void>
  dispatchContextMenu: () => Promise<void>
  waitPastLongPressDelay: () => Promise<void>
}

// Mirrors flow-editor.tsx's real touch + menu-opening wiring verbatim
// (handleTouchStart, handleTouchEnd with its ghost-click suppression,
// openNodeMenu, onNodeContextMenu) -- against a real ReactFlow instance and
// real touch/contextmenu dispatch, not a stand-in div. Dismissal comes from
// the real NodeContextMenu's own pointerdown-outside listener.
async function mountHarness(nodesDraggable: boolean): Promise<Harness> {
  let getMenuPresent = () => false
  let ourHandleTouchStartFired = false

  function Harness() {
    const [nodeMenu, setNodeMenu] = useState<{ screen: { x: number; y: number }; nodeId: string } | null>(null)
    const longPressFired = useRef(false)
    const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const touchTargetRef = useRef<{ x: number; y: number; target: EventTarget | null } | null>(null)

    const openNodeMenu = useCallback((nodeId: string, screen: { x: number; y: number }) => {
      setNodeMenu({ screen, nodeId })
    }, [])

    const onNodeContextMenu = useCallback(
      (event: React.MouseEvent, node: { id: string }) => {
        event.preventDefault()
        openNodeMenu(node.id, { x: event.clientX, y: event.clientY })
      },
      [openNodeMenu],
    )

    const cancelLongPress = useCallback(() => {
      if (longPressTimer.current) {
        clearTimeout(longPressTimer.current)
        longPressTimer.current = null
      }
    }, [])

    const handleTouchStart = useCallback(
      (e: React.TouchEvent) => {
        ourHandleTouchStartFired = true
        longPressFired.current = false
        const touch = e.touches[0]
        touchTargetRef.current = { x: touch.clientX, y: touch.clientY, target: touch.target }
        cancelLongPress()
        longPressTimer.current = setTimeout(() => {
          longPressFired.current = true
          const { x, y, target } = touchTargetRef.current ?? {}
          const el = (target instanceof Element ? target : null) ?? document.elementFromPoint(x ?? 0, y ?? 0)
          const nodeEl = el?.closest('.react-flow__node')
          if (nodeEl) {
            const nodeId = nodeEl.getAttribute('data-id')
            if (nodeId) {
              openNodeMenu(nodeId, { x: x ?? 0, y: y ?? 0 })
            }
          }
        }, 500)
      },
      [cancelLongPress, openNodeMenu],
    )

    const handleTouchEnd = useCallback(
      (e: React.TouchEvent) => {
        cancelLongPress()
        if (longPressFired.current) {
          // Ghost-click suppression only -- dismissal needs no coordination
          // here any more, the menu closes solely on pointerdown outside it.
          e.preventDefault()
        }
        longPressFired.current = false
      },
      [cancelLongPress],
    )

    getMenuPresent = () => nodeMenu !== null

    return createElement(
      'div',
      { onTouchStart: handleTouchStart, onTouchEnd: handleTouchEnd },
      createElement(ReactFlow, {
        // Matches flow-editor.tsx's nodesForFlow memo: EVERY mobile node
        // carries 'nopan' unconditionally, regardless of draggable state.
        nodes: [{ id: 'n1', type: 'default', position: { x: 0, y: 0 }, data: {}, className: 'nopan' }],
        edges: [],
        panOnDrag: true,
        nodesDraggable,
        fitView: false,
        onNodeContextMenu,
      }),
      nodeMenu &&
        createElement(NodeContextMenu, {
          position: nodeMenu.screen,
          node: { id: nodeMenu.nodeId, type: 'default', position: { x: 0, y: 0 }, data: {}, selected: true },
          onCopy: () => {},
          onDelete: () => {},
          onClose: () => setNodeMenu(null),
        }),
    )
  }

  const root = createRoot(dom.container)
  after(() => act(() => root.unmount()))
  await act(async () => {
    root.render(createElement(Harness, null))
  })

  const node = () => {
    const el = dom.container.querySelector('.react-flow__node')
    assert.ok(el, 'expected a rendered node')
    return el
  }

  return {
    node,
    menuPresent: () => getMenuPresent(),
    touchStartReachedOurHandler: () => ourHandleTouchStartFired,
    dispatch: async (type, opts) => {
      await act(async () => {
        node().dispatchEvent(touchEvent(type, node(), opts))
      })
    },
    dispatchContextMenu: async () => {
      await act(async () => {
        node().dispatchEvent(contextMenuEvent())
      })
    },
    waitPastLongPressDelay: async () => {
      await act(async () => {
        await wait(600)
      })
    },
  }
}

// --- nodesDraggable: false ("Pan canvas", the mobile default) ---

test('draggable=false, opened via the JS-timer long-press: release survives', async () => {
  const h = await mountHarness(false)
  await h.dispatch('touchstart')
  assert.equal(h.touchStartReachedOurHandler(), true, 'nopan must let the touchstart reach our own handler')
  await h.waitPastLongPressDelay()
  assert.equal(h.menuPresent(), true, 'the long-press timer should have opened the menu by now')
  await h.dispatch('touchend', { withTouches: false })
  assert.equal(h.menuPresent(), true, 'the opening gesture releasing must not close the menu it just opened')
})

test('draggable=false, opened via the native contextmenu gesture: release survives', async () => {
  const h = await mountHarness(false)
  await h.dispatch('touchstart')
  await h.dispatchContextMenu()
  assert.equal(h.menuPresent(), true, 'the native gesture should have opened the menu')
  await h.dispatch('touchend', { withTouches: false })
  assert.equal(h.menuPresent(), true, 'the opening gesture releasing must not close the menu it just opened')
})

// --- nodesDraggable: true ("Move nodes") ---

test('draggable=true: a touchstart on the node never reaches our own handler at all (XYDrag claims it first)', async () => {
  const h = await mountHarness(true)
  await h.dispatch('touchstart')
  assert.equal(
    h.touchStartReachedOurHandler(),
    false,
    "if this now fires, XYDrag's own drag-claim no longer blocks our ancestor handler and the mode-dependent split has a different cause than assumed",
  )
})

test('draggable=true, opened via the native contextmenu gesture: release survives', async () => {
  const h = await mountHarness(true)
  await h.dispatch('touchstart')
  await h.dispatchContextMenu()
  assert.equal(h.menuPresent(), true, 'the native gesture should have opened the menu')
  await h.dispatch('touchend', { withTouches: false })
  assert.equal(
    h.menuPresent(),
    true,
    'the opening gesture releasing must not close the menu it just opened, even though our own handleTouchStart never ran for this touch',
  )
})

// A control on the tests above: if a genuine NEW press outside ALSO fails to
// close the menu, their "survives" results are a harness artifact (the
// document-level dismiss listener never actually running against these
// synthetic events), not a real finding about production behaviour. The
// dismiss contract is pointerdown-outside (use-outside-dismiss.ts), so that
// is what a genuine new press dispatches.
test('CONTROL: draggable=true, opened via native contextmenu -- a new pointerdown outside still closes it', async () => {
  const h = await mountHarness(true)
  await h.dispatch('touchstart')
  await h.dispatchContextMenu()
  assert.equal(h.menuPresent(), true, 'the native gesture should have opened the menu')
  const outside = dom.container.ownerDocument.createElement('div')
  dom.container.ownerDocument.body.appendChild(outside)
  await act(async () => {
    const ev = new (globalThis.window as unknown as { Event: typeof Event }).Event('pointerdown', {
      bubbles: true,
      cancelable: true,
    })
    Object.assign(ev, { clientX: 999, clientY: 999, pointerId: 1 })
    outside.dispatchEvent(ev)
  })
  assert.equal(
    h.menuPresent(),
    false,
    'if this is still true, the document-level dismiss listener is not actually firing in this harness -- the survive tests are not trustworthy',
  )
})
