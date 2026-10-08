// A mouse drag that starts in a code block holds the pointer on the code while
// the pointer is beside the block's lines, lets it go back over them and above
// and below them, and while the pointer is beside the lines puts the
// selection's end back on the line every frame.
//
// Mounted, because what is under test is the sequence: the press decides
// whether the drag is the block's at all, the moves capture and release, and
// the release must leave nothing listening. jsdom has no layout, no pointer
// capture and no hit testing, so the block's box, the three capture calls, the
// point-to-text lookup and the selection are stood in for; whether the browser
// then selects the right text is a property of the browser, checked in one.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let CodeBlock: typeof import('./code-block').CodeBlock
// The stand-ins `mount` puts over these are taken off again after each test.
let caretPositionFromPoint: Document['caretPositionFromPoint']
let getSelection: Window['getSelection']

// The block's lines, in client coordinates.
const TOP = 100
const BOTTOM = 160
const LEFT = 20
const RIGHT = 320

before(async () => {
  container = installTestDom()
  ;(globalThis as unknown as Record<string, unknown>).PointerEvent = window.PointerEvent
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ CodeBlock } = await import('./code-block'))
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

interface Code {
  pre: HTMLPreElement
  /** Every capture call, in order: `set` or `release`. */
  calls: string[]
  /** Every point the selection's end was put back at, as `x,y`. */
  ends: string[]
}

async function mount(): Promise<Code> {
  const next = createRoot(container)
  root = next
  // No language, so the block stays the plain `pre` it renders first and no
  // highlighter swaps it out from under the test.
  await act(async () => next.render(<CodeBlock code={'const first = 1\nconst second = 2'} />))
  const pre = container.querySelector('pre') as HTMLPreElement
  const calls: string[] = []
  let captured = false
  pre.getBoundingClientRect = () => ({ top: TOP, bottom: BOTTOM, left: LEFT, right: RIGHT }) as DOMRect
  Object.defineProperty(pre, 'clientLeft', { value: 0 })
  Object.defineProperty(pre, 'clientWidth', { value: RIGHT - LEFT })
  pre.hasPointerCapture = () => captured
  pre.setPointerCapture = () => {
    captured = true
    calls.push('set')
  }
  pre.releasePointerCapture = () => {
    captured = false
    calls.push('release')
  }
  // The text under any point is the code's own text node; which character is
  // the browser's business, so the point itself is what gets recorded.
  const text = pre.querySelector('code')?.firstChild as Text
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
  return { pre, calls, ends }
}

/**
 * Two animation frames, counted rather than timed. A frame callback runs in
 * the order it was asked for, and the block asks for its next frame before
 * this does, so the block's own frame has run at least twice when this
 * resolves -- however long the event loop stalls in between.
 */
const frames = () =>
  act(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))))

function pointer(target: EventTarget, type: string, init: PointerEventInit) {
  target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerId: 1, ...init }))
}

const MOUSE = { pointerType: 'mouse', button: 0 } as const

test('a mouse press on the code leaves the pointer free until it goes past a side', async () => {
  const { pre, calls } = await mount()
  pointer(pre, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: 200, clientY: 150 })
  assert.deepEqual(calls, [])
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 10, clientY: 150 })
  assert.deepEqual(calls, ['set'])
  pointer(window, 'pointerup', MOUSE)
})

test('the pointer is let go back over the lines, above and below them, and held again beside them', async () => {
  const { pre, calls } = await mount()
  pointer(pre, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: 150 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: 100, clientY: 150 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 10, clientY: 130 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 10, clientY: BOTTOM + 30 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 10, clientY: 130 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 10, clientY: TOP - 10 })
  assert.deepEqual(calls, ['set', 'release', 'set', 'release', 'set', 'release'])
  pointer(window, 'pointerup', MOUSE)
})

test('nothing is listening once the press is over', async () => {
  for (const end of ['pointerup', 'pointercancel']) {
    const { pre, calls } = await mount()
    pointer(pre, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
    pointer(window, end, MOUSE)
    pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: 120 })
    pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: BOTTOM + 30 })
    assert.deepEqual(calls, [], `after ${end}`)
    await act(async () => root?.unmount())
    root = null
  }
})

test('a touch, a right button and a press on the copy control leave the pointer alone', async () => {
  const { pre, calls } = await mount()
  pointer(pre, 'pointerdown', { pointerType: 'touch', button: 0, clientX: 100, clientY: 120 })
  pointer(window, 'pointermove', { pointerType: 'touch', clientX: LEFT - 10, clientY: 120 })
  pointer(window, 'pointerup', { pointerType: 'touch' })
  pointer(pre, 'pointerdown', { pointerType: 'mouse', button: 2, clientX: 100, clientY: 120 })
  pointer(window, 'pointermove', { pointerType: 'mouse', clientX: LEFT - 10, clientY: 120 })
  pointer(window, 'pointerup', MOUSE)
  const copy = container.querySelector('button') as HTMLButtonElement
  pointer(copy, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: 120 })
  pointer(window, 'pointerup', MOUSE)
  assert.deepEqual(calls, [])
})

test('beside the lines, the selection end is put back on the line at the edge the pointer left by', async () => {
  const { pre, ends } = await mount()
  pointer(pre, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
  pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: 120 })
  await frames()
  assert.ok(ends.length > 1, 'once a frame, not once')
  assert.deepEqual(new Set(ends), new Set([`${LEFT + 1},120`]))
  ends.length = 0
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 40, clientY: 130 })
  await frames()
  assert.deepEqual(new Set(ends), new Set([`${RIGHT - 1},130`]))
  pointer(window, 'pointerup', MOUSE)
})

test('inside the block, above it and below it, the selection is left to the browser', async () => {
  const { pre, ends } = await mount()
  pointer(pre, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
  await frames()
  pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: TOP - 5 })
  await frames()
  pointer(window, 'pointermove', { ...MOUSE, clientX: RIGHT + 10, clientY: BOTTOM + 5 })
  await frames()
  assert.deepEqual(ends, [])
  pointer(window, 'pointerup', MOUSE)
})

test('the frames stop with the press', async () => {
  for (const end of ['pointerup', 'pointercancel']) {
    const { pre, ends } = await mount()
    pointer(pre, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
    pointer(window, 'pointermove', { ...MOUSE, clientX: LEFT - 10, clientY: 120 })
    pointer(window, end, MOUSE)
    await frames()
    assert.deepEqual(ends, [], `after ${end}`)
    await act(async () => root?.unmount())
    root = null
  }
})

test('another pointer moving does not move the drag', async () => {
  const { pre, calls, ends } = await mount()
  pointer(pre, 'pointerdown', { ...MOUSE, clientX: 100, clientY: 120 })
  window.dispatchEvent(
    new window.PointerEvent('pointermove', { pointerId: 2, ...MOUSE, clientX: LEFT - 10, clientY: 120 }),
  )
  await frames()
  assert.deepEqual(calls, [])
  assert.deepEqual(ends, [])
  pointer(window, 'pointerup', MOUSE)
})
