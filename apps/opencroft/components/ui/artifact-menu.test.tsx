// The kit's artifacts menu in a real DOM: that it closes the way a menu does.
//
// Choosing an artifact opens it, so the menu must go away on the choice, and
// on Escape and a press outside like any other. The items are radio items --
// the check says which note is open -- and a radio item stays open on a press
// unless told otherwise, so the choice is the case worth pinning.
//
// This lives in the app workspace rather than beside the component because the
// app's tsconfig.test.json deliberately claims packages/ui source for exactly
// this -- rendering a shared component under a runner that has a DOM.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>
for (const name of [
  'Event',
  'CustomEvent',
  'MouseEvent',
  'PointerEvent',
  'KeyboardEvent',
  'FocusEvent',
  'DOMRect',
  'MutationObserver',
]) {
  if (win[name]) {
    globals[name] = win[name]
  }
}
// The menu opens on mousedown and schedules its transition on an animation
// frame; jsdom has both frame functions on its window but not on `globalThis`,
// and without them the open throws before anything renders.
for (const name of ['requestAnimationFrame', 'cancelAnimationFrame']) {
  globals[name] = (win[name] as (...args: unknown[]) => unknown).bind(win)
}
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globals.ResizeObserver = FakeResizeObserver
win.ResizeObserver = FakeResizeObserver
globals.getComputedStyle = (win.getComputedStyle as (...args: unknown[]) => unknown).bind(win)

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ArtifactMenu } = await import('ui/components/ui/group-chat/thread-artifacts')

after(() => dom.cleanup())

const ARTIFACTS = [
  { id: 'a', title: 'First note', content: 'one' },
  { id: 'b', title: 'Second note', content: 'two' },
]

async function mount(node: ReactNode) {
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(node)
  })
  return async () => {
    await act(async () => {
      root.unmount()
    })
  }
}

// Let the menu's own effects and any close transition settle.
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
}

function openMenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[role="menu"]:not([data-closed])')
}

// Asserted as a boolean, never by comparing the element: a failing comparison
// formats both sides, and formatting a jsdom element walks the whole document
// until the test times out instead of failing on this line.
function menuIsOpen(): boolean {
  return openMenu() !== null
}

async function press(element: Element) {
  const view = globalThis.window
  await act(async () => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse', view }))
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, view }))
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse', view }))
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, view }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, view }))
  })
  await settle()
}

async function openFromTrigger() {
  const trigger = dom.container.querySelector<HTMLElement>('button[aria-label="Artifacts"]')
  assert.ok(trigger, 'the trigger rendered')
  await press(trigger)
  const menu = openMenu()
  assert.ok(menu, 'pressing the trigger opens the menu')
  return menu
}

test('choosing an artifact opens it and closes the menu', async () => {
  const opened: string[] = []
  const unmount = await mount(<ArtifactMenu artifacts={ARTIFACTS} onOpen={(id) => opened.push(id)} />)
  const menu = await openFromTrigger()
  const items = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'))
  assert.deepEqual(
    items.map((item) => item.textContent),
    ['First note', 'Second note'],
  )
  await press(items[1] as HTMLElement)
  assert.deepEqual(opened, ['b'])
  assert.equal(menuIsOpen(), false, 'the menu is closed after the choice')
  await unmount()
})

test('Escape closes the menu without choosing anything', async () => {
  const opened: string[] = []
  const unmount = await mount(<ArtifactMenu artifacts={ARTIFACTS} onOpen={(id) => opened.push(id)} />)
  const menu = await openFromTrigger()
  await act(async () => {
    menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
  await settle()
  assert.equal(menuIsOpen(), false, 'the menu is closed after Escape')
  assert.deepEqual(opened, [])
  await unmount()
})

test('a press outside closes the menu without choosing anything', async () => {
  const opened: string[] = []
  const unmount = await mount(
    <div>
      <ArtifactMenu artifacts={ARTIFACTS} onOpen={(id) => opened.push(id)} />
      <p data-testid='outside'>elsewhere</p>
    </div>,
  )
  await openFromTrigger()
  const outside = dom.container.querySelector('[data-testid="outside"]')
  assert.ok(outside)
  await press(outside)
  assert.equal(menuIsOpen(), false, 'the menu is closed after a press outside')
  assert.deepEqual(opened, [])
  await unmount()
})
