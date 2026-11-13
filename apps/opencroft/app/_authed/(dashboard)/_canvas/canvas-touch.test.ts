// Runs routeCanvasTouch against the real @xyflow/react + d3-zoom stack: a pan
// or a zoom is the flow's onMove reporting a new viewport, and a touch the node
// keeps is one its content's own listener sees move while the viewport stays.
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
// copies with the bare Event and reads styles with the bare getComputedStyle.
globals.SVGElement = win.SVGElement
globals.Event = win.Event
globals.TouchEvent = win.TouchEvent
globals.getComputedStyle = (win.getComputedStyle as typeof getComputedStyle).bind(win)

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Handle, NodeResizeControl, Position, ReactFlow } = await import('@xyflow/react')
const { routeCanvasTouch } = await import('@/app/_authed/(dashboard)/_canvas/canvas-touch')
const { SCROLLS_ITSELF } = await import('@/app/_authed/(dashboard)/_canvas/canvas-node-scroll')

after(() => dom.cleanup())

interface Scene {
  selected?: boolean
  /** The scroller's content is taller than the scroller. */
  overflowing?: boolean
  /** The content carries the marker that says it scrolls itself. */
  scrollsItself?: boolean
  /** The element the finger lands on declares `touch-action: none`, as a slider's handle does. */
  dragsItself?: boolean
  /** xyflow makes the node draggable, as in "Move nodes" mode. */
  draggable?: boolean
  routed?: boolean
}

/**
 * Where a finger lands: the node's scrolling body, its title bar, its
 * connection handle, its resize handle, or empty canvas.
 */
type Spot = 'body' | 'title' | 'handle' | 'resizer' | 'pane'

interface Finger {
  on: Spot
  /** Where it goes, relative to where it landed. */
  dx?: number
  dy?: number
}

/**
 * What a browser's hit test returns at the finger, which jsdom cannot tell
 * without layout: the target and its ancestors.
 */
function stubHitTest(doc: Document, targetAt: () => Element) {
  doc.elementsFromPoint = () => {
    const hits: Element[] = []
    for (let el: Element | null = targetAt(); el; el = el.parentElement) {
      hits.push(el)
    }
    return hits
  }
}

/**
 * Mounts one window-shaped node (a title bar and a `nodrag nopan` body
 * holding a scroller), puts the fingers down together, moves them in steps,
 * lifts them, and tells what moved.
 */
