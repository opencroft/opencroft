// When a chat tab reconnects: at once the first time, backing off in a run,
// never while hidden. The hook is mounted against a real DOM, because the
// hidden case is the document's own visibility and its event.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { reconnectDelay, useReconnect } = await import('./use-reconnect')

after(() => dom.cleanup())

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next
  document.dispatchEvent(new window.Event('visibilitychange'))
}

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms))

async function mount() {
  let current: ReturnType<typeof useReconnect> | undefined
  function Probe() {
    current = useReconnect()
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => {
    root.render(createElement(Probe))
  })
  const hook = () => {
    assert.ok(current)
    return current
  }
  return { hook, unmount: () => act(async () => root.unmount()) }
}

test('the first attempt is immediate, a run backs off, and it is capped', () => {
  assert.equal(reconnectDelay(0), 0)
  assert.equal(reconnectDelay(1), 1000)
  assert.equal(reconnectDelay(2), 2000)
  assert.equal(reconnectDelay(10), 30_000)
})

test('a visible tab reconnects at once, and one lost connection is one attempt', async () => {
  setVisibility('visible')
  const { hook, unmount } = await mount()
  await act(async () => {
    hook().schedule()
    hook().schedule()
    // Past the second's backoff, so a second attempt would have fired by now.
    await tick(1100)
  })
  assert.equal(hook().attempt, 1)
  await unmount()
})

test('a hidden tab waits until it is shown', async () => {
  setVisibility('hidden')
  const { hook, unmount } = await mount()
  await act(async () => {
    hook().schedule()
    await tick()
  })
  assert.equal(hook().attempt, 0, 'nothing while hidden')
  await act(async () => {
    setVisibility('visible')
    await tick()
  })
  assert.equal(hook().attempt, 1, 'shown, it reconnects')
  await unmount()
})

test('a connection that got through starts the backoff over', async () => {
  setVisibility('visible')
  const { hook, unmount } = await mount()
  await act(async () => {
    hook().schedule()
    await tick()
  })
  assert.equal(hook().attempt, 1)
  // Without this the next attempt would wait a second.
  hook().connected()
  await act(async () => {
    hook().schedule()
    await tick()
  })
  assert.equal(hook().attempt, 2)
  await unmount()
})
