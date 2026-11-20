// The launcher opens with no row highlighted, so Enter opens nothing until the
// reader moves to a row or types. Mounted in a DOM because the highlight is
// cmdk's, kept in its store and shown as `aria-selected` on the row.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
})

class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

before(() => {
  const names = [
    'window',
    'document',
    'HTMLElement',
    'HTMLInputElement',
    'Element',
    'Node',
    'DOMRect',
    'KeyboardEvent',
    'Event',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
  ]
  for (const name of [...names, 'navigator', 'ResizeObserver', 'IS_REACT_ACT_ENVIRONMENT']) {
    savedGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
  }
  const win = dom.window as unknown as Record<string, unknown>
  for (const name of names) {
    const value = win[name]
    Object.defineProperty(globalThis, name, {
      value: typeof value === 'function' && /^[a-z]/.test(name) ? value.bind(dom.window) : value,
      configurable: true,
      writable: true,
    })
  }
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  win.ResizeObserver = FakeResizeObserver
  globals.ResizeObserver = FakeResizeObserver
  globals.IS_REACT_ACT_ENVIRONMENT = true
  // cmdk scrolls the highlighted row into view, and the scroll area waits
  // for its animations; jsdom lays nothing out and animates nothing.
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  dom.window.HTMLElement.prototype.getAnimations = () => []
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

const spaces = [
  { slug: 'alpha', name: 'Alpha', icon: '' },
  { slug: 'beta', name: 'Beta', icon: '' },
]
const apps = [
  { id: 'a1', spaceSlug: 'alpha', label: 'Notes', href: '/space/alpha/app/notes', type: 'Docs' },
  { id: 'b1', spaceSlug: 'beta', label: 'Board', href: '/space/beta/app/board', type: 'Tasks' },
]

// What a host gives a reader who may change the settings.
const withSettings = {
  apps: apps.map((app) => ({ ...app, settingsHref: `${app.href}/settings` })),
  settingsHrefFor: (slug: string) => `/space/${slug}/settings`,
}

// Imported after the DOM exists: react-dom binds to the globals it finds when
// first loaded. Mounts the launcher's page on Recent, under StrictMode as the
// app runs in development, and hands back what a test drives it with.
async function mountLauncher(
  settings: { apps?: typeof withSettings.apps; settingsHrefFor?: (slug: string) => string } = {},
) {
  const { StrictMode, act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { AppLauncherScreen } = await import('./app-launcher')

  const opened: string[] = []
  const container = dom.window.document.getElementById('root') as HTMLElement
  const root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(
        StrictMode,
        null,
        createElement(AppLauncherScreen, {
          spaces,
          apps: settings.apps ?? apps,
          recent: settings.apps ?? apps,
          pages: [],
          hrefFor: (slug: string) => `/space/${slug}`,
          settingsHrefFor: settings.settingsHrefFor,
          onNavigate: (href: string) => opened.push(href),
        }),
      ),
    )
  })

  const input = container.querySelector('input') as HTMLInputElement
  const highlighted = () =>
    [...container.querySelectorAll('[cmdk-item][aria-selected="true"]')].map((row) => row.textContent)
  const press = async (key: string) => {
    await act(async () => {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }
  const type = async (text: string) => {
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, text)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  const unmount = async () => {
    await act(async () => root.unmount())
  }
  const settingsLinks = () =>
    [...container.querySelectorAll('a[aria-label$=" settings"]')].map((link) => link.getAttribute('aria-label'))
  const link = (label: string) => container.querySelector(`a[aria-label="${label}"]`) as HTMLAnchorElement
  const click = async (element: Element) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }))
    })
  }
  const chooseSpace = async (name: string) => {
    await click(container.querySelector(`nav button[aria-label="${name}"]`) as HTMLButtonElement)
  }
  const pressOn = async (element: Element, key: string) => {
    await act(async () => {
      element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    })
  }
  return { opened, highlighted, press, type, unmount, settingsLinks, link, click, chooseSpace, pressOn }
}

test('opens with no row highlighted, and Enter opens nothing', async () => {
  const launcher = await mountLauncher()
  try {
    assert.deepEqual(launcher.highlighted(), [])
    await launcher.press('Enter')
    assert.deepEqual(launcher.opened, [])
  } finally {
    await launcher.unmount()
  }
})

test('an arrow key highlights the first row, which Enter then opens', async () => {
  const launcher = await mountLauncher()
  try {
    await launcher.press('ArrowDown')
    assert.deepEqual(launcher.highlighted(), ['Notes'])
    await launcher.press('Enter')
    assert.deepEqual(launcher.opened, ['/space/alpha/app/notes'])
  } finally {
    await launcher.unmount()
  }
})

test('typing highlights the first result', async () => {
  const launcher = await mountLauncher()
  try {
    await launcher.type('board')
    assert.deepEqual(launcher.highlighted(), ['Board'])
    await launcher.press('Enter')
    assert.deepEqual(launcher.opened, ['/space/beta/app/board'])
  } finally {
    await launcher.unmount()
  }
})

test('without settings addresses no row or heading has a settings button', async () => {
  const launcher = await mountLauncher()
  try {
    await launcher.chooseSpace('Alpha')
    assert.deepEqual(launcher.settingsLinks(), [])
  } finally {
    await launcher.unmount()
  }
})

test("each app row's settings button opens that app's settings, not the app", async () => {
  const launcher = await mountLauncher(withSettings)
  try {
    assert.deepEqual(launcher.settingsLinks(), ['Notes settings', 'Board settings'])
    await launcher.click(launcher.link('Board settings'))
    assert.deepEqual(launcher.opened, ['/space/beta/app/board/settings'])
  } finally {
    await launcher.unmount()
  }
})

test("the chosen space's heading has a settings button that opens the space's settings; Recent's has none", async () => {
  const launcher = await mountLauncher(withSettings)
  try {
    assert.equal(launcher.link('Recent settings'), null)
    await launcher.chooseSpace('Alpha')
    assert.deepEqual(launcher.settingsLinks(), ['Alpha settings', 'Notes settings'])
    await launcher.click(launcher.link('Alpha settings'))
    assert.deepEqual(launcher.opened, ['/space/alpha/settings'])
  } finally {
    await launcher.unmount()
  }
})

test('Enter on a settings button leaves the highlighted row closed', async () => {
  const launcher = await mountLauncher(withSettings)
  try {
    await launcher.press('ArrowDown')
    assert.deepEqual(launcher.highlighted(), ['Notes'])
    await launcher.pressOn(launcher.link('Board settings'), 'Enter')
    assert.deepEqual(launcher.opened, [])
  } finally {
    await launcher.unmount()
  }
})
