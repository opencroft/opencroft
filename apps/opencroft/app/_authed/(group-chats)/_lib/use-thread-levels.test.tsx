// The entries the chats page writes under a thread, read back by walking the
// history with Back and Forward.
//
// Browser history, not memory history: the browser history queues a push and
// writes it a microtask later, and a push queued before that write takes its
// place. That queue is what the hooks flush between entries, and memory history
// has no queue to show it. jsdom's `window.history` is the browser underneath,
// shared by every test here, so each test starts from entries of its own and
// reads only what it adds.
//
// The router below stands in for the generated one: the chats page's three
// addresses under a layout route that runs the hooks, and a page outside it.

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

// Whether the page is wide enough for both panels; jsdom has no matchMedia.
let bothPanels = false
win.matchMedia = (query: string) => ({ matches: bothPanels, media: query })

// The router core's `isServer` is a package export condition, a constant
// `true` under Node, unless NODE_ENV is `test`. Set before the router loads.
process.env.NODE_ENV = 'test'

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Outlet, RouterProvider, createBrowserHistory, createRootRoute, createRoute, createRouter } = await import(
  '@tanstack/react-router'
)
const { useOpenThreadWithLevels, useThreadLevelsOnArrival } = await import(
  '@/app/_authed/(group-chats)/_lib/use-thread-levels'
)

after(() => dom.cleanup())

const browser = globalThis.window as unknown as Window

type OpenThread = ReturnType<typeof useOpenThreadWithLevels>

// Puts `paths` on the browser's history as entries of this test's own, the
// last one current, before any router reads it. A state object makes an entry
// one the router would have written itself, minus anything it marks.
function startAt(paths: { path: string; state?: Record<string, unknown> }[]) {
  for (const { path, state } of paths) {
    browser.history.pushState(state ?? null, '', path)
  }
}

async function mountChatsPage() {
  let open: OpenThread | undefined
  function ChatsLayout() {
    useThreadLevelsOnArrival()
    open = useOpenThreadWithLevels()
    return <Outlet />
  }

  const rootRoute = createRootRoute()
  const chats = createRoute({ getParentRoute: () => rootRoute, path: 'group-chats', component: ChatsLayout })
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: 'extensions' }),
    chats.addChildren([
      createRoute({ getParentRoute: () => chats, path: '/' }),
      createRoute({ getParentRoute: () => chats, path: '$groupChatId' }),
      createRoute({
        getParentRoute: () => chats,
        path: '$groupChatId/$threadId',
        validateSearch: (search: Record<string, unknown>) => ({
          at: typeof search.at === 'number' ? search.at : undefined,
        }),
      }),
    ]),
  ])
  const history = createBrowserHistory()
  const router = createRouter({ routeTree, history })
  const lengthAtStart = browser.history.length
  await router.load()

  const root = createRoot(dom.container)
  await act(async () => {
    root.render(<RouterProvider router={router} />)
  })

  // Waits for the router to settle, then for the page to re-render and run
  // the effects that settling set off, twice over: an arrival writes entries,
  // and those entries are navigations of their own.
  async function settle() {
    for (let round = 0; round < 2; round++) {
      await act(async () => {
        await router.latestLoadPromise
      })
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      })
    }
  }
  await settle()

  // One traversal: jsdom moves the history a task later and tells the page
  // with `popstate`.
  async function traverse(move: () => void) {
    const popped = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no popstate after a traversal')), 1000)
      browser.addEventListener(
        'popstate',
        () => {
          clearTimeout(timer)
          resolve()
        },
        { once: true },
      )
    })
    move()
    await popped
    await settle()
  }

  return {
    router,
    settle,
    open: (target: Parameters<OpenThread>[0]) => {
      assert.ok(open, 'the chats page is rendered')
      open(target)
    },
    back: () => traverse(() => router.history.back()),
    forward: () => traverse(() => router.history.forward()),
    href: () => `${browser.location.pathname}${browser.location.search}`,
    added: () => browser.history.length - lengthAtStart,
    unmount: async () => {
      await act(async () => root.unmount())
      history.destroy()
    },
  }
}

