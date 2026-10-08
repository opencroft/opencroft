// Copy link to this page and Open link from clipboard stand in for the
// address bar, so they are drawn at the top of a menu only in an installed
// app's own window, and a browser tab's menu is unchanged.
//
// Mounted in an open menu rather than rendered to markup, because the items
// live inside the menu primitive and follow the display mode as it changes.

import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import { JSDOM } from 'jsdom'

const PAGE = 'http://localhost/space/acme/app/docs?page=intro'

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: PAGE,
  pretendToBeVisual: true,
})

// The display mode the fake window runs in, and the listeners a change tells.
let displayMode = 'browser'
const displayModeListeners = new Set<() => void>()

function setDisplayMode(mode: string) {
  displayMode = mode
  for (const listener of displayModeListeners) {
    listener()
  }
}

// A media query list for a comma-separated list of `(display-mode: x)`
// queries, which matches when any of them names the current mode.
function matchMedia(query: string) {
  return {
    get matches() {
      return query.split(',').some((part) => part.trim() === `(display-mode: ${displayMode})`)
    },
    addEventListener: (_type: string, listener: () => void) => displayModeListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => displayModeListeners.delete(listener),
  }
}

type Clipboard =
  | {
      writeText?: (text: string) => Promise<void>
      readText?: () => Promise<string>
    }
  | undefined
let clipboard: Clipboard
const copiedTexts: string[] = []

// What window.open was asked for, and the window it answers: a fake one that
// still points back at its opener, or null for a blocked window. The opener
// is a stand-in string: a failed assertion prints it, and printing a whole
// jsdom window never finishes.
type OpenedWindow = { opener: unknown }
const OPENER = 'the window that opened it'
const openCalls: unknown[][] = []
let openAnswer: () => OpenedWindow | null = () => ({ opener: OPENER })
let lastOpened: OpenedWindow | null = null

const globals = globalThis as unknown as Record<string, unknown>
const savedGlobals = new Map<string, PropertyDescriptor | undefined>()

