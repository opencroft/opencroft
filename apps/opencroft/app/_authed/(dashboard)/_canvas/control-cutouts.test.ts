import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
after(() => dom.cleanup())

const { controlsOf, cutoutClipPath, overlaps } = await import('@/app/_authed/(dashboard)/_canvas/control-cutouts')

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
})

test('a target over no control is not clipped', () => {
  assert.equal(cutoutClipPath(rect(0, 0, 44, 44), 44, 44, [rect(50, 0, 10, 10)]), '')
  assert.equal(cutoutClipPath(rect(0, 0, 44, 44), 44, 44, []), '')
})

test("a control the target covers gets a hole where it is drawn, in the target's own pixels", () => {
  assert.equal(
    cutoutClipPath(rect(100, 100, 44, 44), 44, 44, [rect(120, 110, 16, 16)]),
    'path(evenodd, "M0 0H44V44H0ZM20 10h16v16h-16Z")',
  )
})

test('a hole is cut only where the control overlaps the target', () => {
  assert.equal(
    cutoutClipPath(rect(0, 0, 44, 44), 44, 44, [rect(30, -10, 30, 20)]),
    'path(evenodd, "M0 0H44V44H0ZM30 0h14v10h-14Z")',
  )
})

test('on a target drawn scaled, the hole is in its unscaled pixels', () => {
  // Laid out 44px square and drawn at 88px on screen: a 16px control covers 8 of its pixels.
  assert.equal(
    cutoutClipPath(rect(0, 0, 88, 88), 44, 44, [rect(8, 8, 16, 16)]),
    'path(evenodd, "M0 0H44V44H0ZM4 4h8v8h-8Z")',
  )
})

test('every control the target covers gets its own hole', () => {
  assert.equal(
    cutoutClipPath(rect(0, 0, 44, 44), 44, 44, [rect(0, 0, 10, 10), rect(20, 20, 10, 10)]),
    'path(evenodd, "M0 0H44V44H0ZM0 0h10v10h-10ZM20 20h10v10h-10Z")',
  )
})

test('a target that is not laid out is not clipped', () => {
  assert.equal(cutoutClipPath(rect(0, 0, 0, 0), 0, 0, [rect(0, 0, 10, 10)]), '')
})

// The class lists are the ones React Flow's `Handle` renders for each state.
const controlNames = (html: string) => {
  const node = dom.container.ownerDocument.createElement('div')
  node.innerHTML = html
  dom.container.append(node)
  try {
    return controlsOf(node).map((control) => control.getAttribute('data-name'))
  } finally {
    node.remove()
  }
}

test("a node's controls are the handles a wire starts from and what a finger taps, an inner control counting as its outer one", () => {
  assert.deepEqual(
    controlNames(
      '<div class="react-flow__handle connectable connectablestart connectableend connectionindicator" data-name="wire-in"></div>' +
        '<div class="react-flow__handle connectablestart connectableend" data-name="not-connectable"></div>' +
        '<div class="react-flow__handle connectable connectableend" data-name="end-only"></div>' +
        '<button data-name="close"></button>' +
        '<div role="button" data-name="row"><button data-name="inner"></button></div>' +
        '<p data-name="text"></p>',
    ),
    ['wire-in', 'close', 'row'],
  )
})

test('a handle stays a control while a wire is drawn from it, without its connection indicator', () => {
  assert.deepEqual(
    controlNames(
      '<div class="react-flow__handle connectable connectablestart connectableend connectingfrom" data-name="from"></div>' +
        '<div class="react-flow__handle connectable connectablestart connectableend" data-name="same-type"></div>',
    ),
    ['from', 'same-type'],
  )
})

test('a target lies over a node it shares area with, on any side, and not over one it only touches', () => {
  const target = rect(100, 100, 44, 44)
  assert.equal(overlaps(target, rect(0, 0, 101, 101)), true)
  assert.equal(overlaps(target, rect(143, 143, 100, 100)), true)
  assert.equal(overlaps(target, rect(110, 110, 10, 10)), true)
  assert.equal(overlaps(target, rect(0, 0, 100, 300)), false)
  assert.equal(overlaps(target, rect(0, 144, 300, 100)), false)
})