test('a thread loaded fresh below md gets the chats list and its chat under it', async () => {
  bothPanels = false
  startAt([{ path: '/extensions' }, { path: '/group-chats/c1/t1' }])
  const page = await mountChatsPage()
  try {
    assert.equal(page.href(), '/group-chats/c1/t1')
    assert.equal(page.added(), 2, 'the chats list over the arrival, then the chat and the thread above it')

    await page.back()
    assert.equal(page.href(), '/group-chats/c1')
    await page.back()
    assert.equal(page.href(), '/group-chats')
    await page.back()
    assert.equal(page.href(), '/extensions', 'nothing else was written under the levels')
  } finally {
    await page.unmount()
  }
})

test('a thread loaded fresh side by side gets only its chat under it', async () => {
  bothPanels = true
  startAt([{ path: '/extensions' }, { path: '/group-chats/c1/t1' }])
  const page = await mountChatsPage()
  try {
    assert.equal(page.href(), '/group-chats/c1/t1')
    assert.equal(page.added(), 1, 'the chat over the arrival, then the thread above it')

    await page.back()
    assert.equal(page.href(), '/group-chats/c1')
    await page.back()
    assert.equal(page.href(), '/extensions', 'the chats list is on screen beside the chat, so it is no entry')
  } finally {
    await page.unmount()
  }
})

test('stepping Back and Forward over written levels rewrites nothing', async () => {
  bothPanels = false
  startAt([{ path: '/extensions' }, { path: '/group-chats/c1/t1' }])
  const page = await mountChatsPage()
  try {
    await page.back()
    await page.back()
    await page.forward()
    await page.forward()
    assert.equal(page.href(), '/group-chats/c1/t1')
    assert.equal(page.added(), 2, 'no entry was added on the way')

    await page.back()
    assert.equal(page.href(), '/group-chats/c1', 'the levels are still under the thread')
  } finally {
    await page.unmount()
  }
})

test('a thread entry without the mark reached by Back on the chats page is left as it is', async () => {
  bothPanels = false
  // A thread entry under the chats list, carrying the router's own state but
  // not the mark the chats page writes, as an entry an older build left does.
  startAt([
    { path: '/extensions' },
    { path: '/group-chats/c1/t1', state: { __TSR_index: 1, key: 'unmarked', __TSR_key: 'unmarked' } },
    { path: '/group-chats', state: { __TSR_index: 2, key: 'above', __TSR_key: 'above' } },
  ])
  const page = await mountChatsPage()
  try {
    await page.back()
    assert.equal(page.href(), '/group-chats/c1/t1')
    assert.equal(page.added(), 0, 'no levels were written under it')

    await page.forward()
    assert.equal(page.href(), '/group-chats', 'the entry above it is still there')
  } finally {
    await page.unmount()
  }
})

test('leaving the page from a thread loaded fresh stays left', async () => {
  bothPanels = false
  startAt([{ path: '/extensions' }, { path: '/group-chats/c1/t1' }])
  const page = await mountChatsPage()
  try {
    await act(async () => {
      await page.router.navigate({ to: '/extensions' })
    })
    await page.settle()
    assert.equal(page.href(), '/extensions')
    assert.equal(page.added(), 3, 'the levels, then the page left for, and no thread written over it')
  } finally {
    await page.unmount()
  }
})

test('a thread opened from Recent below md sits on its chat over the chats list', async () => {
  bothPanels = false
  startAt([{ path: '/group-chats' }])
  const page = await mountChatsPage()
  try {
    assert.equal(page.added(), 0, 'the chats list arrives as it is')
    page.open({ groupChatId: 'c1', threadId: 't1' })
    await page.settle()
    assert.equal(page.href(), '/group-chats/c1/t1')
    assert.equal(page.added(), 2)

    await page.back()
    assert.equal(page.href(), '/group-chats/c1')
    await page.back()
    assert.equal(page.href(), '/group-chats')
  } finally {
    await page.unmount()
  }
})

test('a thread opened from Recent side by side sits on its chat over the thread it was opened from', async () => {
  bothPanels = true
  startAt([{ path: '/extensions' }, { path: '/group-chats/c2/t9' }])
  const page = await mountChatsPage()
  try {
    const before = page.added()
    page.open({ groupChatId: 'c1', threadId: 't1', at: 7 })
    await page.settle()
    assert.equal(page.href(), '/group-chats/c1/t1?at=7', 'the thread opens at the message Recent points to')
    assert.equal(page.added() - before, 2, 'the chat, then the thread')

    await page.back()
    assert.equal(page.href(), '/group-chats/c1')
    await page.back()
    assert.equal(page.href(), '/group-chats/c2/t9')
  } finally {
    await page.unmount()
  }
})