before(() => {
  // What react-dom and the menu primitive reach for: the document, frames and
  // computed styles, a rect to position against, and an abort signal jsdom's
  // own listeners accept.
  const names = [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'DOMRect',
    'AbortController',
    'AbortSignal',
  ]
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
  globals.window = dom.window
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globals.IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(dom.window, 'matchMedia', { value: matchMedia, configurable: true })
  Object.defineProperty(dom.window.navigator, 'clipboard', { get: () => clipboard, configurable: true })
  Object.defineProperty(dom.window, 'open', {
    value: (...args: unknown[]) => {
      openCalls.push(args)
      lastOpened = openAnswer()
      return lastOpened
    },
    configurable: true,
  })
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

// Imported after the DOM exists, never before: react-dom binds to the globals
// it finds when first loaded.
async function load() {
  const { act, createElement } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const menu = await import('ui/components/ui/dropdown-menu')
  const { TitleBarPageLinks } = await import('./title-bar')
  return { act, createElement, createRoot, renderToStaticMarkup, menu, TitleBarPageLinks }
}

let unmount: (() => Promise<void>) | null = null

afterEach(async () => {
  await unmount?.()
  unmount = null
  displayMode = 'browser'
  clipboard = undefined
  copiedTexts.length = 0
  openCalls.length = 0
  openAnswer = () => ({ opener: OPENER })
  lastOpened = null
  navigatedTo.length = 0
})

type PageLinksProps = {
  shown?: 'installed' | 'always'
  onCopied?: (copied: boolean) => void
  onOpenFailed?: (reason: string) => void
  onNavigate?: (path: string) => void
}

// An open menu holding the page links and then one item of the host's own.
async function mountMenu(props: PageLinksProps = {}) {
  const { act, createElement, createRoot, menu, TitleBarPageLinks } = await load()
  const root = createRoot(dom.window.document.getElementById('root') as unknown as HTMLElement)
  await act(async () =>
    root.render(
      createElement(
        menu.DropdownMenu,
        { open: true },
        createElement(menu.DropdownMenuTrigger, null, 'Account'),
        createElement(
          menu.DropdownMenuContent,
          null,
          createElement(TitleBarPageLinks, props),
          createElement(menu.DropdownMenuItem, null, 'Settings'),
        ),
      ),
    ),
  )
  unmount = () => act(async () => root.unmount())
  return { act }
}

function menuItems(): HTMLElement[] {
  return [...dom.window.document.querySelectorAll<HTMLElement>('[role="menuitem"]')] as unknown as HTMLElement[]
}

function itemLabels(): string[] {
  return menuItems().map((item) => item.textContent ?? '')
}

function item(label: string): HTMLElement {
  const found = menuItems().find((candidate) => candidate.textContent === label)
  assert.ok(found, `"${label}" is in the menu`)
  return found
}

function separatorCount(): number {
  return dom.window.document.querySelectorAll('[role="separator"]').length
}

test('in a browser tab the menu holds only its own items', async () => {
  await mountMenu()
  assert.deepEqual(itemLabels(), ['Settings'])
  assert.equal(separatorCount(), 0)
})

for (const mode of ['standalone', 'window-controls-overlay']) {
  test(`in the ${mode} display mode both links come first, then a separator`, async () => {
    displayMode = mode
    await mountMenu()
    assert.deepEqual(itemLabels(), ['Copy link to this page', 'Open link from clipboard', 'Settings'])
    assert.equal(separatorCount(), 1)
  })
}

test('shown="always" draws the links in a browser tab too', async () => {
  await mountMenu({ shown: 'always' })
  assert.deepEqual(itemLabels(), ['Copy link to this page', 'Open link from clipboard', 'Settings'])
})

test('the links follow the display mode while the menu is open', async () => {
  const { act } = await mountMenu()
  assert.deepEqual(itemLabels(), ['Settings'])
  await act(async () => setDisplayMode('standalone'))
  assert.deepEqual(itemLabels(), ['Copy link to this page', 'Open link from clipboard', 'Settings'])
  await act(async () => setDisplayMode('browser'))
  assert.deepEqual(itemLabels(), ['Settings'])
})

// Resolves with what onCopied reported, after pressing Copy.
async function pressCopy(): Promise<boolean> {
  displayMode = 'standalone'
  let report: (copied: boolean) => void = () => {}
  const reported = new Promise<boolean>((resolve) => {
    report = resolve
  })
  const { act } = await mountMenu({ onCopied: report })
  await act(async () => item('Copy link to this page').click())
  return reported
}

test('Copy puts the current page address on the clipboard and reports success', async () => {
  clipboard = { writeText: async (text) => void copiedTexts.push(text) }
  assert.equal(await pressCopy(), true)
  assert.deepEqual(copiedTexts, [PAGE])
})

// WebKit honours a clipboard call only while the press is still running, so
// the call has to have started by the time the click handler returns.
test('Copy writes to the clipboard during the press itself', async () => {
  displayMode = 'standalone'
  clipboard = { writeText: async (text) => void copiedTexts.push(text) }
  const { act } = await mountMenu()
  let writtenDuringPress: string[] = []
  await act(async () => {
    item('Copy link to this page').click()
    writtenDuringPress = [...copiedTexts]
  })
  assert.deepEqual(writtenDuringPress, [PAGE])
})

test('Copy reports a failure when the clipboard refuses', async () => {
  clipboard = {
    writeText: async () => {
      throw new Error('denied')
    },
  }
  assert.equal(await pressCopy(), false)
})

test('Copy reports a failure when there is no clipboard at all', async () => {
  clipboard = undefined
  assert.equal(await pressCopy(), false)
})

// Presses Open and resolves with what came of it: the reason onOpenFailed
// reported, 'opened' once a window opened, or 'navigated' once the host was
// asked to go somewhere, with the paths it was given in `navigatedTo`.
const navigatedTo: string[] = []

async function pressOpen(): Promise<string> {
  displayMode = 'standalone'
  let settle: (outcome: string) => void = () => {}
  const settled = new Promise<string>((resolve) => {
    settle = resolve
  })
  const answer = openAnswer
  openAnswer = () => {
    const opened = answer()
    if (opened) {
      settle('opened')
    }
    return opened
  }
  const onNavigate = (path: string) => {
    navigatedTo.push(path)
    settle('navigated')
  }
  const { act } = await mountMenu({ onOpenFailed: settle, onNavigate })
  await act(async () => item('Open link from clipboard').click())
  return settled
}

function clipboardHolding(text: string): Clipboard {
  return { readText: async () => text }
}

test('Open opens the address on the clipboard in a new window, cut from this one', async () => {
  clipboard = clipboardHolding('https://example.com/docs?page=2#top')
  assert.equal(await pressOpen(), 'opened')
  assert.deepEqual(openCalls, [['https://example.com/docs?page=2#top', '_blank']])
  assert.equal(lastOpened?.opener, null)
})

test('Open goes to an address of this app inside the window, through the host', async () => {
  clipboard = clipboardHolding('http://localhost/space/acme/app/tasks/task/T-1?tab=comments#c2')
  assert.equal(await pressOpen(), 'navigated')
  assert.deepEqual(navigatedTo, ['/space/acme/app/tasks/task/T-1?tab=comments#c2'])
  assert.deepEqual(openCalls, [])
})

// Same host on another port is another site: the browser keeps them apart.
test('Open opens the same host on another port in a new window', async () => {
  clipboard = clipboardHolding('http://localhost:8080/space/acme')
  assert.equal(await pressOpen(), 'opened')
  assert.deepEqual(navigatedTo, [])
  assert.deepEqual(openCalls, [['http://localhost:8080/space/acme', '_blank']])
})

// Without onNavigate an address of this app loads as a page. jsdom carries
// out only the same-document part of a load, so the address here differs
// from the current page by its hash alone.
test('without onNavigate, Open loads an address of this app in this window', async () => {
  displayMode = 'standalone'
  clipboard = clipboardHolding(`${PAGE}#usage`)
  const { act } = await mountMenu()
  try {
    await act(async () => item('Open link from clipboard').click())
    // Lets the clipboard read settle; jsdom moves the address at once.
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(dom.window.location.href, `${PAGE}#usage`)
    assert.deepEqual(openCalls, [])
  } finally {
    dom.window.history.replaceState(null, '', PAGE)
  }
})

test('Open ignores whitespace around the copied address', async () => {
  clipboard = clipboardHolding('  http://example.com/a\n')
  assert.equal(await pressOpen(), 'opened')
  assert.deepEqual(openCalls, [['http://example.com/a', '_blank']])
})

for (const text of ['', 'not a link', 'example.com/no-scheme', 'javascript:alert(1)', 'data:text/html,hi']) {
  test(`Open reports not-a-link and opens nothing when the clipboard holds ${JSON.stringify(text)}`, async () => {
    clipboard = clipboardHolding(text)
    assert.equal(await pressOpen(), 'not-a-link')
    assert.deepEqual(openCalls, [])
  })
}

test('Open reports unreadable when the clipboard refuses to be read', async () => {
  clipboard = {
    readText: async () => {
      throw new Error('denied')
    },
  }
  assert.equal(await pressOpen(), 'unreadable')
  assert.deepEqual(openCalls, [])
})

test('Open reports unreadable when there is no clipboard at all', async () => {
  clipboard = undefined
  assert.equal(await pressOpen(), 'unreadable')
})

test('Open reports blocked when the browser refuses the new window', async () => {
  clipboard = clipboardHolding('https://example.com/')
  openAnswer = () => null
  assert.equal(await pressOpen(), 'blocked')
  assert.equal(openCalls.length, 1)
})

test('Open reads the clipboard during the press itself', async () => {
  displayMode = 'standalone'
  let reads = 0
  clipboard = {
    readText: async () => {
      reads += 1
      return 'https://example.com/'
    },
  }
  const { act } = await mountMenu()
  let readsDuringPress = 0
  await act(async () => {
    item('Open link from clipboard').click()
    readsDuringPress = reads
  })
  assert.equal(readsDuringPress, 1)
})

test('the server render draws nothing, whatever the window would say', async () => {
  displayMode = 'standalone'
  const { createElement, renderToStaticMarkup, TitleBarPageLinks } = await load()
  assert.equal(renderToStaticMarkup(createElement(TitleBarPageLinks)), '')
})
