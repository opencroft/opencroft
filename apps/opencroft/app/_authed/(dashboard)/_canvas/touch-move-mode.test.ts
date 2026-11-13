// Which resize controls and title-bar drag area a node draws, under each
// pointer and move mode, rendered in a real React Flow.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { MouseEvent as ReactMouseEvent } from 'react'

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
let coarse = false
const globals = globalThis as unknown as Record<string, unknown>
const win = globals.window as unknown as Record<string, unknown>
win.matchMedia = (query: string) => ({
  matches: query === '(pointer: coarse)' && coarse,
  addEventListener: () => {},
  removeEventListener: () => {},
})
globals.ResizeObserver = FakeResizeObserver
win.ResizeObserver = FakeResizeObserver
globals.DOMMatrixReadOnly = FakeDOMMatrixReadOnly
win.DOMMatrixReadOnly = FakeDOMMatrixReadOnly
globals.SVGElement = win.SVGElement
// jsdom has no CSS.escape; the node ids here need no escaping.
globals.CSS = { escape: (value: string) => value }

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ReactFlow } = await import('@xyflow/react')
const { MoveModeContext, NodeDragArea } = await import('@/app/_authed/(dashboard)/_canvas/touch-move-mode')
const { NodeResizer } = await import('@/app/_authed/(dashboard)/_canvas/node-resizer')
const { FrameResizer } = await import('@/app/_authed/(dashboard)/_canvas/frame-resizer')
const { stackedFrame } = await import('@/app/_authed/(dashboard)/_canvas/frame-stacking')
const { isPlainClick } = await import('@/app/_authed/(dashboard)/_canvas/click-cycle')

after(() => dom.cleanup())

interface Scene {
  coarse: boolean
  /** The canvas's move mode; null for a canvas without the toggle. */
  moveMode: boolean | null
  selected: boolean
  zoom?: number
  /** Clicks the window's resize control at this position, once mounted. */
  click?: string
}

/** A resize control's position, from its classes: `top-left`, `right`. */
const positionOf = (control: Element) =>
  Array.from(control.classList)
    .filter((c) => ['top', 'right', 'bottom', 'left'].includes(c))
    .join('-')

const EIGHT_POSITIONS = ['bottom', 'bottom-left', 'bottom-right', 'left', 'right', 'top', 'top-left', 'top-right']

/** Mounts a window (host `NodeResizer`, a title bar with the drag area) and a frame, and reads what each drew. */
async function render(scene: Scene) {
  coarse = scene.coarse
  const Window = () =>
    createElement(
      'div',
      { className: 'window' },
      createElement(NodeResizer, { isVisible: true, minWidth: 300, minHeight: 200 }),
      createElement('div', { className: 'title relative isolate' }, createElement(NodeDragArea)),
    )
  const Frame = ({ id, selected }: { id: string; selected?: boolean }) => createElement(FrameResizer, { id, selected })
  const canvas = dom.container.ownerDocument.createElement('div')
  dom.container.append(canvas)
  const root = createRoot(canvas)
  const nodeClicks: string[] = []
  await act(async () => {
    root.render(
      createElement(
        MoveModeContext.Provider,
        { value: scene.moveMode },
        createElement(ReactFlow, {
          nodes: [
            { id: 'w', type: 'window', position: { x: 0, y: 0 }, data: {}, selected: scene.selected },
            stackedFrame({
              id: 'f',
              type: 'frame',
              position: { x: 500, y: 0 },
              data: {},
              selected: scene.selected,
              style: { width: 400, height: 300 },
            }),
            {
              id: 'm',
              type: 'member',
              parentId: 'f',
              position: { x: 20, y: 20 },
              data: {},
              style: { width: 100, height: 80 },
            },
          ],
          edges: [],
          nodeTypes: { window: Window, frame: Frame, member: () => createElement('div') },
          onNodeClick: (event: ReactMouseEvent, node: { id: string }) =>
            nodeClicks.push(`${node.id} ${isPlainClick(event, event.currentTarget) ? 'plain' : 'own'}`),
          defaultViewport: { x: 0, y: 0, zoom: scene.zoom ?? 1 },
          minZoom: 0.25,
        }),
      ),
    )
  })
  const controls = (nodeId: string) =>
    Array.from(
      canvas.querySelectorAll(
        `[data-id="${nodeId}"] .react-flow__resize-control, [data-touch-resize="${nodeId}"] .react-flow__resize-control`,
      ),
    ).map((el) => {
      const { style } = el as HTMLElement
      return {
        positions: positionOf(el).split('-'),
        line: el.classList.contains('line'),
        width: style.width,
        insideNode: el.closest('.react-flow__node') !== null,
        translate: style.getPropertyValue('translate'),
        dot: el.querySelector('span') !== null,
      }
    })
  if (scene.click) {
    const target = Array.from(
      canvas.querySelectorAll<HTMLElement>(
        '[data-id="w"] .react-flow__resize-control, [data-touch-resize="w"] .react-flow__resize-control',
      ),
    ).find((el) => positionOf(el) === scene.click)
    assert.ok(target, `a control at ${scene.click}`)
    await act(async () => {
      target.dispatchEvent(new (win.MouseEvent as typeof MouseEvent)('click', { bubbles: true }))
    })
  }
  const stackOrder = (selector: string) =>
    Array.from(canvas.querySelectorAll<HTMLElement>(selector)).map((el) => Number(el.style.zIndex))
  const dragArea = canvas.querySelector('.title > div') as HTMLElement | null
  const result = {
    window: controls('w'),
    frame: controls('f'),
    dragAreaHeight: dragArea?.style.height ?? null,
    dragAreaCentred: dragArea ? ['top-1/2', '-translate-y-1/2'].every((c) => dragArea.classList.contains(c)) : null,
    nodeStackOrders: stackOrder('.react-flow__node'),
    handleStackOrders: stackOrder('[data-touch-resize]'),
    nodeClicks,
  }
  await act(async () => root.unmount())
  canvas.remove()
  return result
}

