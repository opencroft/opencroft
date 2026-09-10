// Which destination each half of an installed-app row leads to.
//
// The instance settings and the App itself are two real routes taking the same
// two params, so which half of the row carries which is invisible to a
// compiler: `to` is valid either way round and the params typecheck against
// both. Rendering the row and reading the hrefs back is what tells them apart,
// and the direction is the whole of what this surface was asked for -- the row
// opens the settings, the App sits behind the one button beside it.
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
for (const name of ['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  globals[name] = (win[name] as (...args: unknown[]) => unknown).bind(win)
}

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
    createRoute({ getParentRoute: () => rootRoute, path: '/space/$slug/app/$instanceId' }),
    createRoute({ getParentRoute: () => rootRoute, path: '/space/$slug/settings/app/$instanceId' }),
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
      `/space/${SPACE_SLUG}/settings/app/${INSTANCE.id}`,
      'clicking the row opens the instance settings',
    )

    const openLink = dom.container.querySelector('a[aria-label="Open"]')
    assert.ok(openLink, 'the row carries one button for the App itself')
    assert.equal(
      openLink.getAttribute('href'),
      `/space/${SPACE_SLUG}/app/${INSTANCE.id}`,
      'the button opens the App itself',
    )
    assert.match(
      openLink.querySelector('svg')?.getAttribute('class') ?? '',
      /lucide-external-link/,
      'the button carries the external-link icon',
    )
  } finally {
    await unmount()
  }
})
