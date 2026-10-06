// The kit's menu layout in a real DOM: on a small screen an opened item leads
// with Back to the menu, drawn by the layout itself rather than handed to some
// other surface to draw, and a host that draws its own way back gets none.
//
// jsdom applies no media queries, so which arrangement shows on which screen is
// not observable here; what is observable is that the control exists, is
// confined to small screens by its row, and returns to the menu when pressed.
//
// Lives in the app workspace because the app's tsconfig.test.json claims
// packages/ui source for rendering under a runner that has a DOM.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MenuLayout } = await import('ui/components/ui/layout/menulayout')

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

function backButton() {
  return dom.container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')
}

test('an opened item leads with Back on a small screen, and Back returns to the menu', async () => {
  let closed = 0
  const { unmount } = await mount(
    <MenuLayout isOpened onClosed={() => closed++} menu={<nav>Menu</nav>}>
      <p>Section content</p>
    </MenuLayout>,
  )

  try {
    const back = backButton()
    assert.ok(back, 'Back is drawn inside the layout')
    const row = back.parentElement
    assert.ok(row?.classList.contains('md:hidden'), 'the Back row is confined to small screens')
    assert.equal(
      row?.nextElementSibling?.textContent,
      'Section content',
      'the Back row sits directly above the opened content',
    )

    await act(async () => {
      back.click()
    })
    assert.equal(closed, 1, 'pressing Back asks the host to close the item')
  } finally {
    await unmount()
  }
})

test('a host that passes no onClosed gets no Back from the layout', async () => {
  const { unmount } = await mount(
    <MenuLayout isOpened menu={<nav>Menu</nav>}>
      <p>Section content</p>
    </MenuLayout>,
  )

  try {
    assert.equal(backButton(), null)
  } finally {
    await unmount()
  }
})
