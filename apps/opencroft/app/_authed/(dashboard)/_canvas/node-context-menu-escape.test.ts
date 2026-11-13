// Escape closes the node context menu even when the same keydown re-renders
// the menu's owner first. On the canvas that is the usual case: the app's
// React listener sits on `document`, ahead of the menu's, and xyflow's Escape
// on a focused node unselects it, which re-renders the canvas (and hands the
// menu a fresh `onClose`) synchronously inside the keydown's dispatch.
//
// Here a `document` listener added before the menu mounts plays React's part:
// it re-renders the owner with `flushSync`, as a discrete event's update is.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act, createElement, useState } = await import('react')
const { createRoot } = await import('react-dom/client')
const { flushSync } = await import('react-dom')
const { NodeContextMenu } = await import('./node-context-menu')

after(() => dom.cleanup())

function escapeEvent(): Event {
  return new (globalThis.window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  })
}

async function mountMenu({ rerenderOnKeydown }: { rerenderOnKeydown: boolean }) {
  let rerender = () => {}
  function Owner() {
    const [open, setOpen] = useState(true)
    const [, setTick] = useState(0)
    rerender = () => setTick((t) => t + 1)
    return createElement(
      'div',
      null,
      createElement('div', { 'data-testid': 'node', tabIndex: -1 }),
      open &&
        createElement(NodeContextMenu, {
          position: { x: 0, y: 0 },
          node: { id: 'n1', type: 'default', position: { x: 0, y: 0 }, data: {}, selected: true },
          contexts: {},
          onCopy: () => {},
          onDelete: () => {},
          onClose: () => setOpen(false),
        }),
    )
  }

  const onKeydown = () => flushSync(() => rerender())
  if (rerenderOnKeydown) {
    document.addEventListener('keydown', onKeydown)
  }
  const container = document.createElement('div')
  dom.container.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(createElement(Owner, null))
  })
  const node = container.querySelector('[data-testid="node"]') as HTMLElement
  return {
    menuPresent: () => container.querySelector('[data-canvas-menu]') !== null,
    pressEscape: async () => {
      await act(async () => {
        node.dispatchEvent(escapeEvent())
      })
    },
    unmount: async () => {
      document.removeEventListener('keydown', onKeydown)
      await act(async () => root.unmount())
      container.remove()
    },
  }
}

test('Escape closes the menu when the same keydown re-renders its owner first', async () => {
  const menu = await mountMenu({ rerenderOnKeydown: true })
  try {
    assert.equal(menu.menuPresent(), true, 'the menu is open before the key')
    await menu.pressEscape()
    assert.equal(menu.menuPresent(), false, 'one Escape closes the menu')
  } finally {
    await menu.unmount()
  }
})

test('Escape closes the menu when nothing else handles the key', async () => {
  const menu = await mountMenu({ rerenderOnKeydown: false })
  try {
    assert.equal(menu.menuPresent(), true, 'the menu is open before the key')
    await menu.pressEscape()
    assert.equal(menu.menuPresent(), false, 'one Escape closes the menu')
  } finally {
    await menu.unmount()
  }
})
