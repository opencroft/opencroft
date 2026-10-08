// When a thread's composer is there: not until its conversation has first
// opened, and from then on through the same conversation opening again in place
// -- a Clear, a Try again -- so what the reader typed is never dropped by it.
// A different thread is a different conversation and opens without one again.
// And what waits for the agent: the queue the thread was read with shows under
// the loader until the session's own stream takes over.
//
// The real host is mounted against a real DOM, with its effects. What it asks
// the server for is answered here: Node's resolve hook hands the host fakes for
// the few server functions it calls, and passes every other export of those
// modules through. A server function run outside the server throws (there is
// no Start context), so without this nothing past the first open happens.
//
// WHAT THIS DOES NOT COVER: the layout a reader sees, which only a browser
// shows, and that the server functions answer the way the fakes do; each is
// tested beside its own module.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { after, afterEach } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

type Fakes = Record<string, (...args: never[]) => unknown>

// Each module the host reaches the server through, with the functions it calls
// in it. The fake module re-exports the real one and puts these over it.
const FAKED: Record<string, string[]> = {
  '../_server/actions.ts': [
    'openGroupChatThreadSession',
    'attachGroupChatThreadSession',
    'clearGroupChatThread',
    'setGroupChatThreadDraft',
  ],
  '../../(agent)/_server/acp.ts': ['forgetLocalSession'],
  '../../(approvals)/_server/actions.ts': ['getAutoApprove'],
  '../../(extension-runtime)/_server/actions.ts': ['listExtensionClients'],
}
const redirects: Record<string, string> = {}
for (const [path, names] of Object.entries(FAKED)) {
  const url = new URL(path, import.meta.url).href
  const source = [
    `export * from ${JSON.stringify(`${url}?real`)}`,
    ...names.map(
      (name) => `export const ${name} = (...args) => globalThis.__serverFakes[${JSON.stringify(name)}](...args)`,
    ),
  ].join('\n')
  redirects[url] = `data:text/javascript,${encodeURIComponent(source)}`
}
register(
  `data:text/javascript,${encodeURIComponent(`const redirects = ${JSON.stringify(redirects)}
export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context)
  const fake = redirects[resolved.url]
  return fake ? { url: fake, shortCircuit: true } : resolved
}`)}`,
)

const dom = await installDomEnvironment()

// On the jsdom window and not copied onto the global object: the context ring's
// popover schedules and measures through them.
const win = globalThis.window as unknown as Record<string, (...args: unknown[]) => unknown>
const globals = globalThis as unknown as Record<string, unknown>
for (const name of ['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  globals[name] = win[name]?.bind(win)
}

// A session that opens streams, and jsdom has no EventSource. Each one is kept
// so a test can end its history replay the way the server does.
class FakeEventSource {
  static readonly CLOSED = 2
  static readonly opened: FakeEventSource[] = []
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
    FakeEventSource.opened.push(this)
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED
  }
}
globals.EventSource = FakeEventSource

let opens = 0
let refuseNextOpen = false
const opened = () => {
  opens += 1
  return {
    sessionId: `session-${opens}`,
    canFork: false,
    canSteer: false,
    canAttachImages: false,
    adapterId: 'codex',
    created: false,
    // A reading, so the composer draws the context ring that Clear lives in.
    contextUsage: { usedTokens: 1000, contextLimit: 200_000, asOf: null },
  }
}
globals.__serverFakes = {
  openGroupChatThreadSession: async () => {
    if (refuseNextOpen) {
      refuseNextOpen = false
      return { refused: 'Ada needs an API key.' }
    }
    return opened()
  },
  attachGroupChatThreadSession: async () => opened(),
  clearGroupChatThread: async () => undefined,
  setGroupChatThreadDraft: async () => undefined,
  forgetLocalSession: async () => undefined,
  getAutoApprove: async () => false,
  listExtensionClients: async () => [],
} satisfies Fakes

