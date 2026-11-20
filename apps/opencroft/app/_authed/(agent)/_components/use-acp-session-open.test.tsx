// How a chat tab answers an open that failed: a refusal only the reader can
// remove is attempted once and shown once, anything else is retried with a
// growing wait until a limit, and a retry or a different conversation opens
// again. And how it answers a stream that ended: it rejoins without starting
// the session, stays offline when nothing is held, and starts it again only for
// a send -- or rejoins when the session is back by another hand. And which
// Presence an opened tab shows, which depends on what the open said about
// steering.
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
const { useAcpSession } = await import('./use-acp-session')
const { ChatNotice } = await import('agent-chat/components/chat-turn')
const { OPEN_GAVE_UP_TITLE, SessionOpenRefusedError } = await import(
  '@/app/_authed/(agent)/_shared/session-open-refusal'
)
const { MAX_FAILURES } = await import('@/app/_authed/(agent)/_lib/use-reconnect')
const { receiveSessionActivity } = await import('@/app/_authed/(agent)/_lib/use-session-activity')
const { HISTORY_END_KIND, SESSION_GONE_KIND } = await import('@/app/_authed/(agent)/_lib/acp-stream')

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
    // The notice as the conversation renders it, so "shown once" is read off
    // the DOM.
    const notice = current.session.notice
    return notice ? createElement(ChatNotice, { item: { kind: 'notice', severity: 'error', ...notice } }) : null
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
  assert.equal(hook().openError, OPEN_GAVE_UP_TITLE)
  assert.equal(notices().length, 1)
  // The open's own failure is the engine's (here the request to it), not the
  // model server's: told as given up, with the last failure's text kept.
  assert.equal(hook().session.notice?.title, OPEN_GAVE_UP_TITLE)
  assert.equal(hook().session.notice?.details, 'fetch failed')
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
  assert.equal(hook().openError, OPEN_GAVE_UP_TITLE)
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

test('a harness that died at start is shown at once in plain words, Details holding what it said', async () => {
  const said = 'Agent failed to start (exit code 127): sh: 1: exec: npx: not found'
  const { calls, open } = recordingOpen(() => Promise.reject(new SessionOpenRefusedError(said, 'harness')))
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(5 * 60_000, 1000)
  assert.equal(calls.length, 1, 'not retried')
  assert.equal(hook().session.notice?.title, "The agent couldn't start: Node.js isn't installed where it runs.")
  assert.equal(hook().session.notice?.details, said)
  assert.equal(hook().session.notice?.action?.label, 'Try again')
  assert.equal(notices().length, 1)
  await unmount()
})

test('a session start shows as starting until it answers', async () => {
  let answer: (value: typeof OPENED) => void = () => {}
  const { open } = recordingOpen(() => new Promise((resolve) => (answer = resolve)))
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(1000)
  assert.equal(hook().session.starting, true)
  await act(async () => answer(OPENED))
  await elapse(100)
  assert.equal(hook().session.starting, false)
  await unmount()
})

test('a start whose history ends before the first message is back still reads as working, not as nothing', async () => {
  // The message a thread is started with is held until the session opens, then
  // sent; the stream opens at the same moment, and its history can end before
  // the send's own event arrives in it.
  const { open } = recordingOpen(() => Promise.resolve(OPENED))
  const { hook, unmount } = await mount(open, SOURCE, () => new Promise(() => {}))
  await act(async () => {
    hook().session.send('say hi')
  })
  await elapse(200)
  const stream = SilentEventSource.opened.at(-1)
  assert.ok(stream, 'a stream was opened')
  await act(async () => {
    stream.onmessage?.({ data: JSON.stringify({ kind: HISTORY_END_KIND, startIndex: 0, hasMore: false }) })
  })
  const { session } = hook()
  assert.equal(session.starting, false)
  assert.equal(session.loading, false)
  assert.equal(session.messages.length, 0)
  assert.equal(session.thinking, true, 'what the chat reads to say the agent is on it, not that nothing was said')
  await unmount()
})

test('a session the engine already holds is not shown as starting', async () => {
  await act(async () => activityWithAlive([SOURCE.tabKey]))
  const { open } = recordingOpen(() => new Promise(() => {}))
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(1000)
  assert.equal(hook().session.starting, false)
  await unmount()
})

test('what the reader sent while a start was out stays, marked not sent, when the start is refused', async () => {
  let refuse: (error: Error) => void = () => {}
  const { open } = recordingOpen(() => new Promise((_resolve, reject) => (refuse = reject)))
  const { hook, unmount } = await mount(open, SOURCE)
  await act(async () => {
    hook().session.send('hello there', { attachments: ['picture-1'], quoted: { selection: 'a quote' } })
  })
  assert.deepEqual(
    hook().outgoing.map((message) => [message.text, message.status]),
    [['hello there', 'sending']],
    'shown at once, on its way',
  )
  await act(async () => refuse(new SessionOpenRefusedError('Agent failed to start: boom', 'harness')))
  await elapse(100)
  const [held] = hook().outgoing
  assert.equal(held?.status, 'failed')
  assert.deepEqual(
    held?.options,
    { attachments: ['picture-1'], quoted: { selection: 'a quote' } },
    'what it carries is kept',
  )
  assert.equal(hook().session.draft, undefined, 'not also back in the composer, where it could be sent twice')
  assert.equal(hook().session.waiting, false, 'nothing is on its way')
  await unmount()
})

