// What a chat tab shows of a message the reader sent, from Send until the
// stream carries it: drawn at once as on its way, without its spinner once the
// server answered, gone in the same render as the stream's own copy, and kept
// with Send again and Discard when it did not get there.
//
// The real hook is mounted against a real DOM with an injected open and send
// transport -- the seams a host uses -- and a stream the test speaks for.
//
// WHAT THIS DOES NOT COVER: how the rows are drawn (agent-chat's own tests and
// QA in a browser), and the order a real network delivers the server's answer
// and the stream's copy in -- both orders are driven here by hand.
import assert from 'node:assert/strict'
import test, { after, afterEach, beforeEach, mock } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'
import { deferred } from '@/test-support/wait'

const dom = await installDomEnvironment()

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

const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useAcpSession } = await import('./use-acp-session')
const { HISTORY_END_KIND } = await import('@/app/_authed/(agent)/_lib/acp-stream')
const { MAX_MESSAGE_TEXT_BYTES } = await import('@/app/_authed/(agent)/_shared/message-size')
const { buildOutgoing } = await import('@/app/_authed/(agent)/_lib/build-blocks')

type Hook = ReturnType<typeof useAcpSession>
type Send = NonNullable<Parameters<typeof useAcpSession>[2]>
type Open = NonNullable<Parameters<typeof useAcpSession>[3]>
type SendArgs = Parameters<Send>[0]

after(() => dom.cleanup())

beforeEach(() => {
  mock.method(console, 'error', () => {})
})

afterEach(() => {
  mock.restoreAll()
})

const OPENED: Awaited<ReturnType<Open>> = {
  sessionId: 'session-1',
  canFork: false,
  canSteer: false,
  canAttachImages: true,
  adapterId: 'codex',
  created: false,
  contextUsage: null,
}

// Every send the transport was asked for, each answered by hand.
function handAnsweredSend() {
  const calls: { args: SendArgs; answer: PromiseWithResolvers<void> }[] = []
  const send: Send = (args) => {
    const answer = deferred()
    calls.push({ args, answer })
    return answer.promise
  }
  return { calls, send }
}

// Opened, its history replayed, and the stream live: the state a reader sends
// into an open chat from.
async function mountLive(send: Send) {
  let current: Hook | undefined
  // The rows each render committed, so "in the same render" is read per commit.
  const commits: { outgoing: string[]; queue: number }[] = []
  function Probe() {
    current = useAcpSession({ agentNodeId: 'agent-1', tabKey: 'thread-key-1' }, 'Agent', send, () =>
      Promise.resolve(OPENED),
    )
    commits.push({ outgoing: current.outgoing.map((message) => message.status), queue: current.queue.length })
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => root.render(createElement(Probe)))
  const stream = SilentEventSource.opened.at(-1)
  assert.ok(stream, 'a stream was opened')
  const speak = (event: unknown) =>
    act(async () => {
      stream.onmessage?.({ data: JSON.stringify(event) })
    })
  await speak({ kind: HISTORY_END_KIND, startIndex: 0, hasMore: false })
  const hook = () => {
    assert.ok(current)
    return current
  }
  return { hook, speak, commits, unmount: () => act(async () => root.unmount()) }
}

const QUEUED = {
  kind: 'queue',
  items: [{ id: 'q-1', kind: 'message', sender: 'reader', sentAt: '2026-01-01T00:00:00.000Z', text: 'hello' }],
}

test('a sent message is shown at once as on its way, carrying its pictures and quote to the transport', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, unmount } = await mountLive(send)
  await act(async () => {
    hook().session.send('hello', { attachments: ['picture-1'], quoted: { selection: 'a quote' } })
  })
  assert.deepEqual(
    hook().outgoing.map((message) => [message.text, message.status]),
    [['hello', 'sending']],
  )
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.args.text, 'hello')
  assert.deepEqual(calls[0]?.args.attachments, ['picture-1'])
  assert.deepEqual(calls[0]?.args.quoted, { selection: 'a quote' })
  await unmount()
})