// After the DOM and the hook exist, never before.
const { act, createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { GroupChatThreadChat } = await import('./group-chat-thread-chat')
const { HISTORY_END_KIND } = await import('@/app/_authed/(agent)/_lib/acp-stream')

after(() => dom.cleanup())

type Props = Parameters<typeof GroupChatThreadChat>[0]

const THREAD: Props['thread'] = {
  id: 'thread-1',
  groupChatId: 'chat-1',
  title: 'A thread',
  agent: { nodeId: 'agent-1', name: 'Ada', avatarUrl: null },
  createdAt: new Date(0),
  sessionKey: 'session-key-1',
  agentIsMember: true,
  hasDraft: false,
  archived: false,
  // What the page loaded with. A Clear must not put the composer back to it.
  draft: null,
  queue: { items: [] },
}

const root = createRoot(dom.container)
afterEach(async () => {
  await act(async () => root.render(null))
})

const render = (props: Props) => act(async () => root.render(createElement(GroupChatThreadChat, props)))

// Lets the fakes answer and the effects they set off run, as the browser would.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

// The server's end of the latest stream's history replay, which is what ends
// an open.
async function endHistory(): Promise<void> {
  const stream = FakeEventSource.opened.at(-1)
  assert.ok(stream !== undefined, 'a stream was opened')
  await act(async () => {
    stream.onopen?.()
    stream.onmessage?.({ data: JSON.stringify({ kind: HISTORY_END_KIND, startIndex: 0, hasMore: false }) })
  })
  await settle()
}

// Asserted as booleans, never as the elements: a failed assertion prints its
// actual value, and printing a jsdom element walks the whole document until the
// process runs out of memory, so the failure is never reported.
const loader = () => dom.container.querySelector('svg[aria-label="Loading"]') !== null
const composer = () => dom.container.querySelector('textarea')
const hasComposer = () => composer() !== null
const button = (name: RegExp) =>
  [...document.querySelectorAll('button')].find((b) => name.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))
const hasButton = (name: RegExp) => button(name) !== undefined

async function type(text: string): Promise<void> {
  const textarea = composer()
  assert.ok(textarea !== null, 'a composer to type into')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(textarea, text)
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function press(name: RegExp): Promise<void> {
  const target = button(name)
  assert.ok(target !== undefined, `a ${name} button`)
  await act(async () => target.click())
}

test('the composer arrives once the conversation has opened, not before', async () => {
  await render({ thread: THREAD })
  await settle()
  assert.ok(loader(), 'still opening: the history has not ended')
  assert.equal(hasComposer(), false)
  await endHistory()
  assert.equal(loader(), false)
  assert.equal(hasComposer(), true)
})

test('what was typed survives a Clear, which opens the same conversation again', async () => {
  await render({ thread: THREAD })
  await settle()
  await endHistory()
  await type('typed before the clear')
  // Clear lives in the context ring's popover and asks once before it acts.
  await press(/^Context usage/)
  await press(/^Clear$/)
  await press(/^Press again to clear$/)
  await settle()
  assert.ok(loader(), 'the conversation is opening again')
  assert.equal(composer()?.value, 'typed before the clear', 'the composer stays through it')
  await endHistory()
  assert.equal(composer()?.value, 'typed before the clear')
})

test('a different thread opens without a composer, from its first render', async () => {
  const shown: { thread: string; composer: boolean }[] = []
  const props = (thread: Props['thread']): Props => ({
    thread,
    renderFrame: ({ conversation, composer }) => {
      shown.push({ thread: thread.id, composer: composer !== undefined })
      return createElement('div', null, conversation, composer)
    },
  })
  await render(props(THREAD))
  await settle()
  await endHistory()
  assert.equal(hasComposer(), true)
  const other = { ...THREAD, id: 'thread-2', sessionKey: 'session-key-2' }
  await render(props(other))
  await settle()
  assert.ok(loader(), 'the other thread is opening')
  const renders = shown.filter((entry) => entry.thread === other.id)
  assert.ok(renders.length > 0)
  assert.deepEqual(
    renders.filter((entry) => entry.composer),
    [],
    'no render of the other thread had a composer while it opened',
  )
  await endHistory()
  assert.equal(hasComposer(), true)
})

test('the queue the thread was read with shows under the loader until the open answers, then the live one', async () => {
  const queued = 'Queued second message'
  const waiting: Props['thread'] = {
    ...THREAD,
    queue: {
      items: [{ id: 'q-1', kind: 'message', sender: 'someone', sentAt: '2026-10-08T12:00:00.000Z', text: queued }],
    },
  }
  const shows = () => (dom.container.textContent ?? '').includes(queued)
  await render({ thread: waiting })
  await settle()
  assert.equal(loader(), true, 'still opening')
  assert.equal(shows(), true, 'the waiting message is under the loader')
  assert.equal(hasComposer(), false)
  // A preview: no session to remove it from or deliver it into yet.
  assert.equal(dom.container.querySelectorAll('button').length, 0, 'no remove or deliver control')
  // The stream's replay carries no queue: the message was delivered meanwhile.
  await endHistory()
  assert.equal(hasComposer(), true)
  assert.equal(shows(), false, 'the live queue replaces the one the thread was read with')
})

test('a refused first open shows no composer until Try again opens it', async () => {
  refuseNextOpen = true
  await render({ thread: THREAD })
  await settle()
  assert.equal(hasButton(/^Try again$/), true, 'the refusal is shown')
  assert.equal(hasComposer(), false)
  await press(/^Try again$/)
  await settle()
  await endHistory()
  assert.equal(hasButton(/^Try again$/), false)
  assert.equal(hasComposer(), true)
})
