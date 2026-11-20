// A new thread's first message carries the selection once.
//
// Starting a thread goes through two components: the start composer, which
// creates the thread and hands the message over, and the thread's chat, which
// sends it through its ordinary send. The selection block is attached at that
// send, so the start composer hands over what was typed and, beside it, the
// selection it quoted when the reader pressed send. Both halves are mounted
// here, in two scopes as the chats page has them (its thread list and its
// thread are separate routes), and what reaches the server is read.
//
// The server functions the two call are answered by fakes, through the same
// resolve hook as group-chat-thread-opening.test.tsx.
import assert from 'node:assert/strict'
import { register } from 'node:module'
import test, { after } from 'node:test'

import type { ReactNode } from 'react'

import type { Selection } from '@/app/_authed/(agent)/_shared/selection-envelope'
import type { MemberRef } from '@/app/_authed/(group-chats)/_server/read-model'
import { installDomEnvironment } from '@/test-support/dom-environment'

type Fakes = Record<string, (...args: never[]) => unknown>

const FAKED: Record<string, string[]> = {
  '../_server/actions.ts': [
    'openGroupChatThreadSession',
    'attachGroupChatThreadSession',
    'setGroupChatThreadDraft',
    'startGroupChatThread',
    'sendGroupChatThreadMessage',
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
const { addComposerStubs, composerText, pressKey, typeText } = await import('agent-chat/test-composer')
addComposerStubs()

const win = globalThis.window as unknown as Record<string, (...args: unknown[]) => unknown>
const globals = globalThis as unknown as Record<string, unknown>
for (const name of ['requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  globals[name] = win[name]?.bind(win)
}

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

const opened = () => ({
  sessionId: 'session-1',
  canFork: false,
  canSteer: false,
  canAttachImages: false,
  adapterId: 'codex',
  created: true,
  contextUsage: null,
})
const started: string[] = []
const sent: string[] = []
let refuseNextOpen = false
globals.__serverFakes = {
  openGroupChatThreadSession: async () => {
    if (refuseNextOpen) {
      refuseNextOpen = false
      return { refused: 'Ada needs an API key.' }
    }
    return opened()
  },
  attachGroupChatThreadSession: async () => opened(),
  setGroupChatThreadDraft: async () => undefined,
  startGroupChatThread: async ({ data }: { data: { firstMessage: string } }) => {
    started.push(data.firstMessage)
    return { ok: true, thread: { id: THREAD.id } }
  },
  sendGroupChatThreadMessage: async ({ data }: { data: { text: string } }) => {
    sent.push(data.text)
    return { ok: true }
  },
  forgetLocalSession: async () => undefined,
  getAutoApprove: async () => false,
  listExtensionClients: async () => [],
} satisfies Fakes

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { PASS_ENABLED_KEY, SelectionProvider, useSelection } = await import(
  '@/app/_authed/(extension-runtime)/_client/selection-context'
)
const { holdOpeningMessage } = await import('@/app/_authed/(group-chats)/_lib/opening-messages')
const { GroupChatStartThreadComposer } = await import('./group-chat-start-thread-composer')
const { GroupChatThreadChat } = await import('./group-chat-thread-chat')
const { HISTORY_END_KIND } = await import('@/app/_authed/(agent)/_lib/acp-stream')

after(() => dom.cleanup())

type Scope = ReturnType<typeof useSelection>
type ThreadProps = Parameters<typeof GroupChatThreadChat>[0]

const THREAD: ThreadProps['thread'] = {
  id: 'thread-1',
  groupChatId: 'chat-1',
  title: 'A thread',
  agent: { nodeId: 'agent-1', name: 'Ada', avatarUrl: null },
  createdAt: new Date(0),
  sessionKey: 'session-key-1',
  agentIsMember: true,
  hasDraft: false,
  archived: false,
  draft: null,
  queue: { items: [] },
}

const TWO_NODES: Selection = {
  items: [
    { kind: 'node', graph: 'acme.default', id: 'n-1', name: 'api', type: 'script-node' },
    { kind: 'node', graph: 'acme.default', id: 'n-2', name: 'db', type: 'script-node' },
  ],
}

function Grab({ into }: { into: { scope?: Scope } }): ReactNode {
  into.scope = useSelection()
  return null
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      // biome-ignore lint/plugin/noTestFixedTime: settle loop of five 5 ms rounds for the fakes to answer and their effects to run
      await new Promise((resolve) => setTimeout(resolve, 5))
    })
  }
}

