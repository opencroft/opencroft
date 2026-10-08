// A mouse drag that starts in a rendered table is kept on the table's rows
// while it scrolls the table's frame: beside the frame the frame holds the
// pointer, and the selection's end is put back at the frame's edge every
// frame. The mechanism's full sequence is pinned through the code block, which
// shares it; this pins that the table's frame is the box it runs on, that a
// link in a cell keeps its click, and that an editor's table is left alone.
//
// jsdom has no layout, no pointer capture and no hit testing, so the frame's
// box, the capture calls, the point-to-text lookup and the selection are stood
// in for.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import type { ReactNode } from 'react'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownTable: typeof import('./markdown-table').MarkdownTable
// The stand-ins `mount` puts over these are taken off again after each test.
let caretPositionFromPoint: Document['caretPositionFromPoint']
let getSelection: Window['getSelection']

// The frame's border box, in client coordinates, and its border.
const TOP = 100
const BOTTOM = 160
const LEFT = 20
const RIGHT = 320
const BORDER = 1

before(async () => {
  container = installTestDom()
  ;(globalThis as unknown as Record<string, unknown>).PointerEvent = window.PointerEvent
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ MarkdownTable } = await import('./markdown-table'))
  ;({ caretPositionFromPoint } = document)
  ;({ getSelection } = window)
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
  document.caretPositionFromPoint = caretPositionFromPoint
  window.getSelection = getSelection
})

interface Table {
  cell: HTMLElement
  /** Every capture call on the frame, in order: `set` or `release`. */
  calls: string[]
  /** Every point the selection's end was put back at, as `x,y`. */
  ends: string[]
}

const ROWS = (
  <tbody>
    <tr>
      <td>first</td>
      <td>
        <a href='#second'>second</a>
      </td>
    </tr>
  </tbody>
)

async function mount(table: ReactNode = <MarkdownTable>{ROWS}</MarkdownTable>): Promise<Table> {
  const next = createRoot(container)
  root = next
  await act(async () => next.render(table))
  const frame = container.querySelector('table')?.parentElement as HTMLElement
  const cell = container.querySelector('td') as HTMLElement
  const calls: string[] = []
  let captured = false
  frame.getBoundingClientRect = () => ({ top: TOP, bottom: BOTTOM, left: LEFT, right: RIGHT }) as DOMRect
  // The frame draws its own border, BORDER wide on each side.
  Object.defineProperty(frame, 'clientLeft', { value: BORDER })
  Object.defineProperty(frame, 'clientWidth', { value: RIGHT - LEFT - 2 * BORDER })
  frame.hasPointerCapture = () => captured
  frame.setPointerCapture = () => {
    captured = true
    calls.push('set')
  }
  frame.releasePointerCapture = () => {
    captured = false
    calls.push('release')
  }
  // The text under any point is the first cell's text node; which character is
  // the browser's business, so the point itself is what gets recorded.
  const text = cell.firstChild as Text
  const ends: string[] = []
  let point = ''
  document.caretPositionFromPoint = (x: number, y: number) => {
    point = `${x},${y}`
    return { offsetNode: text, offset: 0 } as unknown as CaretPosition
  }
  window.getSelection = () =>
    ({
      rangeCount: 1,
      extend: () => {
        ends.push(point)
      },
    }) as unknown as Selection
  return { cell, calls, ends }
}

/**
 * Two animation frames, counted rather than timed: the table asks for its
 * next frame before this does, so its own frame has run at least twice when
 * this resolves.
 */
const frames = () =>
  act(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))

function pointer(target: EventTarget, type: string, init: PointerEventInit) {
  target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, ...init }))
}

const MOUSE = { pointerType: 'mouse', button: 0 } as const

test('the frame holds the pointer beside it, and lets it go back over the table and below it', async () => {
  const { cell, calls } = await mount()
  pointer(cell, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 40, clientY: 130 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: 100, clientY: 130 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: 130 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: BOTTOM + 30 })
  assert.deepEqual(calls, ['set', 'release', 'set', 'release'])
  pointer(window, 'pointerup', MOUSE)
})

// A captured pointer's release, and the click after it, go to the frame, so a
// capture taken at the press would stop the link from opening.
test('a press on a link in a cell leaves the pointer to the link', async () => {
  const { calls } = await mount()
  const link = container.querySelector('a') as HTMLAnchorElement
  pointer(link, 'pointerdown', { ...MOUSE, clientX: 200, clientY: 120 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: 201, clientY: 121 })
  pointer(window, 'pointerup', MOUSE)
  assert.deepEqual(calls, [])
})

test("an editor's table is left to the editor", async () => {
  const { cell, calls, ends } = await mount(<MarkdownTable table={<table>{ROWS}</table>} />)
  pointer(cell, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 40, clientY: 130 })
  await frames()
  assert.deepEqual(calls, [])
  assert.deepEqual(ends, [])
  pointer(window, 'pointerup', MOUSE)
})

test('beside the frame, the selection end is put back on the row just inside the border the pointer left by', async () => {
  const { cell, ends } = await mount()
  pointer(cell, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 40, clientY: 130 })
  await frames()
  assert.ok(ends.length > 1, 'once a frame, not once')
  assert.deepEqual(new Set(ends), new Set([`${RIGHT - BORDER - 1},130`]))
  ends.length = 0
  pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: 120 })
  await frames()
  assert.deepEqual(new Set(ends), new Set([`${LEFT + BORDER + 1},120`]))
  pointer(window, 'pointerup', MOUSE)
})
