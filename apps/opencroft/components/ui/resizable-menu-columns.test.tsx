// The kit's resizable menu column in a real DOM with a stand-in for layout: the
// menu keeps its width in pixels when the space beside it changes, including
// when that space changes while the layout is still mounting, as when a page is
// entered from one whose sidebar the new page does not have.
//
// jsdom lays nothing out, so the test supplies the two measurements the panels
// library reads: each panel's offsetWidth, shared out of the group's width by
// the panels' flex-grow as a browser would, and ResizeObserver entries for the
// elements whose width changed. The group is narrower while the stand-in
// sidebar is in the document.
//
// Lives in the app workspace because the app's tsconfig.test.json claims
// packages/ui source for rendering under a runner that has a DOM.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

const PAGE_WIDTH = 1280
// 16px root font size: the menu's starting width, 24rem.
const MENU_WIDTH = 384

// The stand-in sidebar's width is its attribute's value.
const groupWidth = () =>
  PAGE_WIDTH -
  [...document.querySelectorAll('[data-test-sidebar]')].reduce(
    (sum, sidebar) => sum + Number(sidebar.getAttribute('data-test-sidebar')),
    0,
  )

Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
  configurable: true,
  get(this: HTMLElement) {
    if (this.hasAttribute('data-group')) return groupWidth()
    if (!this.hasAttribute('data-panel') || !this.parentElement) return 0
    const grows = [...this.parentElement.querySelectorAll<HTMLElement>(':scope > [data-panel]')].map(
      (panel) => Number.parseFloat(panel.style.flexGrow) || 0,
    )
    const total = grows.reduce((sum, grow) => sum + grow, 0)
    return total ? (groupWidth() * (Number.parseFloat(this.style.flexGrow) || 0)) / total : 0
  },
})
// The group at the page's left edge and its children side by side in it, which
// is how the library orders the handle and the panels and pairs them up.
const offsetLeft = (element: HTMLElement) => {
  let left = 0
  if (element.parentElement?.hasAttribute('data-group')) {
    for (let sibling = element.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
      left += (sibling as HTMLElement).offsetWidth
    }
  }
  return left
}
Object.defineProperty(window.HTMLElement.prototype, 'offsetLeft', {
  configurable: true,
  get(this: HTMLElement) {
    return offsetLeft(this)
  },
})
const getBoundingClientRect = window.HTMLElement.prototype.getBoundingClientRect
window.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  if (!this.hasAttribute('data-group') && !this.parentElement?.hasAttribute('data-group')) {
    return getBoundingClientRect.call(this)
  }
  return new window.DOMRect(offsetLeft(this), 0, this.offsetWidth, 600)
}
// jsdom does not reflect ARIA attributes, and the library reads an absent
// `ariaDisabled` as a disabled handle.
Object.defineProperty(window.Element.prototype, 'ariaDisabled', {
  configurable: true,
  get(this: Element) {
    return this.getAttribute('aria-disabled')
  },
})

// Delivers, as a browser does after layout, an entry for each observed element
// on its first observation and whenever its width has changed since.
const observers = new Set<FakeResizeObserver>()
class FakeResizeObserver {
  private widths = new Map<Element, number | undefined>()
  constructor(private callback: (entries: unknown[]) => void) {
    observers.add(this)
  }
  observe(element: Element) {
    this.widths.set(element, undefined)
  }
  unobserve(element: Element) {
    this.widths.delete(element)
  }
  disconnect() {
    this.widths.clear()
    observers.delete(this)
  }
  deliver() {
    const entries = []
    for (const [element, last] of this.widths) {
      const width = (element as HTMLElement).offsetWidth
      if (width === last) continue
      this.widths.set(element, width)
      entries.push({ target: element, borderBoxSize: [{ inlineSize: width, blockSize: 600 }] })
    }
    if (entries.length) this.callback(entries)
    return entries.length
  }
}
;(globalThis as unknown as { DOMRect: unknown }).DOMRect = window.DOMRect
// The library reads it without `window.` to turn the menu's rem sizes into pixels.
;(globalThis as unknown as { getComputedStyle: unknown }).getComputedStyle = window.getComputedStyle.bind(window)
;(globalThis.window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
// A query that never matches is the md-and-up arrangement, where the handle is live.
;(globalThis.window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})
;(window.Element.prototype as unknown as { getAnimations: () => unknown[] }).getAnimations = () => []
document.documentElement.style.fontSize = '16px'
document.body.style.fontSize = '16px'

