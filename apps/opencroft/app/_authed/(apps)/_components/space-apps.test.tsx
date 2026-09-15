// Which destination each half of an installed-app row leads to.
//
// The instance settings and the App itself are two real routes taking the same
// two params, so which half of the row carries which is invisible to a
// compiler: `to` is valid either way round and the params typecheck against
// both. Rendering the row and reading the hrefs back is what tells them apart,
// and the direction is the whole of what this surface was asked for -- the row
// opens the settings, the App sits behind the one button beside it, and that
// button opens a new tab rather than routing in place.
//
// The router below stands in for the generated one: the same paths, none of
// their components. It is here because `Link` needs a route tree to
// interpolate params against, which makes an href assertion an assertion about
// the interpolation as well as about the path.

import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { AppMeta, SpaceAppInstance } from '@/app/_authed/(apps)/_server/types'
import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// All four exist on the jsdom window already and are merely not copied onto the
// global object, so bridging them describes the real environment rather than
// standing in for a result. `self` IS `window` in a browser and the router
// assigns itself onto it as soon as a document exists; the tab panel schedules
// through requestAnimationFrame and measures through getComputedStyle, and
// without either it unmounts into an error boundary -- which reads in an
// assertion as a row that is missing rather than one that threw.
const win = globalThis.window as unknown as Record<string, unknown>
const globals = globalThis as unknown as Record<string, unknown>
globals.self = globalThis.window
// Copied rather than bound. `MouseEvent` has to be the window's own -- jsdom
// rejects an event built from Node's global constructor as "not of type Event"
// -- and `history` is what the router reaches for once it believes it is on a
// client, to set up scroll restoration.
for (const name of ['MouseEvent', 'history']) {
  globals[name] = win[name]
}
// Bound, because each is a window method reached for by bare name. The last
// three are the closed set the router's scroll restoration touches once it
// believes it is on a client; `sessionStorage` is deliberately absent, since
// reading it here throws (the harness gives the document no url, so its origin
// is opaque) and the router already guards that access with a try/catch.
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

// `Link` picks its click handler from a branch selected by the router core's
// `isServer` flag, and that flag comes from a PACKAGE EXPORT CONDITION rather
// than from anything at runtime: under Node it is a constant `true`, so a link
// rendered here would carry an href and no behaviour at all. That matters most
// for the assertion that the button does NOT navigate, which passes just as
// happily against a link that was never wired to navigate in the first place --
// it was the control below, on a link that must navigate, that caught it.
// The server build defers to the router when `NODE_ENV` is `test`, and the
// router then asks whether a `document` exists, which by this line it does.
// Set before the router is imported: the constant is read when its module loads.
process.env.NODE_ENV = 'test'

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { RouterProvider, createMemoryHistory, createRootRoute, createRoute, createRouter } = await import(
  '@tanstack/react-router'
)
const { SpaceApps } = await import('@/app/_authed/(apps)/_components/space-apps')

after(() => dom.cleanup())

const SPACE_SLUG = 'a-space'

const INSTANCE: SpaceAppInstance = {
  id: 'an-instance-id',
  extensionId: 'local/example',
  appSlug: 'example',
  name: 'An instance',
  slug: 'an-instance',
  params: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const APP: AppMeta = { extensionId: INSTANCE.extensionId, slug: INSTANCE.appSlug, title: 'Example' }

function buildRouter() {
  const rootRoute = createRootRoute()
  const routeTree = rootRoute.addChildren([
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/',
      component: () => (
        <SpaceApps spaceSlug={SPACE_SLUG} apps={[APP]} instances={[INSTANCE]} tab='installed' onTabChange={() => {}} />
      ),
    }),
    createRoute({ getParentRoute: () => rootRoute, path: '/space/$slug/app/$app' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/space/$slug/settings/app/$app' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/space/$slug/settings/app/add' }),
  ])
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/'] }) })
}

async function mountInstalledTab() {
  const router = buildRouter()
  // Matching is asynchronous: a provider handed a router that has not resolved
  // its location yet renders no matches at all, which reads in an assertion as
  // a row that is missing rather than a row that has not arrived.
  await router.load()
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(<RouterProvider router={router} />)
  })
  return {
    router,
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
    },
  }
}

test('the row body opens the instance settings and the button beside it opens the App', async () => {
  const { unmount } = await mountInstalledTab()

  try {
    const rowLink = [...dom.container.querySelectorAll('a')].find((anchor) =>
      anchor.textContent?.includes(INSTANCE.name),
    )
    assert.ok(rowLink, 'the row rendered')
    assert.equal(
      rowLink.getAttribute('href'),
      `/space/${SPACE_SLUG}/settings/app/${INSTANCE.slug}`,
      'clicking the row opens the instance settings, addressed by slug',
    )

    const openLink = dom.container.querySelector('a[aria-label="Open in a new tab"]')
    assert.ok(openLink, 'the row carries one button for the App itself')
    assert.equal(openLink.getAttribute('title'), 'Open', 'while the visible tooltip stays the short form')
    assert.equal(
      openLink.getAttribute('href'),
      `/space/${SPACE_SLUG}/app/${INSTANCE.slug}`,
      'the button opens the App itself, addressed by slug',
    )
    assert.match(
      openLink.querySelector('svg')?.getAttribute('class') ?? '',
      /lucide-external-link/,
      'the button carries the external-link icon',
    )
    assert.equal(openLink.getAttribute('target'), '_blank', 'the App opens in a new tab')
    assert.equal(
      openLink.getAttribute('rel'),
      'noopener noreferrer',
      'and the new tab gets neither an opener handle nor a referrer',
    )
  } finally {
    await unmount()
  }
})

// The attributes above are inert on their own: a router that intercepted the
// click anyway would render exactly the same `target` and route in place, and
// every assertion in the first test would still pass. What makes the new tab
// real is the click NOT being taken, so that is what this asserts -- with the
// row body, which has no target, as the control that the router in this setup
// does intercept when it should.
test('the button hands its click to the browser, and a link without a target does not', async () => {
  const { router, unmount } = await mountInstalledTab()

  // A left click, and then a settled router: navigation is asynchronous, so
  // reading the location straight after the dispatch would read it before the
  // navigation this is testing for had a chance to happen -- which passes for
  // the button whether or not the target does anything.
  async function clickOn(element: Element) {
    await act(async () => {
      element.dispatchEvent(
        new (win.MouseEvent as typeof MouseEvent)('click', { bubbles: true, cancelable: true, button: 0 }),
      )
    })
    await act(async () => {
      await router.latestLoadPromise
    })
  }

  try {
    const openLink = dom.container.querySelector('a[aria-label="Open in a new tab"]')
    assert.ok(openLink, 'the button rendered')

    await clickOn(openLink)
    assert.equal(router.state.location.pathname, '/', 'the button did not navigate the current tab')

    const rowLink = [...dom.container.querySelectorAll('a')].find((anchor) =>
      anchor.textContent?.includes(INSTANCE.name),
    )
    assert.ok(rowLink, 'the row rendered')

    await clickOn(rowLink)
    assert.equal(
      router.state.location.pathname,
      `/space/${SPACE_SLUG}/settings/app/${INSTANCE.slug}`,
      'while a link with no target is still routed in place',
    )
  } finally {
    await unmount()
  }
})
