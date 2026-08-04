// Two sidebars on one page must not share what they remember, and must not
// both answer the same keystroke.
//
// The persistence key and the shortcut key used to be module constants, which
// encoded an assumption that there would only ever be one sidebar. Mounted
// twice, both wrote the same cookie, so collapsing either overwrote what the
// other remembered — and both listened for the same chord. They are props now,
// defaulting to those same constants so a lone sidebar is unaffected.
//
// This renders against a real DOM because that is the only place the effects
// run: the cookie is written inside a callback and the shortcut is a listener
// on a real window.
import assert from 'node:assert/strict'
import test, { after, beforeEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// The sidebar asks whether the viewport is mobile; the harness has no media
// query implementation, so answer "desktop" for the duration.
;(globalThis.window as unknown as { matchMedia: () => unknown }).matchMedia = () => ({
  matches: false,
  addEventListener: () => {},
  removeEventListener: () => {},
})

// jsdom's document.cookie does not retain writes here, and the writes are the
// whole subject — so record them instead.
const cookieWrites: string[] = []
Object.defineProperty(globalThis.document, 'cookie', {
  configurable: true,
  get: () => cookieWrites.join('; '),
  set: (value: string) => {
    cookieWrites.push(String(value).split(';')[0])
  },
})

// After the DOM exists, never before — react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { SidebarProvider, SidebarStateProvider, useSidebar } = await import('ui/components/ui/sidebar')

after(() => dom.cleanup())

beforeEach(() => {
  cookieWrites.length = 0
})

type Which = 'left' | 'right'

interface Mounted {
  open: Record<Which, boolean>
  toggle: Partial<Record<Which, () => void>>
}

/** An outer sidebar with a nested second one, as a page with both would compose. */
async function mountBoth(rightProps: Record<string, unknown>): Promise<Mounted> {
  const mounted: Mounted = { open: { left: true, right: true }, toggle: {} }

  function Probe({ which }: { which: Which }) {
    const sidebar = useSidebar()
    mounted.open[which] = sidebar.open
    mounted.toggle[which] = sidebar.toggleSidebar
    return null
  }

  const root = createRoot(dom.container)
  after(() => {
    act(() => root.unmount())
  })

  await act(async () => {
    root.render(
      createElement(
        SidebarProvider,
        { storageKey: 'left_sidebar_state' },
        createElement(Probe, { which: 'left' }),
        createElement(SidebarProvider, rightProps, createElement(Probe, { which: 'right' })),
      ),
    )
  })

  return mounted
}

async function pressShortcut(key: string): Promise<void> {
  const { KeyboardEvent: Ctor, dispatchEvent } = globalThis.window
  await act(async () => {
    dispatchEvent.call(globalThis.window, new Ctor('keydown', { key, ctrlKey: true }))
  })
}

test('each sidebar remembers its own state, under its own key', async () => {
  const mounted = await mountBoth({ storageKey: 'right_sidebar_state' })

  await act(async () => mounted.toggle.right?.())
  assert.deepEqual(cookieWrites, ['right_sidebar_state=false'], 'the right sidebar writes only its own key')

  cookieWrites.length = 0
  await act(async () => mounted.toggle.left?.())
  assert.deepEqual(cookieWrites, ['left_sidebar_state=false'], 'the left sidebar writes only its own key')
})

test('collapsing one sidebar leaves the other one open', async () => {
  const mounted = await mountBoth({ storageKey: 'right_sidebar_state' })

  await act(async () => mounted.toggle.right?.())

  assert.equal(mounted.open.right, false)
  assert.equal(mounted.open.left, true, 'collapsing the right sidebar must not collapse the left')
})

test('the shortcut reaches the sidebar that claims it, and only that one', async () => {
  const mounted = await mountBoth({ storageKey: 'right_sidebar_state', keyboardShortcut: null })

  await pressShortcut('b')

  assert.equal(mounted.open.left, false, 'the sidebar holding the shortcut toggles')
  assert.equal(mounted.open.right, true, 'the sidebar that declined the shortcut does not')
})

test('two sidebars can hold different shortcuts without answering each other', async () => {
  const mounted = await mountBoth({ storageKey: 'right_sidebar_state', keyboardShortcut: 'j' })

  await pressShortcut('j')
  assert.equal(mounted.open.right, false, 'the right sidebar answers its own key')
  assert.equal(mounted.open.left, true, 'the left sidebar does not answer a key it did not claim')

  await pressShortcut('b')
  assert.equal(mounted.open.left, false, 'the left sidebar still answers its own key')
})

test('a lone sidebar is unchanged: the shared key and the shared shortcut still apply', async () => {
  // The defaults are the whole reason this change is safe to land — anything
  // mounting one sidebar and passing nothing must behave exactly as before.
  let open = true
  let toggle: (() => void) | undefined

  function Probe() {
    const sidebar = useSidebar()
    open = sidebar.open
    toggle = sidebar.toggleSidebar
    return null
  }

  const root = createRoot(dom.container)
  after(() => {
    act(() => root.unmount())
  })
  await act(async () => {
    root.render(createElement(SidebarProvider, null, createElement(Probe, null)))
  })

  await act(async () => toggle?.())
  assert.deepEqual(cookieWrites, ['sidebar_state=false'], 'still the original cookie key')

  await pressShortcut('b')
  assert.equal(open, true, 'still answers the original shortcut')
})

// The wrapper and the state are separate responsibilities that used to be
// bundled. A page whose sidebar is the layout wants both; a second sidebar
// joining a row that already exists wants only the state, because another
// full-width flex container nested inside the row would change that layout
// rather than join it.
test('a second sidebar joins the existing row without inserting a container', async () => {
  const root = createRoot(dom.container)
  after(() => {
    act(() => root.unmount())
  })

  await act(async () => {
    root.render(
      createElement(
        SidebarProvider,
        { storageKey: 'left_sidebar_state' },
        createElement('div', { 'data-testid': 'left' }),
        createElement(
          SidebarStateProvider,
          { storageKey: 'right_sidebar_state', keyboardShortcut: null },
          createElement('div', { 'data-testid': 'right' }),
        ),
      ),
    )
  })

  const wrappers = dom.container.querySelectorAll('[data-slot="sidebar-wrapper"]')
  assert.equal(wrappers.length, 1, 'only the page row opens a wrapper')

  const left = dom.container.querySelector('[data-testid="left"]')
  const right = dom.container.querySelector('[data-testid="right"]')
  assert.equal(right?.parentElement, wrappers[0], 'the second sidebar sits directly in the row')
  assert.equal(left?.parentElement, right?.parentElement, 'both sidebars are siblings of one another')
})

test('the state provider keeps its own persistence, exactly as the full one does', async () => {
  // Splitting the wrapper off must not have taken any behaviour with it.
  let toggle: (() => void) | undefined

  function Probe() {
    toggle = useSidebar().toggleSidebar
    return null
  }

  const root = createRoot(dom.container)
  after(() => {
    act(() => root.unmount())
  })

  await act(async () => {
    root.render(
      createElement(
        SidebarProvider,
        { storageKey: 'left_sidebar_state' },
        createElement(
          SidebarStateProvider,
          { storageKey: 'right_sidebar_state', keyboardShortcut: null },
          createElement(Probe, null),
        ),
      ),
    )
  })

  await act(async () => toggle?.())
  assert.deepEqual(cookieWrites, ['right_sidebar_state=false'], 'writes its own key, not the row’s')
})
