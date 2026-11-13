// Moving around a sections page (Settings, Administration) goes through
// history the way the screen stack reads it. Where the menu and a section are
// apart (a phone), opening a section or going back to the menu is an entry of
// its own, so Back returns to the menu; where they sit side by side, choosing
// another section replaces the entry, so Back leaves the page. A tab changes
// in place, replacing the entry.
//
// The router below stands in for the generated one: the same route ids on the
// way down to /settings and /administration and the same two search params,
// none of the real components. The hook reads its search by route id, so the
// ids are what has to match; the components are what this test leaves out.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// The router reaches for these by bare name once it believes it is on a
// client; jsdom has them on its window and not on the global object.
const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>
globals.self = globalThis.window
globals.history = win.history
for (const name of [
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'getComputedStyle',
  'addEventListener',
  'removeEventListener',
  'scrollTo',
]) {
  globals[name] = (win[name] as (...args: unknown[]) => unknown).bind(win)
}

// The router core's `isServer` is a package export condition, a constant
// `true` under Node, unless NODE_ENV is `test`. Set before the router loads.
process.env.NODE_ENV = 'test'

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } = await import(
  '@tanstack/react-router'
)
const { useSettingsLocation, validateSectionSearch } = await import('@/app/_authed/(settings)/_lib/settings-location')
type SectionsPagePath = import('@/app/_authed/(settings)/_lib/settings-location').SectionsPagePath

after(() => dom.cleanup())

type SettingsLocation = ReturnType<typeof useSettingsLocation>

// Whether the window is wide enough for the menu and a section to sit side
// by side; jsdom has no media queries of its own.
function setSideBySide(sideBySide: boolean) {
  win.matchMedia = (media: string) => ({ matches: sideBySide, media }) as MediaQueryList
}

async function mountSettings(page: SectionsPagePath) {
  let current: SettingsLocation | undefined
  function Probe() {
    current = useSettingsLocation(page)
    return null
  }
  function OtherPage() {
    return null
  }

  const rootRoute = createRootRoute()
  const authed = createRoute({ getParentRoute: () => rootRoute, id: '_authed' })
  const group = createRoute({ getParentRoute: () => authed, id: '(settings)' })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/' }),
    authed.addChildren([
      group.addChildren(
        (['/settings', '/administration'] as const).map((path) =>
          createRoute({
            getParentRoute: () => group,
            path: path.slice(1),
            validateSearch: validateSectionSearch,
            component: path === page ? Probe : OtherPage,
          }),
        ),
      ),
    ]),
  ])
  const history = createMemoryHistory({ initialEntries: ['/'] })
  const router = createRouter({ routeTree, history })
  await router.load()

  const root = createRoot(dom.container)
  await act(async () => {
    root.render(<RouterProvider router={router} />)
  })

  // Every step waits for the router to settle and the page to re-render, so a
  // read after it is of the location the step produced.
  async function step(move: () => unknown) {
    await act(async () => {
      await move()
    })
    await act(async () => {
      await router.latestLoadPromise
    })
  }

  return {
    router,
    step,
    location: () => {
      assert.ok(current, 'the settings page is rendered')
      return current
    },
    href: () => history.location.href,
    entries: () => history.length,
    unmount: async () => {
      await act(async () => root.unmount())
    },
  }
}

test('apart, a section is an entry over the menu and its tabs change in place', async () => {
  setSideBySide(false)
  const view = await mountSettings('/administration')
  try {
    await view.step(() => view.router.navigate({ to: '/administration' }))
    await view.step(() => view.location().openSection('agents'))
    await view.step(() => view.location().openTab('audit'))

    assert.equal(view.href(), '/administration?section=agents&tab=audit')
    assert.equal(view.entries(), 3, 'the section added an entry and the tab did not')

    await view.step(() => view.router.history.back())
    assert.equal(view.href(), '/administration', 'Back returns to the menu')
    await view.step(() => view.router.history.back())
    assert.equal(view.href(), '/', 'Back leaves the page for the page it was opened from')

    await view.step(() => view.router.history.forward())
    await view.step(() => view.router.history.forward())
    assert.deepEqual(
      { section: view.location().section, tab: view.location().tab },
      { section: 'agents', tab: 'audit' },
      'the page reads the section and tab Forward arrived at',
    )
  } finally {
    await view.unmount()
  }
})

test('side by side, choosing sections replaces the entry so Back leaves the page', async () => {
  setSideBySide(true)
  const view = await mountSettings('/administration')
  try {
    await view.step(() => view.router.navigate({ to: '/administration' }))
    await view.step(() => view.location().openSection('agents'))
    await view.step(() => view.location().openTab('audit'))
    await view.step(() => view.location().openSection('backup'))

    assert.equal(view.href(), '/administration?section=backup', 'the tab does not carry over to another section')
    assert.equal(view.entries(), 2, 'the page is one entry however many sections were chosen')

    await view.step(() => view.router.history.back())
    assert.equal(view.href(), '/')
  } finally {
    await view.unmount()
  }
})

test('apart, going back to the menu is an entry of its own', async () => {
  setSideBySide(false)
  const view = await mountSettings('/settings')
  try {
    await view.step(() => view.router.navigate({ to: '/settings' }))
    await view.step(() => view.location().openSection('account'))
    await view.step(() => view.location().openSection(''))

    assert.equal(view.href(), '/settings')
    assert.equal(view.location().section, undefined, 'no section is open')
    await view.step(() => view.router.history.back())
    assert.equal(view.href(), '/settings?section=account', 'Back reopens the section the menu was left from')
  } finally {
    await view.unmount()
  }
})

test('choosing the section or tab already open adds no entry', async () => {
  setSideBySide(false)
  const view = await mountSettings('/administration')
  try {
    await view.step(() => view.router.navigate({ to: '/administration' }))
    await view.step(() => view.location().openSection('agents'))
    await view.step(() => view.location().openTab('audit'))
    const before = view.entries()

    await view.step(() => view.location().openTab('audit'))
    await view.step(() => view.location().openSection('agents'))
    assert.equal(view.href(), '/administration?section=agents&tab=audit', 'the open section keeps its tab')
    assert.equal(view.entries(), before)
  } finally {
    await view.unmount()
  }
})
