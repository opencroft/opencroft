// The error icon of a node in error is the way into its errors: a button when
// the host says what showing them means, a plain icon otherwise. Mounted in a
// DOM because what is checked is a real click and where it travels.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { JSDOM } from 'jsdom'
import { Server } from 'lucide-react'

import type { NodeFrameProps } from './node-frame'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

before(() => {
  const names = ['window', 'document', 'HTMLElement', 'Element', 'Node', 'MouseEvent', 'getComputedStyle']
  for (const name of [...names, 'navigator', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  for (const name of names) {
    Object.defineProperty(globalThis, name, {
      value: (dom.window as unknown as Record<string, unknown>)[name],
      configurable: true,
      writable: true,
    })
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globals.IS_REACT_ACT_ENVIRONMENT = true
})

after(() => {
  for (const [name, descriptor] of savedGlobals) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor)
    } else {
      delete globals[name]
    }
  }
  dom.window.close()
})

let unmount: (() => Promise<void>) | null = null

afterEach(async () => {
  await unmount?.()
  unmount = null
})

// Imported after the DOM exists: react-dom binds to the globals it finds when
// first loaded. The frame sits in an element with a click handler of its own,
// as a canvas node's wrapper has.
async function mount(props: Partial<NodeFrameProps>) {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { NodeFrame } = await import('./node-frame')

  let cardClicks = 0
  const container = document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(
        'div',
        { onClick: () => cardClicks++ },
        createElement(NodeFrame, { icon: Server, title: 'my-node', selected: false, ...props }),
      ),
    )
  })
  unmount = async () => {
    await act(async () => root.unmount())
  }
  return {
    showErrors: () => container.querySelector<HTMLButtonElement>('button[aria-label="Show errors"]'),
    click: async (element: HTMLElement) => {
      await act(async () => {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
    },
    cardClicks: () => cardClicks,
  }
}

test('a node in error with onShowErrors draws its icon as a button that calls it, and the card does not see the press', async () => {
  let shown = 0
  const frame = await mount({ error: true, onShowErrors: () => shown++, showErrorsClassName: 'nodrag nopan' })
  const button = frame.showErrors()
  assert.ok(button, 'the error icon is a button labelled "Show errors"')
  assert.equal(button.type, 'button')
  assert.ok(button.classList.contains('cursor-pointer'))
  assert.ok(button.classList.contains('nodrag') && button.classList.contains('nopan'), 'the host classes are on it')
  await frame.click(button)
  assert.equal(shown, 1)
  assert.equal(frame.cardClicks(), 0)
})

test('a node in error without onShowErrors draws a plain icon', async () => {
  const frame = await mount({ error: true })
  assert.equal(frame.showErrors(), null)
})

test('a node without errors has no error button, whatever onShowErrors is', async () => {
  const frame = await mount({ onShowErrors: () => {} })
  assert.equal(frame.showErrors(), null)
})
