// Runs routeCanvasWheel against the real @xyflow/react + d3-zoom stack: a
// zoom is the flow's onMove firing, and a wheel the node keeps is one its
// content's own listener sees while onMove stays silent.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
class FakeDOMMatrixReadOnly {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0
}
const globals = globalThis as unknown as Record<string, unknown>
const win = globals.window as unknown as Record<string, unknown>
win.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} })
globals.ResizeObserver = FakeResizeObserver
win.ResizeObserver = FakeResizeObserver
globals.DOMMatrixReadOnly = FakeDOMMatrixReadOnly
win.DOMMatrixReadOnly = FakeDOMMatrixReadOnly
// d3-zoom's defaultExtent reads the bare SVGElement; the router builds its
// copy with the bare WheelEvent and reads styles with the bare getComputedStyle.
globals.SVGElement = win.SVGElement
globals.WheelEvent = win.WheelEvent
globals.getComputedStyle = (win.getComputedStyle as typeof getComputedStyle).bind(win)
// The kit ScrollArea's Base UI viewport reads Element.getAnimations(), which jsdom lacks.
;(win.Element as typeof Element).prototype.getAnimations = () => []

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow } = await import('@xyflow/react')
const { routeCanvasWheel } = await import('@/app/_authed/(dashboard)/_canvas/canvas-wheel')
const { SCROLLS_ITSELF } = await import('@/app/_authed/(dashboard)/_canvas/canvas-node-scroll')
const { ScrollArea } = await import('ui/layout/scroll-area')

after(() => dom.cleanup())

interface Scene {
  selected?: boolean
  /** The scroller's content is taller than the scroller. */
  overflowing?: boolean
  /** The content stops the wheel's propagation, as a terminal does. */
  stopsPropagation?: boolean
  /**
   * Where the pointer lands: inside the scroller, or on a screen beside it
   * that the scroller lies under, the way a terminal's screen sits over its
   * scrolling viewport.
   */
  pointerOn?: 'content' | 'screen'
  /** The content carries the marker that says it scrolls itself. */
  scrollsItself?: boolean
  /** The scroller is the kit's ScrollArea, whose viewport scrolls, rather than a plain overflowing box. */
  kitScrollArea?: boolean
  routed?: boolean
}

interface Wheel {
  deltaX?: number
  deltaY?: number
  ctrlKey?: boolean
}

/**
 * What a browser's hit test returns at the pointer, which jsdom cannot tell
 * without layout: the target and its ancestors, with the scroller just under
 * the screen when the pointer is on the screen.
 */
function stubHitTest(doc: Document, target: Element, scroller: Element) {
  doc.elementsFromPoint = () => {
    const hits: Element[] = []
    for (let el: Element | null = target; el; el = el.parentElement) {
      hits.push(el)
      if (el === target && !scroller.contains(target)) {
        hits.push(scroller)
      }
    }
    return hits
  }
}

/** Mounts one node holding a scroller, sends it a wheel, and tells who took it. */
async function sendWheel(scene: Scene, wheel: Wheel = { deltaY: 100 }) {
  const {
    selected = false,
    overflowing = true,
    stopsPropagation = false,
    pointerOn = 'content',
    scrollsItself = false,
    kitScrollArea = false,
    routed = true,
  } = scene
  let zooms = 0
  let contentWheels = 0

  const content = createElement('div', { className: 'content' }, 'lines')
  const Scroller = () =>
    createElement(
      'div',
      { className: 'box', [SCROLLS_ITSELF]: scrollsItself ? '' : undefined },
      kitScrollArea
        ? createElement(ScrollArea, { className: 'h-full' }, content)
        : createElement('div', { className: 'scroller', style: { height: '100px', overflowY: 'auto' } }, content),
      createElement('div', { className: 'screen' }, 'rows'),
    )
  const canvas = dom.container.ownerDocument.createElement('div')
  dom.container.append(canvas)
  const root = createRoot(canvas)
  await act(async () => {
    root.render(
      createElement(ReactFlow, {
        nodes: [{ id: 'n1', type: 'scroller', position: { x: 0, y: 0 }, data: {}, selected }],
        edges: [],
        nodeTypes: { scroller: Scroller },
        onMove: () => {
          zooms++
        },
      }),
    )
  })
  const unroute = routed ? routeCanvasWheel(canvas) : () => {}
  try {
    const box = canvas.querySelector('.box')
    const scroller = canvas.querySelector(kitScrollArea ? '[data-slot=scroll-area-viewport]' : '.scroller')
    const target = canvas.querySelector(pointerOn === 'content' ? '.content' : '.screen')
    assert.ok(box && scroller && target, 'expected the node to render its scroller')
    if (kitScrollArea && scroller instanceof (win.HTMLElement as typeof HTMLElement)) {
      // The viewport declares the `overflow` shorthand, which a browser's computed style expands into
      // the longhands the router reads, and jsdom's does not.
      scroller.style.overflowX = scroller.style.overflow
      scroller.style.overflowY = scroller.style.overflow
    }
    Object.defineProperty(scroller, 'clientHeight', { value: 100 })
    Object.defineProperty(scroller, 'scrollHeight', { value: overflowing ? 400 : 100 })
    stubHitTest(canvas.ownerDocument, target, scroller)
    box.addEventListener('wheel', (event) => {
      contentWheels++
      if (stopsPropagation) {
        event.preventDefault()
        event.stopPropagation()
      }
    })

    await act(async () => {
      target.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, ...wheel }),
      )
    })
    return { zoomed: zooms > 0, contentSaw: contentWheels > 0 }
  } finally {
    unroute()
    await act(async () => root.unmount())
    canvas.remove()
  }
}