const React = await import('react')
const { act } = React
const { createRoot } = await import('react-dom/client')
const { MenuLayout } = await import('ui/components/ui/layout/menulayout')

after(() => dom.cleanup())

// Lets the observers report until the layout stops changing.
async function settle() {
  for (let round = 0; round < 10; round++) {
    let delivered = 0
    await act(async () => {
      for (const observer of [...observers]) delivered += observer.deliver()
    })
    if (!delivered) return
  }
  throw new Error('the layout kept changing')
}

async function mount(node: ReactNode) {
  const host = document.createElement('div')
  dom.container.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(node)
  })
  await settle()
  return {
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      host.remove()
    },
  }
}

const menuPanel = () => dom.container.querySelector<HTMLElement>('[data-group] > [data-panel]')
const handle = () => dom.container.querySelector<HTMLElement>('[role="separator"]')

// A page entered from one with a sidebar: the sidebar leaves once the new page
// has mounted, in the same update, so the group grows during its mount.
function EnteredFromSidebarPage({ children }: { children: ReactNode }) {
  const [sidebar, setSidebar] = React.useState(true)
  React.useLayoutEffect(() => setSidebar(false), [])
  return (
    <>
      {sidebar && <aside data-test-sidebar='384' />}
      {children}
    </>
  )
}

const layout = (
  <MenuLayout isOpened={false} menuResize={{}} menu={<nav>Menu</nav>}>
    <p>Panel</p>
  </MenuLayout>
)

test('the menu starts at 24rem on a page loaded at its full width', async () => {
  const { unmount } = await mount(layout)
  try {
    assert.equal(document.querySelector('[data-test-sidebar]'), null)
    assert.equal(Math.round(menuPanel()?.offsetWidth ?? 0), MENU_WIDTH)
  } finally {
    await unmount()
  }
})

test('the menu starts at 24rem when the space beside it grows while it mounts', async () => {
  const { unmount } = await mount(<EnteredFromSidebarPage>{layout}</EnteredFromSidebarPage>)
  try {
    assert.equal(document.querySelector('[data-test-sidebar]'), null, 'the sidebar has left')
    assert.equal(Math.round(menuPanel()?.offsetWidth ?? 0), MENU_WIDTH)
  } finally {
    await unmount()
  }
})

test('a width chosen with the handle is the one kept when the space beside the menu changes', async () => {
  const widths: number[] = []
  const { unmount } = await mount(
    <MenuLayout isOpened={false} menuResize={{ onWidthChange: (width) => widths.push(width) }} menu={<nav>Menu</nav>}>
      <p>Panel</p>
    </MenuLayout>,
  )
  try {
    const separator = handle()
    assert.ok(separator)
    await act(async () => {
      separator.focus()
      separator.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    await settle()
    const chosen = Math.round(menuPanel()?.offsetWidth ?? 0)
    assert.ok(chosen > MENU_WIDTH, `the arrow key widened the menu (${chosen}px)`)
    assert.deepEqual(widths, [chosen], 'the chosen width is the one reported')

    // With focus elsewhere, a sidebar takes so much room that half the group,
    // the menu's maximum, is less than the chosen width, then leaves.
    separator.blur()
    const sidebar = document.createElement('aside')
    sidebar.setAttribute('data-test-sidebar', '480')
    document.body.append(sidebar)
    await settle()
    assert.equal(Math.round(menuPanel()?.offsetWidth ?? 0), (PAGE_WIDTH - 480) / 2, 'the maximum narrows the menu')
    sidebar.remove()
    await settle()
    assert.equal(Math.round(menuPanel()?.offsetWidth ?? 0), chosen, 'the chosen width is back once there is room')
    assert.deepEqual(widths, [chosen], 'only the handle reports a width')
  } finally {
    await unmount()
  }
})
