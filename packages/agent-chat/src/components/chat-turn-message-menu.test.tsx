// What a message's action menu offers, opened: the whole message's words to
// copy and to reply with, for every user message and for the agent's reply,
// and the turn's edit and fork on the message that ends the user's turn. A
// message the menu would offer nothing for has none.

import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import type { ReactNode } from 'react'

import { installTestDom } from '../test-dom'
import type { ChatTurnRenderers, ChatUserMessagePart, DetailItem, UserText } from './chat-turn'

let container: HTMLElement
let root: import('react-dom/client').Root | null = null
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let chatTurn: typeof import('./chat-turn')
let MessageActionsProvider: typeof import('./message-selection-bar').MessageActionsProvider
const copied: string[] = []

before(async () => {
  container = installTestDom()
  // What the menu primitive reaches for beyond the shared test DOM.
  const globals = globalThis as unknown as Record<string, unknown>
  for (const name of ['DOMRect', 'AbortController', 'AbortSignal', 'PointerEvent', 'FocusEvent']) {
    globals[name] = (window as unknown as Record<string, unknown>)[name]
  }
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  })
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  chatTurn = await import('./chat-turn')
  ;({ MessageActionsProvider } = await import('./message-selection-bar'))
})

afterEach(async () => {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
})

const renderers = {
  Chained: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChainDot: () => <span />,
  ThinkingBlock: ({ text }: { text: string }) => <div>{text}</div>,
} as unknown as ChatTurnRenderers

async function mount(children: ReactNode, onReply?: (text: string) => void) {
  const next = createRoot(container)
  root = next
  await act(async () =>
    next.render(<MessageActionsProvider value={onReply ? { onReply } : {}}>{children}</MessageActionsProvider>),
  )
}

function triggers(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[aria-label="Message actions"]')]
}

/** Opens a message's menu and returns its items' names. */
async function open(trigger: HTMLElement): Promise<string[]> {
  await act(async () => {
    trigger.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent ?? '')
}

async function choose(name: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((each) => each.textContent === name)
  assert.ok(item, `the open menu offers "${name}"`)
  await act(async () => item.click())
}

const part = (text: string): ChatUserMessagePart => ({ text: text as UserText })

test("each user message's menu copies and replies with that message; the ending one also edits and forks", async () => {
  const replies: string[] = []
  await mount(
    <chatTurn.ChatUserMessage
      blockId='u:0'
      parts={[part('first words'), part('second words')]}
      renderers={renderers}
      onEdit={() => {}}
      onFork={() => {}}
    />,
    (text) => replies.push(text),
  )
  const [first, second] = triggers()
  assert.deepEqual(await open(first), ['Copy Text', 'Reply'])
  await choose('Reply')
  assert.deepEqual(replies, ['first words'])
  assert.deepEqual(await open(second), ['Edit', 'Copy Text', 'Reply', 'Fork'])
  copied.length = 0
  await choose('Copy Text')
  assert.deepEqual(copied, ['second words'])
})

test("the agent's reply has a menu that copies and replies with its whole text", async () => {
  const replies: string[] = []
  const items: DetailItem[] = [
    { kind: 'assistant-text', text: 'Looking into it' },
    { kind: 'assistant-text', text: '**Done**: all green' },
  ]
  await mount(
    <chatTurn.ChatTurnDetails
      blockId='a:0'
      botName='agent-a'
      items={items}
      renderTool={() => null}
      renderers={renderers}
    />,
    (text) => replies.push(text),
  )
  assert.equal(triggers().length, 1, 'one menu, for the reply')
  assert.deepEqual(await open(triggers()[0]), ['Copy Text', 'Reply'])
  await choose('Reply')
  assert.deepEqual(replies, ['**Done**: all green'])
})

test('without a composer to reply into a menu offers Copy Text alone', async () => {
  await mount(<chatTurn.ChatUserMessage blockId='u:0' parts={[part('words')]} renderers={renderers} />)
  assert.deepEqual(await open(triggers()[0]), ['Copy Text'])
})

test('a message of pictures with no words has a menu only when the turn offers edit or fork on it', async () => {
  // Mid-turn: nothing to copy, reply with, edit or fork.
  await mount(
    <chatTurn.ChatUserMessage
      blockId='u:0'
      parts={[part(''), part('words')]}
      renderers={renderers}
      onEdit={() => {}}
      onFork={() => {}}
    />,
    () => {},
  )
  assert.equal(triggers().length, 1, 'only the message with words has a menu')
  assert.deepEqual(await open(triggers()[0]), ['Edit', 'Copy Text', 'Reply', 'Fork'])
  await act(async () => root?.unmount())
  root = null

  // Ending the turn, with no edit or fork from the host.
  await mount(<chatTurn.ChatUserMessage blockId='u:0' parts={[part('')]} renderers={renderers} />, () => {})
  assert.equal(triggers().length, 0, 'no empty menu')
  await act(async () => root?.unmount())
  root = null

  // Ending the turn, with edit and fork offered: those alone.
  await mount(
    <chatTurn.ChatUserMessage
      blockId='u:0'
      parts={[part('')]}
      renderers={renderers}
      onEdit={() => {}}
      onFork={() => {}}
    />,
    () => {},
  )
  assert.deepEqual(await open(triggers()[0]), ['Edit', 'Fork'])
})

test('a turn with no words from the agent has no reply menu', async () => {
  await mount(
    <chatTurn.ChatTurnDetails
      blockId='a:0'
      botName='agent-a'
      items={[{ kind: 'thinking', text: 'hmm' }]}
      renderTool={() => null}
      renderers={renderers}
    />,
    () => {},
  )
  assert.equal(triggers().length, 0)
})
