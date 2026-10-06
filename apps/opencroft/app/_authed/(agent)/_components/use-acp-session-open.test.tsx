// How a chat tab answers an open that failed: a refusal only the reader can
// remove is attempted once and shown once, anything else is retried with a
// growing wait until a limit, and a retry or a different conversation opens
// again. And how it answers a stream that ended: it rejoins without starting
// the session, stays offline when nothing is held, and starts it again only for
// a send -- or rejoins when the session is back by another hand.
//
// The real hook is mounted against a real DOM with an injected open transport
// -- the seam a host uses -- and the clock is mocked, so every attempt the hook
// makes is counted and timed rather than inferred from a timer's arguments.
//
// WHAT THIS DOES NOT COVER: that the server functions answer a refusal as data
// in production, or that the notice is laid out where a reader sees it. The
// first is the transport's `openedOrThrow` over `refusalAsData`, tested beside
// them; the second only a browser shows.
import assert from 'node:assert/strict'
import test, { after, afterEach, beforeEach, mock } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()

// A session that opens starts streaming, and jsdom has no EventSource. Each one
// is kept so a test can end it the way the server does; nothing else is sent.
class SilentEventSource {
  static readonly CLOSED = 2
  static readonly opened: SilentEventSource[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    SilentEventSource.opened.push(this)
  }
  close(): void {
    this.readyState = SilentEventSource.CLOSED
  }
}
Object.assign(globalThis, { EventSource: SilentEventSource })
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })

// After the DOM exists, never before -- react-dom binds to the globals it finds.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { OPEN_GAVE_UP_MESSAGE, useAcpSession } = await import('./use-acp-session')
const { SessionOpenNotice } = await import('./session-open-notice')
const { SessionOpenRefusedError } = await import('@/app/_authed/(agent)/_shared/session-open-refusal')
const { MAX_FAILURES } = await import('@/app/_authed/(agent)/_lib/use-reconnect')
const { receiveSessionActivity } = await import('@/app/_authed/(agent)/_lib/use-session-activity')
const { SESSION_GONE_KIND } = await import('@/app/_authed/(agent)/_lib/acp-stream')

type Hook = ReturnType<typeof useAcpSession>
type Source = Parameters<typeof useAcpSession>[0]
type Send = NonNullable<Parameters<typeof useAcpSession>[2]>
type Open = NonNullable<Parameters<typeof useAcpSession>[3]>

after(() => dom.cleanup())

const REFUSAL = 'Codex needs an API key: set one on the agent profile (it is sent to the endpoint as a Bearer token).'
const OPENED: Awaited<ReturnType<Open>> = {
  sessionId: 'session-1',
  canFork: false,
  canSteer: false,
  canAttachImages: false,
  adapterId: 'codex',
  created: true,
  contextUsage: null,
}

let errors: { mock: { calls: { arguments: unknown[] }[] } }
// Every failed open is logged under this line; counting it is counting the
// failures the reader's console shows.
const failuresLogged = () =>
  errors.mock.calls.filter((call) => call.arguments[0] === 'opening the session failed').length

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  errors = mock.method(console, 'error', () => {})
})

afterEach(() => {
  mock.timers.reset()
  mock.restoreAll()
})

// Opens, recorded with the mocked clock's time, answered by `answer`.
function recordingOpen(answer: (call: number, wake: boolean) => Promise<typeof OPENED | null>) {
  const calls: { source: Source; wake: boolean; at: number }[] = []
  const open: Open = (source, { wake }) => {
    calls.push({ source, wake, at: Date.now() })
    return answer(calls.length, wake)
  }
  return { calls, open }
}

async function mount(open: Open, source: Source, send?: Send) {
  let current: Hook | undefined
  function Probe({ source }: { source: Source }) {
    current = useAcpSession(source, 'Agent', send, open)
    // The notice as the thread renders it, so "shown once" is read off the DOM.
    return createElement(SessionOpenNotice, { message: current.openError, onRetry: current.retryOpen })
  }
  const root = createRoot(dom.container)
  const render = (next: Source) =>
    act(async () => {
      root.render(createElement(Probe, { source: next }))
    })
  await render(source)
  const hook = () => {
    assert.ok(current)
    return current
  }
  return { hook, render, unmount: () => act(async () => root.unmount()) }
}

