// Touch-specific regression: on a touch device, the canvas's own
// long-press/tap gesture handlers (flow-editor.tsx's handleTouchStart/
// handleTouchEnd) are wired on the same wrapper div that NodeContextMenu
// renders into as a floating sibling. A touchend that lands on a menu button
// is not inside a `.react-flow__node`, so before the fix it was
// misclassified as "tap on empty canvas" and cleared every node's selection
// -- before the browser's own synthetic click on that same button later ran
// the menu item's onClick (which reads that now-empty selection). The tap
// looked like it did nothing.
//
// This exercises the real `isCanvasMenuTouchTarget` guard and the real
// `NodeContextMenu` component against a harness that mirrors flow-editor.tsx's
// touch-handler wiring closely enough to reproduce the failure mode without
// mounting the whole canvas (which pulls in space loading, SSE, and the
// extension registry).
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement, useRef, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { isCanvasMenuTouchTarget } = await import('./canvas-touch-guard')
const { NodeContextMenu } = await import('./node-context-menu')

after(() => dom.cleanup())

function touchEvent(type: string, touches: { clientX: number; clientY: number; target: EventTarget }[]) {
  const ev = new (globalThis.window as unknown as { Event: typeof Event }).Event(type, { bubbles: true })
  Object.assign(ev, { touches, changedTouches: touches })
  return ev
}

interface Harness {
  deleteButton: () => HTMLElement
  emptyCanvas: () => HTMLElement
  deselectCallCount: () => number
  deletedSelectionSize: () => number | null
  tapEmptyCanvas: () => Promise<void>
  tapDeleteButton: () => Promise<void>
}

// Only the shape flow-editor.tsx's real handlers actually read -- avoids
// pulling in React's TouchEvent type (which would collide with lib.dom's
// native TouchEvent of the same name) just for a test harness.
interface MinimalTouchEvent {
  target: EventTarget | null
  changedTouches: ArrayLike<{ target: EventTarget | null }>
}

// Mirrors flow-editor.tsx's real wiring: an outer div carries the touch
// handlers, NodeContextMenu renders as its floating sibling, and a tap that
// isn't on a `.react-flow__node` and isn't on a canvas menu is treated as an
// empty-canvas tap that deselects everything.
async function mountHarness(): Promise<Harness> {
  let deselectCalls = 0
  let deletedSelectionSize: number | null = null

  function TouchHarness() {
    const [selected, setSelected] = useState(true)
    const canvasRef = useRef<HTMLDivElement>(null)

    function handleTouchStart(e: MinimalTouchEvent) {
      if (isCanvasMenuTouchTarget(e.target)) {
        return
      }
      // Real handler also arms a long-press timer here; irrelevant to this test.
    }

    function handleTouchEnd(e: MinimalTouchEvent) {
      if (isCanvasMenuTouchTarget(e.target)) {
        return
      }
      const el = e.changedTouches[0]?.target
      const nodeEl = el instanceof Element ? el.closest('.react-flow__node') : null
      if (!nodeEl) {
        deselectCalls++
        setSelected(false)
      }
    }

    return createElement(
      'div',
      { ref: canvasRef, onTouchStart: handleTouchStart, onTouchEnd: handleTouchEnd },
      createElement('div', { className: 'empty-canvas-area', 'data-testid': 'empty-canvas' }),
      createElement(NodeContextMenu, {
        position: { x: 0, y: 0 },
        node: { id: 'n1', type: 'default', position: { x: 0, y: 0 }, data: {}, selected },
        onCopy: () => {},
        onDelete: () => {
          deletedSelectionSize = selected ? 1 : 0
        },
        onClose: () => {},
      }),
    )
  }

  const root = createRoot(dom.container)
  after(() => act(() => root.unmount()))
  await act(async () => {
    root.render(createElement(TouchHarness, null))
  })

  const deleteButton = () => {
    const btn = Array.from(dom.container.querySelectorAll('button')).find((b) => b.textContent?.includes('Delete'))
    assert.ok(btn, 'expected a Delete button in the rendered menu')
    return btn as HTMLElement
  }
  const emptyCanvas = () => dom.container.querySelector('[data-testid="empty-canvas"]') as HTMLElement

  return {
    deleteButton,
    emptyCanvas,
    deselectCallCount: () => deselectCalls,
    deletedSelectionSize: () => deletedSelectionSize,
    tapEmptyCanvas: async () => {
      const target = emptyCanvas()
      await act(async () => {
        target.dispatchEvent(touchEvent('touchstart', [{ clientX: 0, clientY: 0, target }]))
        target.dispatchEvent(touchEvent('touchend', [{ clientX: 0, clientY: 0, target }]))
      })
    },
    tapDeleteButton: async () => {
      const target = deleteButton()
      await act(async () => {
        target.dispatchEvent(touchEvent('touchstart', [{ clientX: 0, clientY: 0, target }]))
        target.dispatchEvent(touchEvent('touchend', [{ clientX: 0, clientY: 0, target }]))
      })
      // The browser fires a synthetic click after touchend; that's what
      // actually invokes NodeContextMenu's onClick -> onDelete.
      await act(async () => {
        target.click()
      })
    },
  }
}

test('CONTROL: tapping empty canvas still deselects (the guard must not swallow real empty-space taps)', async () => {
  const harness = await mountHarness()
  await harness.tapEmptyCanvas()
  assert.equal(harness.deselectCallCount(), 1)
})

test('tapping the menu Delete button does not clear selection first, and the click reaches onDelete with the selection intact', async () => {
  const harness = await mountHarness()
  await harness.tapDeleteButton()
  assert.equal(harness.deselectCallCount(), 0, 'a touch on the menu must not be reclassified as an empty-canvas tap')
  assert.equal(harness.deletedSelectionSize(), 1, 'onDelete must see the selection as it was when the menu opened')
})