async function sendTouches(scene: Scene, fingers: Finger[]) {
  const {
    selected = false,
    overflowing = true,
    scrollsItself = false,
    dragsItself = false,
    draggable = false,
    routed = true,
  } = scene
  let viewport = { x: 0, y: 0, zoom: 1 }
  let contentStarts = 0
  let contentMoves = 0
  let canvasTookTouch = 0
  let nodeDragged = false
  let nodeResized = false
  let moveEnded = false

  const Window = () =>
    createElement(
      'div',
      { className: 'window' },
      createElement('div', { className: 'title' }, 'title'),
      createElement(Handle, { type: 'source', position: Position.Right }),
      createElement(NodeResizeControl, { position: 'bottom-right' }),
      createElement(
        'div',
        { className: 'body nodrag nopan', [SCROLLS_ITSELF]: scrollsItself ? '' : undefined },
        createElement(
          'div',
          { className: 'scroller', style: { height: '100px', overflowY: 'auto' } },
          createElement(
            'div',
            { className: 'content', style: dragsItself ? { touchAction: 'none' } : undefined },
            'lines',
          ),
        ),
      ),
    )
  const canvas = dom.container.ownerDocument.createElement('div')
  dom.container.append(canvas)
  const root = createRoot(canvas)
  await act(async () => {
    root.render(
      createElement(ReactFlow, {
        nodes: [{ id: 'n1', type: 'window', position: { x: 0, y: 0 }, data: {}, selected, className: 'nopan' }],
        edges: [],
        nodeTypes: { window: Window },
        nodesDraggable: draggable,
        // jsdom has no layout, so every node sits at the flow's edge, where a node drag auto-pans.
        autoPanOnNodeDrag: false,
        onNodesChange: (changes: { type: string }[]) => {
          if (changes.some((change) => change.type === 'position')) {
            nodeDragged = true
          }
          if (changes.some((change) => change.type === 'dimensions' && 'resizing' in change && change.resizing)) {
            nodeResized = true
          }
        },
        panOnDrag: true,
        onMove: (_: unknown, next: typeof viewport) => {
          viewport = next
        },
        onMoveEnd: () => {
          moveEnded = true
        },
      }),
    )
  })
  const unroute = routed
    ? routeCanvasTouch(canvas, () => {
        canvasTookTouch++
      })
    : () => {}
  try {
    const body = canvas.querySelector('.body')
    const scroller = canvas.querySelector('.scroller')
    const content = canvas.querySelector('.content')
    const title = canvas.querySelector('.title')
    const handle = canvas.querySelector('.react-flow__handle')
    const resizer = canvas.querySelector('.react-flow__resize-control')
    const pane = canvas.querySelector('.react-flow__pane')
    assert.ok(
      body && scroller && content && title && handle && resizer && pane,
      'expected the node and the pane to render',
    )
    Object.defineProperty(scroller, 'clientHeight', { value: 100 })
    Object.defineProperty(scroller, 'scrollHeight', { value: overflowing ? 400 : 100 })
    stubHitTest(canvas.ownerDocument, () => content)
    body.addEventListener('touchstart', () => {
      contentStarts++
    })
    body.addEventListener('touchmove', () => {
      contentMoves++
    })

    const targets: Record<Spot, Element> = { body: content, title, handle, resizer, pane }
    const at = (finger: Finger, i: number, step: number) => ({
      identifier: i + 1,
      target: targets[finger.on],
      clientX: 100 + i * 40 + ((finger.dx ?? 0) * step) / 4,
      clientY: 100 + ((finger.dy ?? 0) * step) / 4,
      pageX: 100 + i * 40 + ((finger.dx ?? 0) * step) / 4,
      pageY: 100 + ((finger.dy ?? 0) * step) / 4,
    })
    const send = (type: string, target: Element, touches: object[], changed: object[]) =>
      target.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: touches as Touch[],
          changedTouches: changed as Touch[],
        }),
      )

    await act(async () => {
      fingers.forEach((finger, i) => {
        const down = fingers.slice(0, i + 1).map((f, j) => at(f, j, 0))
        send('touchstart', targets[finger.on], down, [down[i]])
      })
      for (let step = 1; step <= 4; step++) {
        const now = fingers.map((f, i) => at(f, i, step))
        fingers.forEach((finger, i) => {
          if (finger.dx || finger.dy) {
            send('touchmove', targets[finger.on], now, [now[i]])
          }
        })
      }
      const end = fingers.map((f, i) => at(f, i, 4))
      fingers.forEach((finger, i) => {
        send('touchend', targets[finger.on], end.slice(i + 1), [end[i]])
      })
    })
    // xyflow reports the end of a pan or zoom from a zero-delay timer.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
    return {
      panned: { x: Math.round(viewport.x), y: Math.round(viewport.y) },
      zoomed: viewport.zoom !== 1,
      contentSawMoves: contentMoves > 0,
      contentSawStart: contentStarts > 0,
      canvasTookTouch,
      nodeDragged,
      nodeResized,
      moveEnded,
    }
  } finally {
    unroute()
    await act(async () => root.unmount())
    canvas.remove()
  }
}

const drag = (on: Spot, dx: number, dy: number): Finger[] => [{ on, dx, dy }]
const pinch = (first: Spot, second: Spot): Finger[] => [
  { on: first, dx: -30 },
  { on: second, dx: 30 },
]

test('CONTROL: without the router, a drag or a pinch on a nopan node body moves nothing', async () => {
  const dragged = await sendTouches({ routed: false }, drag('body', 0, 60))
  assert.deepEqual(dragged.panned, { x: 0, y: 0 })
  assert.equal((await sendTouches({ routed: false }, pinch('body', 'body'))).zoomed, false)
})

test('CONTROL: a drag on empty canvas pans by the whole drag', async () => {
  assert.deepEqual((await sendTouches({}, drag('pane', 0, 60))).panned, { x: 0, y: 60 })
})

test('a drag on an unselected node pans the canvas by the whole drag, and the content sees no move', async () => {
  const taken = await sendTouches({}, drag('body', 0, 60))
  assert.deepEqual(taken.panned, { x: 0, y: 60 })
  assert.equal(taken.contentSawMoves, false)
  assert.equal(taken.contentSawStart, true, 'a touch lands on the content before its first move decides')
  assert.equal(taken.canvasTookTouch, 1)
  assert.equal(taken.moveEnded, true, 'the pan ends when the finger lifts')
})