// Moves the mocked clock on in small steps, letting the hook's promises and
// effects run between them, as the browser would.
async function elapse(ms: number, step = 50): Promise<void> {
  for (let passed = 0; passed < ms; passed += step) {
    await act(async () => {
      mock.timers.tick(step)
    })
  }
}

const notices = () => dom.container.querySelectorAll('[role="alert"]')
const SOURCE: Source = { agentNodeId: 'agent-1', tabKey: 'thread-key-1' }

test('a refusal is attempted once, shown once, and not left loading', async () => {
  const { calls, open } = recordingOpen(() => Promise.reject(new SessionOpenRefusedError(REFUSAL)))
  const { hook, unmount } = await mount(open, SOURCE)
  // Long past the whole backoff run a retried failure would make.
  await elapse(5 * 60_000, 1000)
  assert.equal(calls.length, 1, 'one open, no retry')
  assert.equal(failuresLogged(), 1, 'logged once')
  assert.equal(hook().openError, REFUSAL)
  assert.equal(hook().session.loading, false)
  assert.equal(notices().length, 1)
  assert.equal(notices()[0]?.textContent?.includes(REFUSAL), true)
  await unmount()
})

test('a failure worth retrying backs off with growing waits, then stops at the limit and says so', async () => {
  // The top of every jitter range, so each wait is exactly its step.
  mock.method(Math, 'random', () => 1)
  const { calls, open } = recordingOpen(() => Promise.reject(new Error('fetch failed')))
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(4 * 60_000)
  const waits = calls.slice(1).map((call, i) => call.at - (calls[i]?.at ?? 0))
  // The first retry is immediate; the step is 50 ms, so that is what it reads.
  assert.deepEqual(waits, [50, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000])
  assert.equal(calls.length, MAX_FAILURES + 1, 'the first open, then one per allowed failure')
  // Nothing flashed per attempt: the notice appears only once it stopped.
  assert.equal(hook().openError, OPEN_GAVE_UP_MESSAGE)
  assert.equal(notices().length, 1)
  await elapse(10 * 60_000, 1000)
  assert.equal(calls.length, MAX_FAILURES + 1, 'and it stays stopped')
  await unmount()
})

test('while it is still retrying, nothing is shown', async () => {
  const { calls, open } = recordingOpen(() => Promise.reject(new Error('fetch failed')))
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(5000)
  assert.ok(calls.length > 1, 'it is retrying')
  assert.equal(hook().openError, undefined)
  assert.equal(notices().length, 0)
  await unmount()
})

test('pressing Try again after a refusal opens again, and a success clears the notice', async () => {
  const { calls, open } = recordingOpen((call) =>
    call === 1 ? Promise.reject(new SessionOpenRefusedError(REFUSAL)) : Promise.resolve(OPENED),
  )
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(1000)
  assert.equal(notices().length, 1)
  await act(async () => {
    notices()[0]?.querySelector('button')?.click()
  })
  await elapse(100)
  assert.equal(calls.length, 2)
  assert.equal(hook().openError, undefined)
  assert.equal(notices().length, 0)
  await unmount()
})

test('a tab that gave up opens again when the reader retries', async () => {
  let failing = true
  const { calls, open } = recordingOpen(() =>
    failing ? Promise.reject(new Error('fetch failed')) : Promise.resolve(OPENED),
  )
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(4 * 60_000, 500)
  assert.equal(hook().openError, OPEN_GAVE_UP_MESSAGE)
  const before = calls.length
  failing = false
  await act(async () => {
    hook().retryOpen()
  })
  await elapse(100)
  assert.equal(calls.length, before + 1)
  assert.equal(hook().openError, undefined)
  await unmount()
})