test('CONTROL: without the router, content that stops the wheel keeps it from the zoom', async () => {
  const taken = await sendWheel({ stopsPropagation: true, routed: false })
  assert.deepEqual(taken, { zoomed: false, contentSaw: true })
})

test('CONTROL: without the router, an unselected node scrolling nothing still zooms', async () => {
  assert.deepEqual(await sendWheel({ overflowing: false, routed: false }), { zoomed: true, contentSaw: true })
})

test('over an unselected node with overflowing content the wheel zooms, and the content never sees it', async () => {
  assert.deepEqual(await sendWheel({ stopsPropagation: true }), { zoomed: true, contentSaw: false })
  assert.deepEqual(await sendWheel({}), { zoomed: true, contentSaw: false })
})

test('a selected node with overflowing content keeps the wheel', async () => {
  assert.deepEqual(await sendWheel({ selected: true }), { zoomed: false, contentSaw: true })
  assert.deepEqual(await sendWheel({ selected: true, stopsPropagation: true }), { zoomed: false, contentSaw: true })
})

test('a selected terminal-shaped node keeps the wheel over a screen whose sibling scroller overflows', async () => {
  const terminal = { selected: true, pointerOn: 'screen', stopsPropagation: true } as const
  assert.deepEqual(await sendWheel(terminal), { zoomed: false, contentSaw: true })
  assert.deepEqual(await sendWheel({ ...terminal, overflowing: false }), { zoomed: true, contentSaw: false })
  assert.deepEqual(await sendWheel({ ...terminal, selected: false }), { zoomed: true, contentSaw: false })
})

test('a selected node whose content fits zooms the canvas', async () => {
  assert.deepEqual(await sendWheel({ selected: true, overflowing: false }), { zoomed: true, contentSaw: false })
})

// The kit ScrollArea scrolls in its viewport, which sets its overflow inline rather than through a class.
test('in a kit ScrollArea, a selected node keeps the wheel while the viewport overflows, and zooms otherwise', async () => {
  const kit = { kitScrollArea: true } as const
  assert.deepEqual(await sendWheel({ ...kit, selected: true }), { zoomed: false, contentSaw: true })
  assert.deepEqual(await sendWheel({ ...kit, selected: true, overflowing: false }), { zoomed: true, contentSaw: false })
  assert.deepEqual(await sendWheel(kit), { zoomed: true, contentSaw: false })
})

// The zoom reads only deltaY, so the wheel carries a smaller vertical part to
// show it reached the zoom.
test('a mostly sideways wheel over content that overflows only vertically zooms the canvas', async () => {
  const taken = await sendWheel({ selected: true }, { deltaX: 100, deltaY: 20 })
  assert.deepEqual(taken, { zoomed: true, contentSaw: false })
})

test('a pinch over a selected node with overflowing content zooms the canvas', async () => {
  const taken = await sendWheel({ selected: true }, { deltaY: 10, ctrlKey: true })
  assert.deepEqual(taken, { zoomed: true, contentSaw: false })
})

test('a selected node whose content scrolls itself keeps the wheel with nothing overflowing', async () => {
  const pager = { selected: true, overflowing: false, pointerOn: 'screen', stopsPropagation: true } as const
  assert.deepEqual(await sendWheel({ ...pager, scrollsItself: true }), { zoomed: false, contentSaw: true })
  assert.deepEqual(await sendWheel({ ...pager, scrollsItself: true }, { deltaX: 100, deltaY: 20 }), {
    zoomed: false,
    contentSaw: true,
  })
  assert.deepEqual(await sendWheel(pager), { zoomed: true, contentSaw: false })
})

test('over content that scrolls itself, an unselected node and a pinch zoom the canvas', async () => {
  const pager = { overflowing: false, pointerOn: 'screen', stopsPropagation: true, scrollsItself: true } as const
  assert.deepEqual(await sendWheel(pager), { zoomed: true, contentSaw: false })
  const pinch = await sendWheel({ ...pager, selected: true }, { deltaY: 10, ctrlKey: true })
  assert.deepEqual(pinch, { zoomed: true, contentSaw: false })
})

test('the router counts the attribute the terminal sets while its app scrolls itself', async () => {
  const terminal = await import('@opencroft/terminal/client')
  assert.equal(terminal.SCROLLS_ITSELF, SCROLLS_ITSELF)
})

test('unrouting removes every wheel listener the router added to the flow', async () => {
  const proto = (win.EventTarget as typeof EventTarget).prototype
  const { addEventListener, removeEventListener } = proto
  // Wheel listeners attached to a viewport and not yet removed, per viewport.
  const attached = new Map<EventTarget, Set<unknown>>()
  const onViewport = (el: EventTarget, type: string) =>
    type === 'wheel' && el instanceof (win.Element as typeof Element) && el.matches('.react-flow__viewport')
  let added = 0
  proto.addEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
    if (onViewport(this, type)) {
      added++
      attached.set(this, (attached.get(this) ?? new Set()).add(listener))
    }
    return addEventListener.call(this, type, listener as EventListener, options as AddEventListenerOptions)
  }
  proto.removeEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
    if (onViewport(this, type)) {
      attached.get(this)?.delete(listener)
    }
    return removeEventListener.call(this, type, listener as EventListener, options as EventListenerOptions)
  }
  try {
    assert.deepEqual(await sendWheel({ selected: true }), { zoomed: false, contentSaw: true })
  } finally {
    proto.addEventListener = addEventListener
    proto.removeEventListener = removeEventListener
  }
  assert.ok(added > 0, 'expected the router to guard the viewport while a node kept the wheel')
  assert.deepEqual(
    [...attached.values()].map((listeners) => listeners.size),
    [...attached.keys()].map(() => 0),
  )
})