test('a drag on a selected node whose content overflows on its axis stays with the content', async () => {
  const taken = await sendTouches({ selected: true }, drag('body', 0, 60))
  assert.deepEqual(taken.panned, { x: 0, y: 0 })
  assert.equal(taken.contentSawMoves, true)
  assert.equal(taken.canvasTookTouch, 0)
})

test('a drag on a selected node pans when its content fits, or overflows only on the other axis', async () => {
  assert.deepEqual((await sendTouches({ selected: true, overflowing: false }, drag('body', 0, 60))).panned, {
    x: 0,
    y: 60,
  })
  assert.deepEqual((await sendTouches({ selected: true }, drag('body', 60, 10))).panned, { x: 60, y: 10 })
})

test('a drag on a selected node whose content scrolls itself stays with the content', async () => {
  const taken = await sendTouches({ selected: true, overflowing: false, scrollsItself: true }, drag('body', 0, 60))
  assert.deepEqual(taken.panned, { x: 0, y: 0 })
  assert.equal(taken.contentSawMoves, true)
})

test('a drag on a selected node from content that takes every drag itself stays with the content, on either axis', async () => {
  for (const [dx, dy] of [
    [60, 0],
    [0, 60],
  ]) {
    const taken = await sendTouches({ selected: true, overflowing: false, dragsItself: true }, drag('body', dx, dy))
    assert.deepEqual(taken.panned, { x: 0, y: 0 }, `drag ${dx},${dy}`)
    assert.equal(taken.contentSawMoves, true, `drag ${dx},${dy}`)
    assert.equal(taken.canvasTookTouch, 0, `drag ${dx},${dy}`)
  }
})

test('a drag on an unselected node from content that takes every drag itself pans the canvas', async () => {
  const taken = await sendTouches({ overflowing: false, dragsItself: true }, drag('body', 60, 0))
  assert.deepEqual(taken.panned, { x: 60, y: 0 })
  assert.equal(taken.contentSawMoves, false)
})

test('a pinch on a node zooms the canvas, selected or not, and the content sees no move', async () => {
  for (const selected of [false, true]) {
    const taken = await sendTouches({ selected }, pinch('body', 'body'))
    assert.equal(taken.zoomed, true, `selected: ${selected}`)
    assert.equal(taken.contentSawMoves, false, `selected: ${selected}`)
  }
})

test('a pinch with one finger on empty canvas and one on a node zooms the canvas', async () => {
  assert.equal((await sendTouches({ selected: true }, pinch('pane', 'body'))).zoomed, true)
  // Vertical, so the finger on the node would scroll its content were it left to it.
  const nodeFirst = await sendTouches({ selected: true }, [
    { on: 'body', dy: -30 },
    { on: 'pane', dy: 30 },
  ])
  assert.equal(nodeFirst.zoomed, true)
  assert.equal(nodeFirst.contentSawMoves, false)
})

test('a tap on a node reaches its content and moves nothing', async () => {
  const taken = await sendTouches({}, [{ on: 'body' }])
  assert.deepEqual(taken.panned, { x: 0, y: 0 })
  assert.equal(taken.contentSawStart, true)
  assert.equal(taken.canvasTookTouch, 0)
})

test('a drag from a connection handle is left to xyflow', async () => {
  const taken = await sendTouches({}, drag('handle', 0, 60))
  assert.deepEqual(taken.panned, { x: 0, y: 0 })
  assert.equal(taken.canvasTookTouch, 0)
})

test('on a draggable node, a drag from its resize control resizes the node and pans nothing', async () => {
  // Content that cannot scroll, so a drag the router took would pan the canvas.
  const taken = await sendTouches({ draggable: true, selected: true, overflowing: false }, drag('resizer', 60, 60))
  assert.equal(taken.nodeResized, true)
  assert.deepEqual(taken.panned, { x: 0, y: 0 })
  assert.equal(taken.nodeDragged, false)
  assert.equal(taken.canvasTookTouch, 0)
})

test('on a draggable node, a drag from its title bar moves the node, and one from its body pans', async () => {
  const fromTitle = await sendTouches({ draggable: true }, drag('title', 0, 60))
  assert.deepEqual(fromTitle.panned, { x: 0, y: 0 })
  assert.equal(fromTitle.nodeDragged, true)
  assert.equal(fromTitle.canvasTookTouch, 0)
  const fromBody = await sendTouches({ draggable: true }, drag('body', 0, 60))
  assert.deepEqual(fromBody.panned, { x: 0, y: 60 })
  assert.equal(fromBody.nodeDragged, false)
})