test('a different conversation is opened afresh, refusal or not', async () => {
  const { calls, open } = recordingOpen(() => Promise.reject(new SessionOpenRefusedError(REFUSAL)))
  const { render, unmount } = await mount(open, SOURCE)
  await elapse(1000)
  assert.equal(calls.length, 1)
  const other: Source = { agentNodeId: 'agent-2', tabKey: 'thread-key-2' }
  await render(other)
  await elapse(1000)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1]?.source, other)
  await unmount()
})

// ── a stream that ended ────────────────────────────────────────────────────

function activityWithAlive(alive: string[]) {
  receiveSessionActivity({ pending: [], active: [], background: [], queued: [], compacting: [], alive, usage: {} })
}

// The server ends a stream this way when the session it reads stops being held.
async function endStream(): Promise<void> {
  const stream = SilentEventSource.opened.at(-1)
  assert.ok(stream, 'a stream was opened')
  await act(async () => {
    stream.onmessage?.({ data: JSON.stringify({ kind: SESSION_GONE_KIND }) })
  })
}

// Opened once by the reader, then the stream ends and the rejoin finds nothing.
async function mountOffline(send?: Send) {
  let held = true
  const recorded = recordingOpen((_call, wake) => Promise.resolve(wake || held ? OPENED : null))
  const mounted = await mount(recorded.open, SOURCE, send)
  await elapse(200)
  held = false
  await endStream()
  await elapse(200)
  return { ...recorded, ...mounted, hold: () => (held = true) }
}

afterEach(() => activityWithAlive([]))

test('a stream that ends is rejoined without starting the session, and nothing held leaves the tab offline', async () => {
  const { calls, hook, unmount } = await mountOffline()
  assert.deepEqual(
    calls.map((call) => call.wake),
    [true, false],
    'the reader opened it; the rejoin did not start it',
  )
  await elapse(10 * 60_000, 1000)
  assert.equal(calls.length, 2, 'an offline tab asks nothing more on its own')
  assert.equal(hook().session.loading, false)
  assert.equal(hook().openError, undefined, 'offline is not a failure')
  await unmount()
})

test('a session replaced under the same id is streamed again on the rejoin', async () => {
  const { calls, open } = recordingOpen(() => Promise.resolve(OPENED))
  const { unmount } = await mount(open, SOURCE)
  await elapse(200)
  const streams = SilentEventSource.opened.length
  await endStream()
  await elapse(200)
  assert.deepEqual(
    calls.map((call) => call.wake),
    [true, false],
  )
  assert.equal(SilentEventSource.opened.length, streams + 1, 'a new stream under the id the rejoin answered')
  await unmount()
})

test('a send from an offline tab starts the session and delivers the message', async () => {
  const sent: string[] = []
  const send: Send = async ({ text }) => {
    sent.push(text)
  }
  const { calls, hook, unmount } = await mountOffline(send)
  await act(async () => {
    hook().session.send('hello')
  })
  await elapse(200)
  assert.deepEqual(
    calls.map((call) => call.wake),
    [true, false, true],
  )
  assert.deepEqual(sent, ['hello'])
  await unmount()
})

test('an offline tab rejoins when the session is back by another hand, still without starting it', async () => {
  const { calls, hold, unmount } = await mountOffline()
  const streams = SilentEventSource.opened.length
  hold()
  await act(async () => activityWithAlive([SOURCE.tabKey]))
  await elapse(200)
  assert.deepEqual(
    calls.map((call) => call.wake),
    [true, false, false],
  )
  assert.equal(SilentEventSource.opened.length, streams + 1, 'streaming again')
  await unmount()
})

test('an activity reading that says alive while nothing is held asks once, not in a loop', async () => {
  const { calls, unmount } = await mountOffline()
  await act(async () => activityWithAlive([SOURCE.tabKey]))
  await elapse(10 * 60_000, 1000)
  assert.deepEqual(
    calls.map((call) => call.wake),
    [true, false, false],
  )
  await unmount()
})
