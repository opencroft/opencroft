// Moving around Settings goes through history: opening Settings, choosing a
// section, choosing a tab and going back to the menu are each one entry, so
// Back and Forward retrace them in order.
//
// The router below stands in for the generated one: the same route ids on the
// way down to /settings and the same two search params, none of the real
// components. The hook reads its search by route id, so the ids are what has
// to match; the components are what this test leaves out.

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
const { useSettingsLocation } = await import('@/app/_authed/(settings)/_lib/settings-location')

after(() => dom.cleanup())

type SettingsLocation = ReturnType<typeof useSettingsLocation>

const nonEmpty = (value: unknown) => (typeof value === 'string' && value ? value : undefined)

async function mountSettings() {
  let current: SettingsLocation | undefined
  function Probe() {
    current = useSettingsLocation()
    return null
  }

  const rootRoute = createRootRoute()
  const authed = createRoute({ getParentRoute: () => rootRoute, id: '_authed' })
  const group = createRoute({ getParentRoute: () => authed, id: '(settings)' })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/' }),
    authed.addChildren([
      group.addChildren([
        createRoute({
          getParentRoute: () => group,
          path: 'settings',
          validateSearch: (search: Record<string, unknown>) => ({
            section: nonEmpty(search.section),
            tab: nonEmpty(search.tab),
          }),
          component: Probe,
        }),
      ]),
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

test('every move inside Settings is an entry that Back and Forward retrace', async () => {
  const view = await mountSettings()
  try {
    await view.step(() => view.router.navigate({ to: '/settings' }))
    await view.step(() => view.location().openSection('agents'))
    await view.step(() => view.location().openTab('audit'))
    await view.step(() => view.location().openSection('backup'))

    const forwardPath = ['/', '/settings', '/settings?section=agents', '/settings?section=agents&tab=audit']
    assert.equal(view.href(), '/settings?section=backup', 'the tab does not carry over to another section')
    assert.equal(view.entries(), forwardPath.length + 1, 'each move added one entry')

    for (const expected of forwardPath.toReversed()) {
      await view.step(() => view.router.history.back())
      assert.equal(view.href(), expected)
    }
    assert.equal(view.href(), '/', 'Back leaves Settings for the page it was opened from')

    await view.step(() => view.router.history.forward())
    await view.step(() => view.router.history.forward())
    assert.equal(view.href(), '/settings?section=agents')
    assert.deepEqual(
      { section: view.location().section, tab: view.location().tab },
      { section: 'agents', tab: undefined },
      'the page reads the section Forward arrived at',
    )
  } finally {
    await view.unmount()
  }
})

test('going back to the menu is an entry of its own', async () => {
  const view = await mountSettings()
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
  const view = await mountSettings()
  try {
    await view.step(() => view.router.navigate({ to: '/settings' }))
    await view.step(() => view.location().openSection('agents'))
    await view.step(() => view.location().openTab('audit'))
    const before = view.entries()

    await view.step(() => view.location().openTab('audit'))
    await view.step(() => view.location().openSection('agents'))
    assert.equal(view.href(), '/settings?section=agents&tab=audit', 'the open section keeps its tab')
    assert.equal(view.entries(), before)
  } finally {
    await view.unmount()
  }
})