test('a send after a refusal opens again, and a second refusal leaves it marked not sent under one notice', async () => {
  const said = 'Agent failed to start: its terminal could not run it (container is not running)'
  const { calls, open } = recordingOpen(() => Promise.reject(new SessionOpenRefusedError(said, 'harness')))
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(1000)
  assert.equal(calls.length, 1)
  await act(async () => {
    hook().session.send('ping')
  })
  await elapse(1000)
  assert.deepEqual(
    calls.map((call) => call.wake),
    [true, true],
    'the send asked once more, as the reader',
  )
  assert.deepEqual(
    hook().outgoing.map((message) => [message.text, message.status]),
    [['ping', 'failed']],
  )
  assert.equal(hook().session.draft, undefined)
  assert.equal(hook().session.waiting, false, 'nothing is on its way')
  assert.equal(hook().session.notice?.title, "The agent couldn't start.")
  assert.equal(hook().session.notice?.details, said)
  assert.equal(notices().length, 1)
  await unmount()
})

test('a send after a refusal is delivered once the open it asks for succeeds', async () => {
  const sent: string[] = []
  const send: Send = async ({ text }) => {
    sent.push(text)
  }
  const { calls, open } = recordingOpen((call) =>
    call === 1 ? Promise.reject(new SessionOpenRefusedError(REFUSAL)) : Promise.resolve(OPENED),
  )
  const { hook, unmount } = await mount(open, SOURCE, send)
  await elapse(1000)
  await act(async () => {
    hook().session.send('after the fix')
  })
  await elapse(200)
  assert.equal(calls.length, 2)
  assert.deepEqual(sent, ['after the fix'])
  assert.equal(notices().length, 0)
  await unmount()
})

test('a send after the retries gave up opens again rather than waiting on nothing', async () => {
  const { calls, open } = recordingOpen(() => Promise.reject(new Error('fetch failed')))
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(4 * 60_000, 500)
  assert.equal(hook().openError, OPEN_GAVE_UP_TITLE)
  const before = calls.length
  await act(async () => {
    hook().session.send('still there?')
  })
  await elapse(100)
  // The send's open, as the reader; it fails too, so a fresh run of retries
  // follows it (its first one at once).
  assert.ok(calls.length > before, 'the send asked again')
  assert.equal(calls[before]?.wake, true)
  assert.equal(hook().openError, undefined, 'the given-up notice gives way to the new run')
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

// ── the presence it shows ──────────────────────────────────────────────────

function presenceEvent(kind: 'realtime' | 'hourly') {
  return { data: JSON.stringify({ kind: 'presence', presence: { kind } }) }
}

// Replays a stored presence the way the server opens a stream: a snapshot,
// then the end of the history.
async function replayPresence(kind: 'realtime'): Promise<void> {
  const stream = SilentEventSource.opened.at(-1)
  assert.ok(stream, 'a stream was opened')
  await act(async () => {
    stream.onmessage?.(presenceEvent(kind))
    stream.onmessage?.({
      data: JSON.stringify({ kind: HISTORY_END_KIND, startIndex: 0, hasMore: false, snapshotPrefix: 1 }),
    })
  })
}

// A presence set while the stream is live.
async function setLivePresence(kind: 'hourly'): Promise<void> {
  const stream = SilentEventSource.opened.at(-1)
  assert.ok(stream, 'a stream was opened')
  await act(async () => {
    stream.onmessage?.(presenceEvent(kind))
  })
}

test('an agent that cannot steer shows Online for the default and for a stored Realtime', async () => {
  const { open } = recordingOpen(() => Promise.resolve({ ...OPENED, canSteer: false }))
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(200)
  assert.deepEqual(hook().presence, { kind: 'online' }, 'the default')
  await replayPresence('realtime')
  assert.deepEqual(hook().presence, { kind: 'online' }, 'a stored realtime')
  await setLivePresence('hourly')
  assert.deepEqual(hook().presence, { kind: 'hourly' }, 'any other cadence as it is')
  await unmount()
})

test('an agent that can steer shows Realtime as Realtime', async () => {
  const { open } = recordingOpen(() => Promise.resolve({ ...OPENED, canSteer: true }))
  const { hook, unmount } = await mount(open, SOURCE)
  await elapse(200)
  assert.deepEqual(hook().presence, { kind: 'realtime' }, 'the default')
  await replayPresence('realtime')
  assert.deepEqual(hook().presence, { kind: 'realtime' }, 'a stored realtime')
  await unmount()
})
