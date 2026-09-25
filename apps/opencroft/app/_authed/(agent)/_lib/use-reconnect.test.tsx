// When a chat tab reconnects: at once the first time, backing off in a run,
// never while hidden, and not past a limit until the reader asks. The hook is mounted against a real DOM, because the
// hidden case is the document's own visibility and its event.
import assert from 'node:assert/strict'
import test, { after, mock } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MAX_FAILURES, reconnectDelay, useReconnect } = await import('./use-reconnect')

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

// The jitter's two ends, passed in rather than drawn: the whole range of every
// step is then stated, not sampled.
const lowest = () => 0
const highest = () => 1

test('the first attempt is immediate, a run backs off within the upper half of each step, and it is capped', () => {
  const failures = [0, 1, 2, 3, 4, 5, 6, 7, 12]
  assert.deepEqual(
    failures.map((n) => reconnectDelay(n, lowest)),
    [0, 500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000],
  )
  assert.deepEqual(
    failures.map((n) => reconnectDelay(n, highest)),
    [0, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000],
  )
})

test('a run stops at the limit and says so, and a retry starts a fresh one at once', async () => {
  setVisibility('visible')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { hook, unmount } = await mount()
    for (let failure = 0; failure < MAX_FAILURES; failure++) {
      await act(async () => {
        hook().schedule()
        mock.timers.tick(30_000)
      })
      assert.equal(hook().attempt, failure + 1)
      assert.equal(hook().exhausted, false)
    }
    await act(async () => {
      hook().schedule()
      mock.timers.tick(10 * 60_000)
    })
    assert.equal(hook().attempt, MAX_FAILURES, 'nothing past the limit')
    assert.equal(hook().exhausted, true)
    // No timer involved: the retry is the reader's, so it does not wait.
    await act(async () => {
      hook().retry()
    })
    assert.equal(hook().attempt, MAX_FAILURES + 1)
    assert.equal(hook().exhausted, false)
    // And the run it starts is a fresh one: its first retry is immediate again.
    await act(async () => {
      hook().schedule()
      mock.timers.tick(0)
    })
    assert.equal(hook().attempt, MAX_FAILURES + 2)
    await unmount()
  } finally {
    mock.timers.reset()
  }
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