const blocks = (text: string) => text.match(/<opencroft-user-selection>/g)?.length ?? 0

test("a new thread's first message carries the quoted selection once", async (t) => {
  const root = createRoot(dom.container)
  // Unmounted whatever the outcome: a mounted session keeps the run alive.
  t.after(() => act(async () => root.unmount()))
  const scope: { scope?: Scope } = {}
  let threadStarted: string | null = null
  const members: MemberRef[] = [{ kind: 'agent', id: 'agent-1', name: 'Ada', avatarUrl: null, username: 'ada' }]
  await act(async () =>
    root.render(
      <SelectionProvider spaceName='Acme' place='Default'>
        <Grab into={scope} />
        <GroupChatStartThreadComposer
          groupChatId='chat-1'
          members={members}
          onThreadStarted={(id) => {
            threadStarted = id
          }}
          fixedTitle='A thread'
        />
      </SelectionProvider>,
    ),
  )
  await settle()
  await act(async () => scope.scope?.setSelection(TWO_NODES))
  await typeText(dom.container, 'why?')
  await pressKey(dom.container, 'Enter')
  await settle()
  assert.equal(threadStarted, THREAD.id, 'the thread was started')
  assert.deepEqual(started, ['why?'], 'the thread is created with what was typed, and no block')

  // The thread's own route, in a scope of its own that holds nothing yet.
  await act(async () =>
    root.render(
      <SelectionProvider spaceName='Acme' place='Default'>
        <GroupChatThreadChat thread={THREAD} />
      </SelectionProvider>,
    ),
  )
  await settle()
  const stream = FakeEventSource.opened.at(-1)
  assert.ok(stream !== undefined, 'a stream was opened')
  await act(async () => {
    stream.onopen?.()
    stream.onmessage?.({ data: JSON.stringify({ kind: HISTORY_END_KIND, startIndex: 0, hasMore: false }) })
  })
  await settle()

  assert.equal(sent.length, 1, 'the opening message was sent once')
  const [first = ''] = sent
  assert.equal(blocks(first), 1, 'one selection block')
  assert.match(first, /^<opencroft-user-selection>Acme › Default › 2 nodes selected\n/)
  assert.match(first, /\nwhy\?$/)
})

const ONE_NODE: Selection = {
  items: [{ kind: 'node', graph: 'acme.default', id: 'n-3', name: 'cache', type: 'script-node' }],
}

// An opening message a refused first open left unsent stays in the
// conversation, marked not sent. Sent again, it is the same message: it quotes
// the selection it was started with, whatever this chat quotes by then, eye
// included.
const sendAgainButton = () =>
  [...dom.container.querySelectorAll('button')].find((button) => button.textContent === 'Send again')
