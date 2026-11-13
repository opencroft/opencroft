// What typing `@` in the composer offers, and what choosing writes.
//
// Mounted rather than rendered to markup: the thing under test is a keystroke
// and the text it leaves behind, and only the round trip through the editor's
// own handlers sees both.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { MentionCandidate } from './components/mention-autocomplete'
import { composerCaret, installComposerDom, pressKey, typeText } from './test-composer'

const PEOPLE: MentionCandidate[] = [
  { handle: 'agent.ada', name: 'Ada', avatarUrl: null },
  { handle: 'grace', name: 'Grace Hopper', avatarUrl: null },
]

const COMMANDS = [{ name: 'review', description: 'Review uncommitted changes.', input: null }]

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let ChatCommandBar: typeof import('./chat-composer').ChatCommandBar

before(async () => {
  container = installComposerDom()
  ;({ act } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ ChatCommandBar } = await import('./chat-composer'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)

// The bar under a host. Returns every value the composer reported and every
// message it sent, in order. `null` mounts it with no `mentions` at all.
async function mount(given: MentionCandidate[] | null = PEOPLE) {
  const mentions = given ?? undefined
  await unmount()
  const reported: string[] = []
  const sent: string[] = []
  const next = createRoot(container)
  root = next
  await act(async () =>
    next.render(
      <ChatCommandBar
        value=''
        onValueChange={(text) => reported.push(text)}
        onSend={(text) => sent.push(text)}
        commands={COMMANDS}
        mentions={mentions}
      />,
    ),
  )
  return { reported, sent }
}

function listLabel(): string | null {
  return container.querySelector('[role="listbox"]')?.getAttribute('aria-label') ?? null
}

// Each row's name, then its handle.
function rows(): string[][] {
  return [...container.querySelectorAll('[role="option"]')].map((row) =>
    [...row.querySelectorAll(':scope > span')].slice(1).map((span) => span.textContent ?? ''),
  )
}

test('an `@` lists everyone with their name and handle', async () => {
  await mount()
  await typeText(container, '@')
  assert.equal(listLabel(), 'Mentions')
  assert.deepEqual(rows(), [
    ['Ada', 'agent.ada'],
    ['Grace Hopper', 'grace'],
  ])
})

test('typing narrows by handle or name, and Enter inserts the handle and a space without sending', async () => {
  const { reported, sent } = await mount()
  await typeText(container, 'thanks @Gr')
  assert.deepEqual(rows(), [['Grace Hopper', 'grace']])
  await pressKey(container, 'Enter')
  assert.equal(reported.at(-1), 'thanks @grace ')
  assert.deepEqual(sent, [])
  // The trailing space ends the mention, so the list is gone and Enter sends.
  assert.deepEqual(rows(), [])
  await pressKey(container, 'Enter')
  assert.deepEqual(sent, ['thanks @grace'])
})

test('a mention typed straight before a word keeps that word, and the caret lands after the inserted space', async () => {
  const { reported, sent } = await mount()
  // `hello world` with `@gr` typed after `hello `, so the word follows the
  // caret with no space between.
  await typeText(container, 'hello @grworld', 9)
  assert.deepEqual(rows(), [['Grace Hopper', 'grace']])
  await pressKey(container, 'Enter')
  assert.equal(reported.at(-1), 'hello @grace world')
  assert.equal(composerCaret(container), 13)
  assert.deepEqual(sent, [])
})

test('arrows move the choice and Tab picks it', async () => {
  const { reported } = await mount()
  await typeText(container, '@')
  await pressKey(container, 'ArrowDown')
  await pressKey(container, 'Tab')
  assert.equal(reported.at(-1), '@grace ')
})

test('a mousedown on a row picks it', async () => {
  const { reported } = await mount()
  await typeText(container, '@ad')
  await act(async () => {
    container.querySelector('[role="option"]')?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  })
  assert.equal(reported.at(-1), '@agent.ada ')
})

test('Escape closes the list and keeps what was typed', async () => {
  const { reported, sent } = await mount()
  await typeText(container, '@ad')
  await pressKey(container, 'Escape')
  assert.deepEqual(rows(), [])
  assert.equal(reported.at(-1), '@ad')
  // Closed for this mention: Enter now sends it as typed.
  await pressKey(container, 'Enter')
  assert.deepEqual(sent, ['@ad'])
})

test('a mention closed with Escape opens again once a new one is typed', async () => {
  await mount()
  await typeText(container, '@ad')
  await pressKey(container, 'Escape')
  await typeText(container, '')
  await typeText(container, '@')
  assert.equal(rows().length, 2)
})

test('an `@` inside a word opens nothing', async () => {
  await mount()
  await typeText(container, 'mail@ad')
  assert.equal(listLabel(), null)
})

test('with nobody to mention, `@` opens nothing and Enter sends', async () => {
  const { sent } = await mount(null)
  await typeText(container, '@ad')
  assert.equal(listLabel(), null)
  await pressKey(container, 'Enter')
  assert.deepEqual(sent, ['@ad'])
})

test('a slash still opens the commands beside mentions', async () => {
  const { reported } = await mount()
  await typeText(container, '/')
  assert.equal(listLabel(), 'Commands')
  await pressKey(container, 'Enter')
  assert.equal(reported.at(-1), '/review ')
})
