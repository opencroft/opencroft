// The touch-specific case: on mobile, the pane's own pan
// gesture (@xyflow/react's panOnDrag, backed by d3-zoom) claims a touchstart
// the instant it lands -- including one that starts on a node -- by calling
// event.stopImmediatePropagation() in its own touchstarted handler, before
// any movement is known. That happens whether the touch turns out to be a
// pan, a tap, or a long-press, and it happens BEFORE the event would ever
// reach flow-editor.tsx's own ancestor touch handlers (handleTouchStart),
// which is why the long-press-to-open-context-menu never fires on a phone --
// not a menu-rendering bug, a propagation one.
//
// d3-zoom's own escape hatch is the 'nopan' class: an element (or an
// ancestor of the touch target) carrying it is excluded from the pan
// gesture's filter, so touchstarted bails out before calling
// stopImmediatePropagation. xyflow applies that class to a node itself only
// when the node is draggable -- which on mobile it deliberately isn't by
// default (nodesMovable starts off, "Pan canvas" mode) -- so flow-editor.tsx
// has to apply it independently. This proves the mechanism directly against
// the real @xyflow/react + d3-zoom stack: does a touchstart on a node reach
// an ancestor's touch handler, with and without that class.
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

// jsdom implements SVGElement on its own window (unlike ResizeObserver/
// DOMMatrixReadOnly above, which it lacks entirely) -- dom-environment.ts
// just doesn't copy it to the bare global the way it does HTMLElement/
// Element/Node. d3-zoom's own defaultExtent() references the bare
// identifier, and without it the exception it throws gets swallowed by
// jsdom's event dispatch -- silently skipping the very
// stopImmediatePropagation call this test exists to observe, which would
// make the CONTROL case look fixed when it was actually just erroring out
// before reaching it.
;(globalThis as unknown as { SVGElement: unknown }).SVGElement = (
  globalThis.window as unknown as { SVGElement: unknown }
).SVGElement

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow } = await import('@xyflow/react')

after(() => dom.cleanup())

function touchStartEvent(target: EventTarget) {
  const ev = new (globalThis.window as unknown as { Event: typeof Event }).Event('touchstart', {
    bubbles: true,
    cancelable: true,
  })
  const touch = { clientX: 10, clientY: 10, identifier: 0, target }
  Object.assign(ev, { touches: [touch], changedTouches: [touch], targetTouches: [touch] })
  return ev
}

async function mountAndTap(nodeClassName: string | undefined): Promise<boolean> {
  let ancestorTouchStartFired = false

  const root = createRoot(dom.container)
  after(() => act(() => root.unmount()))

  await act(async () => {
    root.render(
      createElement(
        'div',
        {
          onTouchStart: () => {
            ancestorTouchStartFired = true
          },
        },
        createElement(ReactFlow, {
          nodes: [{ id: 'n1', type: 'default', position: { x: 0, y: 0 }, data: {}, className: nodeClassName }],
          edges: [],
          panOnDrag: true,
          // Matches flow-editor.tsx's real mobile default (nodesMovable starts
          // off, "Pan canvas" mode) -- with this left at its own default
          // (true), the node's own per-node drag handler independently
          // claims the touchstart via the same nopropagation mechanism,
          // masking the pane-pan behaviour this test isolates.
          nodesDraggable: false,
          fitView: false,
        }),
      ),
    )
  })

  const node = dom.container.querySelector('.react-flow__node')
  assert.ok(node, 'expected a rendered node to dispatch the touch on')

  await act(async () => {
    node.dispatchEvent(touchStartEvent(node))
  })

  return ancestorTouchStartFired
}

test('CONTROL: a touchstart on a plain node is claimed by the pane pan gesture -- the ancestor never sees it', async () => {
  const fired = await mountAndTap(undefined)
  assert.equal(
    fired,
    false,
    "d3-zoom's own touchstarted must stopImmediatePropagation on an unmarked node -- if this now fires, either @xyflow/react changed this behavior or the harness stopped reproducing it",
  )
})

test("a touchstart on a node marked 'nopan' reaches the ancestor's own touch handler", async () => {
  const fired = await mountAndTap('nopan')
  assert.equal(fired, true, "the 'nopan' class must exempt the node from the pane's pan-gesture capture")
})
