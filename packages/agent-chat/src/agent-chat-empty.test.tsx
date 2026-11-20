// What a conversation shows around its messages while nothing has been said
// yet or a session is starting: "No messages yet" only when nothing is going
// on in it; the logo loader for a start; a notice set in from the edges.
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import type { ReactNode } from 'react'

import { installTestDom } from './test-dom'

let container: HTMLElement
let root: import('react-dom/client').Root | null = null
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let AgentChat: typeof import('./agent-chat').AgentChat
let buildKitBlocks: typeof import('./kit-blocks').buildKitBlocks

before(async () => {
  container = installTestDom()
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    disconnect() {}
  }
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ AgentChat } = await import('./agent-chat'))
  ;({ buildKitBlocks } = await import('./kit-blocks'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

after(() => {
  container.innerHTML = ''
})

const renderers = new Proxy(
  {},
  { get: () => (props: { children?: ReactNode }) => <div>{props.children}</div> },
) as import('./components/chat-turn').ChatTurnRenderers

const EMPTY_TEXT = 'No messages yet'

interface State {
  loading?: boolean
  waiting?: boolean
  thinking?: boolean
  starting?: boolean
  notice?: { title: string }
  said?: string
  outgoing?: import('./components/chat-turn').ChatUserMessagePart[]
  onRetry?: (id: string) => void
  onDiscard?: (id: string) => void
}

async function renderChat(state: State) {
  root ??= createRoot(container)
  const current = root
  const session = {
    sessionKey: 'session-1',
    loading: state.loading ?? false,
    sending: false,
    waiting: state.waiting ?? false,
    thinking: state.thinking,
    starting: state.starting,
    botName: 'Agent A',
    send: () => {},
    hasMoreHistory: false,
    notice: state.notice,
  }
  const blocks = state.said ? buildKitBlocks([{ id: '1', kind: 'user', text: state.said }]) : []
  await act(async () =>
    current.render(
      <AgentChat
        session={session}
        blocks={blocks}
        hasMessages={blocks.length > 0}
        renderers={renderers}
        renderTool={() => null}
        outgoing={state.outgoing}
        onRetryOutgoing={state.onRetry}
        onDiscardOutgoing={state.onDiscard}
      />,
    ),
  )
}

async function renderEmpty(state: State) {
  await renderChat(state)
  return container.textContent ?? ''
}

const logoLoaders = () => container.querySelectorAll('svg[aria-label="Loading"]').length
// The working indicator's phrase is the one monospaced line the chat draws.
const workingIndicators = () => container.querySelectorAll('.font-mono').length

test('a conversation with nothing in it and nothing going on says so', async () => {
  assert.ok((await renderEmpty({})).includes(EMPTY_TEXT))
})

test('an agent working on the first message is not "no messages yet", whatever has reached the transcript', async () => {
  // The history of a just-started session can end before the message it was
  // started with is back in it: the reader has sent something and the agent is
  // on it, so the panel stays blank above the indicator.
  assert.equal((await renderEmpty({ waiting: true, thinking: true })).includes(EMPTY_TEXT), false)
})

test('a turn held open for delegated work alone is not "no messages yet" either', async () => {
  assert.equal((await renderEmpty({ waiting: true, thinking: false })).includes(EMPTY_TEXT), false)
})

test('a start in progress is not "no messages yet"', async () => {
  assert.equal((await renderEmpty({ starting: true })).includes(EMPTY_TEXT), false)
})

test('a start over an empty conversation is the logo loader, not the working indicator', async () => {
  await renderChat({ starting: true })
  assert.equal(logoLoaders(), 1)
  assert.equal(workingIndicators(), 0)
  // The panel's own state, centred in it, as anything else loading is; not a
  // loader under an empty panel.
  const panel = container.querySelector('svg[aria-label="Loading"]')?.parentElement
  assert.ok(panel?.classList.contains('p-4') && panel.classList.contains('flex-1'), `in the panel, got "${panel?.className}"`)
})

test('a start under a transcript keeps the transcript and shows the logo loader below it', async () => {
  await renderChat({ starting: true, said: 'are you there?' })
  assert.ok(container.textContent?.includes('are you there?'))
  assert.equal(logoLoaders(), 1)
  assert.equal(workingIndicators(), 0)
  // Centred across the conversation's width: a bare svg is not stretched, so
  // without the cross-axis centring it sits at the left edge.
  const row = container.querySelector('svg[aria-label="Loading"]')?.parentElement
  assert.ok(row?.classList.contains('items-center'), `centred below the transcript, got "${row?.className}"`)
})

type Part = import('./components/chat-turn').ChatUserMessagePart
const SENDING: Part = {
  id: 'out-1',
  // Words as a host hands them over, already display-ready.
  text: 'still there?' as Part['text'],
  sentAt: '2026-01-01T10:00:00.000Z',
  delivery: { state: 'sending' },
}
const sendingSpinners = () => container.querySelectorAll('svg[aria-label="Sending"]').length

test('a start a send set off under a transcript shows the message with its spinner, not the logo loader', async () => {
  await renderChat({ starting: true, said: 'are you there?', outgoing: [SENDING] })
  assert.ok(container.textContent?.includes('are you there?'))
  assert.ok(container.textContent?.includes('still there?'), 'the sent message is on screen')
  assert.equal(sendingSpinners(), 1)
  assert.equal(logoLoaders(), 0)
})

test('a start under a transcript with only a failed message on screen shows the logo loader', async () => {
  const failed: Part = { ...SENDING, delivery: { state: 'failed', reason: 'Not sent.' } }
  await renderChat({ starting: true, said: 'are you there?', outgoing: [failed] })
  assert.equal(logoLoaders(), 1)
})

test('a message the server holds draws no spinner', async () => {
  const { delivery: _delivery, ...accepted } = SENDING
  await renderChat({ said: 'are you there?', outgoing: [accepted] })
  assert.ok(container.textContent?.includes('still there?'))
  assert.equal(sendingSpinners(), 0)
})

test('a message that did not arrive keeps its words under the error notice, with Send again and Discard', async () => {
  const pressed: string[] = []
  const failed: Part = { ...SENDING, delivery: { state: 'failed', reason: 'Not sent: the network is unreachable.' } }
  await renderChat({
    said: 'are you there?',
    outgoing: [failed],
    onRetry: (id) => pressed.push(`retry ${id}`),
    onDiscard: (id) => pressed.push(`discard ${id}`),
  })
  assert.ok(container.textContent?.includes('still there?'))
  const alert = container.querySelector('[role="alert"]')
  assert.ok(alert?.textContent?.includes('Not sent: the network is unreachable.'))
  const buttons = [...(alert?.querySelectorAll('button') ?? [])]
  assert.deepEqual(
    buttons.map((button) => button.textContent),
    ['Send again', 'Discard'],
  )
  await act(async () => {
    for (const button of buttons) {
      button.click()
    }
  })
  assert.deepEqual(pressed, ['retry out-1', 'discard out-1'])
  assert.equal(sendingSpinners(), 0)
})

test('a failed first message is not "no messages yet"', async () => {
  const failed: Part = { ...SENDING, delivery: { state: 'failed', reason: 'Not sent.' } }
  const text = await renderEmpty({ outgoing: [failed] })
  assert.equal(text.includes(EMPTY_TEXT), false)
  assert.ok(text.includes('still there?'))
})

test('once started, the agent working on the message shows the working indicator', async () => {
  await renderChat({ waiting: true, thinking: true })
  assert.equal(logoLoaders(), 0)
  assert.equal(workingIndicators(), 1)
})

test('a notice in an empty conversation is set in from the edges, as under a transcript', async () => {
  await renderChat({ notice: { title: 'The agent could not start.' } })
  const alert = container.querySelector('[role="alert"]')
  assert.ok(alert, 'the notice is shown')
  const inset = alert.parentElement
  assert.ok(inset?.classList.contains('px-4'), `inset by the conversation's padding, got "${inset?.className}"`)
})

test('a session that opened with the first message held shows one loader until its history is in', async () => {
  // After the open answers and before the history ends: no longer starting,
  // still loading, and the held message already counts as work.
  await renderChat({ loading: true, waiting: true, thinking: true })
  assert.equal(logoLoaders(), 1)
  assert.equal(workingIndicators(), 0)
})
