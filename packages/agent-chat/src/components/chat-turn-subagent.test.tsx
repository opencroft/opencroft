// A subagent section whose steps the host loads only once it is expanded: the
// header counts the steps the host reports before any of them are there, the
// first expand is the host's cue to load them, and the section shows that it
// is loading and offers its older steps.
import assert from 'node:assert/strict'
import { after, afterEach, before, test } from 'node:test'

import type { ReactNode } from 'react'

import { installTestDom } from '../test-dom'
import type { ChatTurnRenderers, DetailItem } from './chat-turn'

let container: HTMLElement
let root: import('react-dom/client').Root | null = null
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let ChatTurnDetails: typeof import('./chat-turn').ChatTurnDetails

before(async () => {
  container = installTestDom()
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ChatTurnDetails } = await import('./chat-turn'))
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

const renderers = {
  Chained: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ChainDot: () => <span />,
  ThinkingBlock: ({ text }: { text: string }) => <div>{text}</div>,
} as unknown as ChatTurnRenderers

type SubagentItem = Extract<DetailItem, { kind: 'subagent' }>

async function render(item: SubagentItem): Promise<void> {
  const target = root ?? createRoot(container)
  root = target
  await act(async () =>
    target.render(
      <ChatTurnDetails
        blockId='b1'
        botName='agent-a'
        items={[item]}
        renderTool={(tool) => <div>{`tool:${tool.name}`}</div>}
        renderers={renderers}
      />,
    ),
  )
}

const header = () => container.querySelector<HTMLButtonElement>('button[title$="subagent"]')

async function press(button: HTMLButtonElement | null): Promise<void> {
  assert.ok(button, 'the control is there')
  await act(async () => button.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
}

const section = (over: Partial<SubagentItem>): SubagentItem => ({
  kind: 'subagent',
  id: 'child-1',
  name: 'Investigator',
  task: 'dig',
  items: [],
  ...over,
})

test("the header counts the host's steps before any of them are loaded", async () => {
  await render(section({ steps: 4, onExpand: () => {} }))
  assert.match(container.textContent ?? '', /Investigator.*4 steps/)
})

test('without a reported count the header counts the items it was given', async () => {
  await render(section({ items: [{ kind: 'assistant-text', text: 'one' }] }))
  assert.match(container.textContent ?? '', /1 step(?!s)/)
})

test('expanding is the cue to load, once per opening, and the section shows it is loading', async () => {
  let asked = 0
  await render(section({ steps: 4, onExpand: () => (asked += 1), loading: true }))
  await press(header())
  assert.equal(asked, 1)
  assert.match(container.textContent ?? '', /Loading…/)
  // Collapsing is not a request for anything.
  await press(header())
  assert.equal(asked, 1)
})

test('a loaded section draws its steps and offers the older ones', async () => {
  let older = 0
  await render(
    section({
      steps: 12,
      onExpand: () => {},
      items: [{ kind: 'assistant-text', text: 'the newest step' }],
      onLoadOlder: () => (older += 1),
    }),
  )
  await press(header())
  assert.match(container.textContent ?? '', /the newest step/)
  assert.doesNotMatch(container.textContent ?? '', /Loading…/)
  const loadOlder = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.includes('Load Older Messages'),
  )
  await press(loadOlder ?? null)
  assert.equal(older, 1)
})
