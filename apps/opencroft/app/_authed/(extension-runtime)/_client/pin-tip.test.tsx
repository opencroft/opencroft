// When a pin's tooltip shows: a mouse opens it while over the pin. A touch has
// no hover, so a press on the pin opens it and the next press anywhere else
// closes it. Mounted in a DOM,
// because what is checked is the events and the popup they put in the page.

import assert from 'node:assert/strict'
import test, { after, afterEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>
// Reached by bare name by the tooltip's positioning and focus handling.
for (const name of ['getComputedStyle', 'addEventListener', 'removeEventListener']) {
  globals[name] = (win[name] as (...args: unknown[]) => unknown).bind(win)
}
for (const name of ['HTMLInputElement', 'HTMLButtonElement', 'ShadowRoot', 'DOMRect']) {
  globals[name] = win[name]
}

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { PinTip } = await import('./pin-tip')

after(() => dom.cleanup())

let root: ReturnType<typeof createRoot> | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
})

async function render(tip: string | undefined) {
  root ??= createRoot(dom.container)
  await act(async () => {
    root?.render(
      <div>
        <PinTip tip={tip} pin={<div data-pin='' />} />
        <div data-elsewhere='' />
      </div>,
    )
  })
}

async function mount() {
  await render('"cat_007.png"')
  const pin = document.querySelector('[data-pin]')
  const elsewhere = document.querySelector('[data-elsewhere]')
  assert.ok(pin && elsewhere)
  return { pin, elsewhere }
}

async function press(element: Element, pointerType: 'touch' | 'mouse') {
  const PointerEventCtor = win.PointerEvent as typeof PointerEvent
  await act(async () => {
    element.dispatchEvent(new PointerEventCtor('pointerdown', { bubbles: true, pointerType, button: 0 }))
  })
}

// React reads pointer enter and leave from the pointer moving over and out.
async function move(from: Element, to: Element, pointerType: 'touch' | 'mouse') {
  const PointerEventCtor = win.PointerEvent as typeof PointerEvent
  await act(async () => {
    from.dispatchEvent(new PointerEventCtor('pointerout', { bubbles: true, pointerType, relatedTarget: to }))
    to.dispatchEvent(new PointerEventCtor('pointerover', { bubbles: true, pointerType, relatedTarget: from }))
  })
}

const tipShown = () => document.body.textContent?.includes('"cat_007.png"') ?? false

test('a tip that comes and goes keeps the same pin element', async () => {
  const { pin } = await mount()
  // Compared by identity: a failing assert.equal would print both elements,
  // and inspecting a jsdom element walks the whole document.
  await render(undefined)
  assert.ok(document.querySelector('[data-pin]') === pin, 'losing the tip keeps the pin element')
  await render('"cat_007.png"')
  assert.ok(document.querySelector('[data-pin]') === pin, 'gaining the tip keeps the pin element')
})

test('a mouse over the pin opens its tip, and leaving the pin closes it', async () => {
  const { pin, elsewhere } = await mount()
  await move(elsewhere, pin, 'mouse')
  assert.equal(tipShown(), true)

  await move(pin, elsewhere, 'mouse')
  assert.equal(tipShown(), false)
})

test('a touch entering the pin opens nothing by itself: the press decides', async () => {
  const { pin, elsewhere } = await mount()
  await move(elsewhere, pin, 'touch')
  assert.equal(tipShown(), false)
})

test('a touch press on the pin opens its tip, and a press elsewhere closes it', async () => {
  const { pin, elsewhere } = await mount()
  assert.equal(tipShown(), false)

  await press(pin, 'touch')
  assert.equal(tipShown(), true)

  await press(elsewhere, 'touch')
  assert.equal(tipShown(), false)
})

test('a second touch press on the pin keeps its tip open', async () => {
  const { pin } = await mount()
  await press(pin, 'touch')
  await press(pin, 'touch')
  assert.equal(tipShown(), true)
})

// jsdom has no hit-testing, so this reads the class that keeps the popup out
// of it: the arrow lies over the pin's edge, and a popup that took the pointer
// would close the tip it belongs to and take a tap's click from the pin.
test('an open tip takes no pointer, so the pin under its arrow keeps it', async () => {
  const { pin, elsewhere } = await mount()
  await move(elsewhere, pin, 'mouse')
  const popup = document.querySelector('[data-slot=tooltip-content]')
  assert.ok(popup, 'the tip is open')
  assert.equal(popup.classList.contains('pointer-events-none'), true)
})

test('a mouse press on the pin opens nothing: a mouse has hover for that', async () => {
  const { pin } = await mount()
  await press(pin, 'mouse')
  assert.equal(tipShown(), false)
})