const positionsOf = (controls: { positions: string[] }[]) => controls.map((c) => c.positions.join('-')).sort()

test('a fine pointer keeps the desktop controls, four edges and four corners, and no drag area', async () => {
  for (const moveMode of [null, true, false]) {
    const drawn = await render({ coarse: false, moveMode, selected: true })
    for (const controls of [drawn.window, drawn.frame]) {
      assert.equal(controls.length, 8, `moveMode ${moveMode}`)
      assert.equal(controls.filter((c) => c.line).length, 4, `moveMode ${moveMode}`)
      assert.equal(
        controls.some((c) => c.dot),
        false,
      )
    }
    assert.equal(drawn.dragAreaHeight, null)
  }
})

test('a coarse pointer on a canvas without the move toggle keeps the desktop controls', async () => {
  const drawn = await render({ coarse: true, moveMode: null, selected: true })
  assert.equal(drawn.window.filter((c) => c.line).length, 4)
  assert.equal(drawn.frame.filter((c) => c.line).length, 4)
  assert.equal(drawn.dragAreaHeight, null)
})

test('on touch with move mode off, a selected window and frame have no resize controls and no drag area', async () => {
  const drawn = await render({ coarse: true, moveMode: false, selected: true })
  assert.deepEqual(drawn.window, [])
  assert.deepEqual(drawn.frame, [])
  assert.equal(drawn.dragAreaHeight, null)
})

test('on touch with move mode on, an unselected node has no resize controls', async () => {
  const drawn = await render({ coarse: true, moveMode: true, selected: false })
  assert.deepEqual(drawn.window, [])
  assert.deepEqual(drawn.frame, [])
})

test('on touch with move mode on, a selected window and frame have eight 44px handles with a dot each', async () => {
  const drawn = await render({ coarse: true, moveMode: true, selected: true })
  for (const controls of [drawn.window, drawn.frame]) {
    assert.deepEqual(positionsOf(controls), EIGHT_POSITIONS)
    assert.ok(controls.every((c) => !c.line && c.width === '44px' && c.dot))
  }
})

test('on touch with move mode on, each handle is centred on its corner or edge, the corners drawn last', async () => {
  const drawn = await render({ coarse: true, moveMode: true, selected: true })
  for (const controls of [drawn.window, drawn.frame]) {
    assert.ok(controls.every((c) => c.translate === '-50% -50%' && !c.insideNode))
    assert.deepEqual(
      controls.map((c) => c.positions.length),
      [1, 1, 1, 1, 2, 2, 2, 2],
    )
  }
})

test('a click on a touch handle reaches the canvas as a click the node handles itself, which does not cycle', async () => {
  for (const position of ['top-right', 'top', 'left']) {
    const touch = await render({ coarse: true, moveMode: true, selected: true, click: position })
    assert.deepEqual(touch.nodeClicks, ['w own'], position)
  }
  // As a click on the desktop control, drawn inside the node, does.
  const desktop = await render({ coarse: false, moveMode: null, selected: true, click: 'top-right' })
  assert.deepEqual(desktop.nodeClicks, ['w own'])
})

test('on touch with move mode on, the handles stack above every node, the frame members included', async () => {
  const drawn = await render({ coarse: true, moveMode: true, selected: true })
  assert.equal(drawn.nodeStackOrders.length, 3)
  assert.equal(drawn.handleStackOrders.length, 2)
  const topNode = Math.max(...drawn.nodeStackOrders)
  assert.ok(
    drawn.handleStackOrders.every((z) => z > topNode),
    `handles ${drawn.handleStackOrders}, nodes ${drawn.nodeStackOrders}`,
  )
})

test('on touch with move mode on, the drag area is 44px on screen at the canvas zoom, or the bar when taller, centred on the bar', async () => {
  const atOne = await render({ coarse: true, moveMode: true, selected: false, zoom: 1 })
  assert.equal(atOne.dragAreaHeight, 'max(100%, 44px)')
  assert.equal(atOne.dragAreaCentred, true)
  assert.equal(
    (await render({ coarse: true, moveMode: true, selected: false, zoom: 0.5 })).dragAreaHeight,
    'max(100%, 88px)',
  )
})
