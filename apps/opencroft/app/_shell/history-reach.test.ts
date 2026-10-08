// The title bar's Back and Forward are disabled only where the Navigation API
// says there is nowhere to go, and follow it as the reader moves. Without the
// API nothing is known and both stay enabled. Until the page hydrates neither
// can act, so the served markup has both disabled.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import type { Root } from 'react-dom/client'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before — react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot, hydrateRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { useHistoryReach } = await import('./history-reach')

after(() => dom.cleanup())

type Reach = { canGoBack: boolean; canGoForward: boolean }

// The part of the Navigation API the hook reads: the two flags and the event
// fired when the current entry changes.
class FakeNavigation extends EventTarget {
  constructor(
    public canGoBack: boolean,
    public canGoForward: boolean,
  ) {
    super()
  }
}

const target = window as unknown as { navigation?: unknown }

function withNavigation(navigation: FakeNavigation | undefined) {
  if (navigation) {
    target.navigation = navigation
  } else {
    delete target.navigation
  }
  return () => {
    delete target.navigation
  }
}

async function mount(): Promise<{ seen: Reach; unmount: () => void }> {
  const seen: Reach = { canGoBack: false, canGoForward: false }
  function Harness() {
    Object.assign(seen, useHistoryReach())
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => root.render(createElement(Harness)))
  return { seen, unmount: () => act(() => root.unmount()) }
}

test('without the Navigation API both directions read as available', async () => {
  const restore = withNavigation(undefined)
  const { seen, unmount } = await mount()
  try {
    assert.deepEqual(seen, { canGoBack: true, canGoForward: true })
  } finally {
    unmount()
    restore()
  }
})

test('nothing behind the current entry reads as no way back, with forward unaffected', async () => {
  const restore = withNavigation(new FakeNavigation(false, true))
  const { seen, unmount } = await mount()
  try {
    assert.deepEqual(seen, { canGoBack: false, canGoForward: true })
  } finally {
    unmount()
    restore()
  }
})

test('a change of the current entry updates both directions', async () => {
  const navigation = new FakeNavigation(false, false)
  const restore = withNavigation(navigation)
  const { seen, unmount } = await mount()
  try {
    assert.deepEqual(seen, { canGoBack: false, canGoForward: false }, 'a fresh window')

    navigation.canGoBack = true
    await act(async () => navigation.dispatchEvent(new Event('currententrychange')))
    assert.deepEqual(seen, { canGoBack: true, canGoForward: false }, 'after a move forward')

    navigation.canGoBack = false
    navigation.canGoForward = true
    await act(async () => navigation.dispatchEvent(new Event('currententrychange')))
    assert.deepEqual(seen, { canGoBack: false, canGoForward: true }, 'after going back')
  } finally {
    unmount()
    restore()
  }
})

// Draws the two flags as the title bar does, as the `disabled` of a button.
function Buttons() {
  const { canGoBack, canGoForward } = useHistoryReach()
  return createElement(
    'div',
    null,
    createElement('button', { id: 'back', disabled: !canGoBack }),
    createElement('button', { id: 'forward', disabled: !canGoForward }),
  )
}

function disabledIn(container: Element): { back: boolean; forward: boolean } {
  const disabled = (id: string) => {
    const button = container.querySelector<HTMLButtonElement>(`#${id}`)
    assert.ok(button, `the ${id} button is drawn`)
    return button.disabled
  }
  return { back: disabled('back'), forward: disabled('forward') }
}

test('the server render reads both directions as unavailable whatever the window says', () => {
  const restore = withNavigation(new FakeNavigation(true, true))
  try {
    const seen: Reach = { canGoBack: true, canGoForward: true }
    function Harness() {
      Object.assign(seen, useHistoryReach())
      return null
    }
    renderToStaticMarkup(createElement(Harness))
    assert.deepEqual(seen, { canGoBack: false, canGoForward: false })
  } finally {
    restore()
  }
})

for (const [label, navigation, expected] of [
  ['the Navigation API', new FakeNavigation(true, false), { back: false, forward: true }],
  ['no Navigation API', undefined, { back: false, forward: false }],
] as const) {
  test(`a hydrated page takes the window's reach, with ${label}`, async () => {
    const restore = withNavigation(navigation)
    const errors: unknown[] = []
    let root: Root | undefined
    try {
      dom.container.innerHTML = renderToStaticMarkup(createElement(Buttons))
      assert.deepEqual(disabledIn(dom.container), { back: true, forward: true }, 'as served')

      await act(async () => {
        root = hydrateRoot(dom.container, createElement(Buttons), { onRecoverableError: (e) => errors.push(e) })
      })
      assert.deepEqual(disabledIn(dom.container), expected, 'once hydrated')
      assert.deepEqual(errors, [], 'hydration matched the served markup')
    } finally {
      act(() => root?.unmount())
      dom.container.innerHTML = ''
      restore()
    }
  })
}