const sentAgain: { name: string; change: (scope: Scope) => void }[] = [
  { name: 'with the eye turned off since', change: (scope) => scope.togglePass() },
  { name: 'with the selection changed since', change: (scope) => scope.setSelection(ONE_NODE) },
]
for (const row of sentAgain) {
  test(`an opening message a refused open left unsent is sent again with the selection it was started with, ${row.name}`, async (t) => {
    const root = createRoot(dom.container)
    const scope: { scope?: Scope } = {}
    t.after(async () => {
      await act(async () => root.unmount())
      // The eye is a stored preference, so it is put back for the next test.
      window.localStorage.removeItem(PASS_ENABLED_KEY)
    })
    sent.length = 0
    const tree = (thread: ReactNode) => (
      <SelectionProvider spaceName='Acme' place='Default'>
        <Grab into={scope} />
        {thread}
      </SelectionProvider>
    )
    await act(async () => root.render(tree(null)))
    await act(async () => scope.scope?.setSelection(TWO_NODES))
    const quoted = scope.scope?.selection?.content
    assert.ok(quoted !== undefined, 'the scope quotes the two nodes')
    holdOpeningMessage(THREAD.id, { text: 'why?', selection: quoted })

    refuseNextOpen = true
    await act(async () => root.render(tree(<GroupChatThreadChat thread={THREAD} />)))
    await settle()
    assert.equal(composerText(dom.container), '', 'not put back in the composer')
    assert.ok(dom.container.textContent?.includes('why?'), 'still in the conversation')
    assert.deepEqual(sent, [], 'nothing reached the server')

    const current = scope.scope
    assert.ok(current !== undefined)
    await act(async () => row.change(current))
    await act(async () => sendAgainButton()?.click())
    await settle()
    const stream = FakeEventSource.opened.at(-1)
    assert.ok(stream !== undefined, 'a stream was opened')
    await act(async () => {
      stream.onopen?.()
      stream.onmessage?.({ data: JSON.stringify({ kind: HISTORY_END_KIND, startIndex: 0, hasMore: false }) })
    })
    await settle()

    assert.equal(sent.length, 1, 'the message was sent once')
    const [message = ''] = sent
    assert.equal(blocks(message), 1, 'one selection block')
    assert.match(message, /^<opencroft-user-selection>Acme › Default › 2 nodes selected\n/)
    assert.match(message, /\nwhy\?$/)
  })
}

// The dock keeps one thread chat mounted and hands it the next thread, so what
// was held for one thread's opening must not reach a message in the next.
test("a thread's held opening selection does not reach the next thread the chat shows", async (t) => {
  const root = createRoot(dom.container)
  const scope: { scope?: Scope } = {}
  t.after(async () => {
    await act(async () => root.unmount())
    window.localStorage.removeItem(PASS_ENABLED_KEY)
  })
  sent.length = 0
  const tree = (thread: ReactNode) => (
    <SelectionProvider spaceName='Acme' place='Default'>
      <Grab into={scope} />
      {thread}
    </SelectionProvider>
  )
  await act(async () => root.render(tree(null)))
  await act(async () => scope.scope?.setSelection(TWO_NODES))
  const quoted = scope.scope?.selection?.content
  assert.ok(quoted !== undefined, 'the scope quotes the two nodes')
  holdOpeningMessage(THREAD.id, { text: 'why?', selection: quoted })

  refuseNextOpen = true
  await act(async () => root.render(tree(<GroupChatThreadChat thread={THREAD} />)))
  await settle()
  assert.ok(sendAgainButton(), 'the refused open left it unsent, with Send again')

  const next = { ...THREAD, id: 'thread-2', sessionKey: 'session-key-2' }
  await act(async () => root.render(tree(<GroupChatThreadChat thread={next} />)))
  await settle()
  assert.equal(sendAgainButton(), undefined, 'what was unsent in the last thread is not shown in this one')
  const stream = FakeEventSource.opened.at(-1)
  assert.ok(stream !== undefined, 'a stream was opened')
  await act(async () => {
    stream.onopen?.()
    stream.onmessage?.({ data: JSON.stringify({ kind: HISTORY_END_KIND, startIndex: 0, hasMore: false }) })
  })
  await settle()
  const current = scope.scope
  assert.ok(current !== undefined)
  await act(async () => current.togglePass())
  await typeText(dom.container, 'why?')
  await pressKey(dom.container, 'Enter')
  await settle()

  assert.deepEqual(sent, ['why?'], 'sent once, with no selection block')
})