test('answered before the stream carries it: the spinner goes, and the row goes in the render the copy arrives in', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, speak, commits, unmount } = await mountLive(send)
  await act(async () => {
    hook().session.send('hello')
  })
  await act(async () => calls[0]?.answer.resolve())
  assert.deepEqual(
    hook().outgoing.map((message) => message.status),
    ['accepted'],
    'still drawn, without its spinner, until the copy comes',
  )
  commits.length = 0
  await speak(QUEUED)
  // Every commit holds the message once: the row, or the queue entry.
  assert.ok(commits.length > 0)
  for (const commit of commits) {
    assert.equal(commit.outgoing.length + commit.queue, 1, JSON.stringify(commits))
  }
  assert.deepEqual(hook().outgoing, [])
  await unmount()
})

test('carried by the stream before the answer: the row goes with the answer', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, speak, unmount } = await mountLive(send)
  await act(async () => {
    hook().session.send('hello')
  })
  await speak(QUEUED)
  assert.deepEqual(
    hook().outgoing.map((message) => message.status),
    ['sending'],
    'not taken for confirmation on its own',
  )
  await act(async () => calls[0]?.answer.resolve())
  assert.deepEqual(hook().outgoing, [])
  await unmount()
})

test('a queue snapshot that only empties the queue is not taken for the message', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, speak, unmount } = await mountLive(send)
  await act(async () => {
    hook().session.send('hello')
  })
  await act(async () => calls[0]?.answer.resolve())
  await speak({ kind: 'queue', items: [] })
  assert.deepEqual(
    hook().outgoing.map((message) => message.status),
    ['accepted'],
  )
  await unmount()
})

// A message sent while the session starts is held, and sent as the start's
// stream opens: the stream's replay of history can then hold it already, or
// not yet, and arrive before or after the server's answer.
async function mountHeld(send: Send) {
  let current: Hook | undefined
  const commits: { outgoing: number; queue: number }[] = []
  const opening = deferred<Awaited<ReturnType<Open>>>()
  function Probe() {
    current = useAcpSession({ agentNodeId: 'agent-1', tabKey: 'thread-key-held' }, 'Agent', send, () => opening.promise)
    commits.push({ outgoing: current.outgoing.length, queue: current.queue.length })
    return null
  }
  const root = createRoot(dom.container)
  await act(async () => root.render(createElement(Probe)))
  const hook = () => {
    assert.ok(current)
    return current
  }
  await act(async () => {
    hook().session.send('hello')
  })
  await act(async () => opening.resolve(OPENED))
  const stream = SilentEventSource.opened.at(-1)
  assert.ok(stream, 'a stream was opened')
  const speak = (...events: unknown[]) =>
    act(async () => {
      for (const event of events) {
        stream.onmessage?.({ data: JSON.stringify(event) })
      }
    })
  return { hook, speak, commits, unmount: () => act(async () => root.unmount()) }
}

const REPLAY_END = { kind: HISTORY_END_KIND, startIndex: 0, hasMore: false, snapshotPrefix: 1 }

test('a replay that holds the message, ahead of the answer: the row goes with the answer', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, speak, commits, unmount } = await mountHeld(send)
  assert.equal(calls.length, 1, 'the held message was sent as the session opened')
  await speak(QUEUED, REPLAY_END)
  assert.deepEqual(
    hook().outgoing.map((message) => message.status),
    ['sending'],
  )
  commits.length = 0
  await act(async () => calls[0]?.answer.resolve())
  assert.deepEqual(hook().outgoing, [])
  for (const commit of commits) {
    assert.equal(commit.outgoing + commit.queue, 1, JSON.stringify(commits))
  }
  await unmount()
})

