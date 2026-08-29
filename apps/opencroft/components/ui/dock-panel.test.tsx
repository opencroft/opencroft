// The kit's dock panel in a real DOM: the position switch, and the two slots.
//
// What this pins is the part of the component a machine can judge. Which edge
// the panel is on is a fact about the switch -- three controls, one of them
// pressed -- and it is the only part of "the panel is docked to the right" that
// does not require a laid-out browser to observe. The drag itself, the sizes it
// produces and the store they are written to are checked in a browser, because
// jsdom lays nothing out: every element measures zero, so a resize that worked
// and one that did nothing are indistinguishable here.
//
// This lives in the app workspace rather than beside the component because the
// app's tsconfig.test.json deliberately claims packages/ui source for exactly
// this -- rendering a shared component under a runner that has a DOM.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// ResizeObserver is genuinely absent from jsdom and the panel group observes
// its own element; the rest exist on the jsdom window and are merely not copied
// onto `globalThis`.
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>

globals.ResizeObserver = FakeResizeObserver
win.ResizeObserver = FakeResizeObserver
for (const name of ['Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'DOMRect', 'MutationObserver']) {
  globals[name] = win[name]
}
globals.getComputedStyle = (win.getComputedStyle as (...args: unknown[]) => unknown).bind(win)

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { DockPanel } = await import('ui/components/ui/layouts/dock-panel')

after(() => dom.cleanup())

async function mount(node: ReactNode) {
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(node)
  })
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

function positionButtons(): HTMLButtonElement[] {
  const group = dom.container.querySelector('[role="group"][aria-label="Panel position"]')
  assert.ok(group, 'the position switch rendered')
  return Array.from((group as HTMLElement).querySelectorAll('button'))
}

test('the position switch offers every edge, marks the current one and reports a press', async () => {
  const chosen: string[] = []
  const { unmount } = await mount(
    <DockPanel dock='right' onDockChange={(side) => chosen.push(side)} title='A space' panel={<p>The chat</p>}>
      <p>The canvas</p>
    </DockPanel>,
  )

  try {
    const buttons = positionButtons()

    assert.deepEqual(
      buttons.map((button) => button.getAttribute('aria-label')),
      ['Dock the panel to the left', 'Dock the panel to the right', 'Dock the panel to the bottom'],
      'every edge is offered, and each control says which one it is',
    )
    assert.deepEqual(
      buttons.map((button) => button.getAttribute('aria-pressed')),
      ['false', 'true', 'false'],
      'the edge the panel is on is the one marked pressed',
    )

    await act(async () => {
      buttons[2].dispatchEvent(new (win.MouseEvent as typeof MouseEvent)('click', { bubbles: true, cancelable: true }))
    })
    assert.deepEqual(chosen, ['bottom'], 'pressing an edge reports it rather than moving the panel itself')
  } finally {
    await unmount()
  }
})

test('the panel is titled, and both it and the surface are on screen', async () => {
  const { unmount } = await mount(
    <DockPanel dock='left' onDockChange={() => {}} title='A space' panel={<p>The chat</p>}>
      <p>The canvas</p>
    </DockPanel>,
  )

  try {
    const text = dom.container.textContent ?? ''
    assert.match(text, /A space/, 'the panel carries its title')
    assert.match(text, /The chat/, 'the panel renders what it was given')
    assert.match(text, /The canvas/, 'the surface renders beside it')
  } finally {
    await unmount()
  }
})