test('a replay that does not hold the message, after the answer: the row waits for its live copy', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, speak, commits, unmount } = await mountHeld(send)
  await act(async () => calls[0]?.answer.resolve())
  await speak(REPLAY_END)
  assert.deepEqual(
    hook().outgoing.map((message) => message.status),
    ['accepted'],
    'still drawn: the replay was taken before the server held it',
  )
  commits.length = 0
  await speak(QUEUED)
  assert.deepEqual(hook().outgoing, [])
  for (const commit of commits) {
    assert.equal(commit.outgoing + commit.queue, 1, JSON.stringify(commits))
  }
  await unmount()
})

test('a replay that holds the message, after the answer: the row goes with the replay', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, speak, unmount } = await mountHeld(send)
  await act(async () => calls[0]?.answer.resolve())
  await speak(QUEUED, REPLAY_END)
  assert.deepEqual(hook().outgoing, [])
  assert.equal(hook().queue.length, 1)
  await unmount()
})

test('a send that fails stays, saying it was not sent and nothing of the composer, and nothing goes back into it', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, unmount } = await mountLive(send)
  await act(async () => {
    hook().session.send('hello')
  })
  await act(async () => calls[0]?.answer.reject(new TypeError('Failed to fetch')))
  const [failed] = hook().outgoing
  assert.ok(failed)
  assert.equal(failed.status, 'failed')
  // What the row says, as the conversation draws it: not sent, and nothing
  // about a composer the words are not in.
  const [row] = buildOutgoing([{ ...failed, pictures: [] }])
  assert.deepEqual(row?.delivery, { state: 'failed', reason: "Your message wasn't sent.", details: 'Failed to fetch' })
  assert.equal(hook().session.draft, undefined)
  assert.equal(hook().session.notice, undefined, 'told on the message, not in a second notice')
  await unmount()
})

test('Send again sends the same message once, however often it is pressed', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, unmount } = await mountLive(send)
  await act(async () => {
    hook().session.send('hello', { attachments: ['picture-1'], quoted: { selection: 'a quote' } })
  })
  await act(async () => calls[0]?.answer.reject(new TypeError('Failed to fetch')))
  const id = hook().outgoing[0]?.id
  assert.ok(id)
  await act(async () => {
    hook().retryOutgoing(id)
    hook().retryOutgoing(id)
  })
  assert.deepEqual(
    hook().outgoing.map((message) => message.status),
    ['sending'],
  )
  assert.equal(calls[1]?.args.text, 'hello')
  assert.deepEqual(calls[1]?.args.attachments, ['picture-1'])
  assert.deepEqual(calls[1]?.args.quoted, { selection: 'a quote' })
  // Requests go one at a time, so a second one would only be asked for once
  // this one is answered.
  await act(async () => calls[1]?.answer.resolve())
  assert.equal(calls.length, 2, 'one more request, not two')
  await unmount()
})

test('text over the size limit is refused before it is drawn, and goes back into the composer with the notice', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, unmount } = await mountLive(send)
  const tooLong = 'a'.repeat(MAX_MESSAGE_TEXT_BYTES + 1)
  await act(async () => {
    hook().session.send(tooLong)
  })
  assert.deepEqual(hook().outgoing, [], 'no row that Send again could never deliver')
  assert.equal(calls.length, 0, 'nothing asked of the server')
  assert.equal(hook().session.draft?.text, tooLong, 'the reader keeps the text to shorten')
  assert.ok(hook().session.notice, 'and is told why')
  await unmount()
})

test('Discard takes a failed message off the screen without sending it', async () => {
  const { calls, send } = handAnsweredSend()
  const { hook, unmount } = await mountLive(send)
  await act(async () => {
    hook().session.send('hello')
  })
  await act(async () => calls[0]?.answer.reject(new TypeError('Failed to fetch')))
  const id = hook().outgoing[0]?.id
  assert.ok(id)
  await act(async () => hook().discardOutgoing(id))
  assert.deepEqual(hook().outgoing, [])
  assert.equal(calls.length, 1)
  await unmount()
})
