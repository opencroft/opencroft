// What picking a command writes into the composer.
//
// Mounted rather than rendered to markup, because the thing under test is a
// keystroke and a mousedown and the text they leave behind: the list row can
// show one spelling while the insertion writes another, and only the round trip
// through the real handlers sees both.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { AvailableCommand } from 'agent-client/types'

import { installComposerDom, pressKey, typeText } from './test-composer'

// A subset of what codex-acp 1.13.1 advertises (src/CodexCommands.ts): a
// built-in slash command and a configured skill, which it names `$<skill>` and
// handles only when typed as spelled. The skill name is a placeholder.
const COMMANDS: AvailableCommand[] = [
  { name: 'review', description: 'Review uncommitted changes.', input: { hint: 'optional review instructions' } },
  { name: '$my-skill', description: 'Does the one thing this skill does', input: null },
]

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
// message it sent, in order.
async function mount() {
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
      />,
    ),
  )
  return { reported, sent }
}

function rows(): string[] {
  return [...container.querySelectorAll('[role="option"] > span:first-child')].map((span) => span.textContent ?? '')
}

test('a slash opens every command, each shown the way it is typed', async () => {
  await mount()
  await typeText(container, '/')
  assert.deepEqual(rows(), ['/review', '$my-skill'])
})

test('picking a `$` name from the slash list replaces the slash with the name as spelled', async () => {
  const { reported } = await mount()
  await typeText(container, '/')
  await pressKey(container, 'ArrowDown')
  await pressKey(container, 'Enter')
  assert.equal(reported.at(-1), '$my-skill ')
  // The trailing space settles the token, so the list is gone.
  assert.deepEqual(rows(), [])
})

test('a dollar opens only the `$` names, and Enter inserts one as spelled', async () => {
  const { reported } = await mount()
  await typeText(container, '$')
  assert.deepEqual(rows(), ['$my-skill'])
  await pressKey(container, 'Enter')
  assert.equal(reported.at(-1), '$my-skill ')
})

test('a slash command is still inserted behind its slash', async () => {
  const { reported } = await mount()
  await typeText(container, '/rev')
  assert.deepEqual(rows(), ['/review'])
  await act(async () => {
    container.querySelector('[role="option"]')?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  })
  assert.equal(reported.at(-1), '/review ')
})

test('Escape closes the commands and keeps what was typed, and Enter then sends it', async () => {
  const { reported, sent } = await mount()
  await typeText(container, '/rev')
  await pressKey(container, 'Escape')
  assert.deepEqual(rows(), [])
  assert.equal(reported.at(-1), '/rev')
  await pressKey(container, 'Enter')
  assert.deepEqual(sent, ['/rev'])
})

test('a slash that does not start the message opens nothing', async () => {
  await mount()
  await typeText(container, 'see /rev')
  assert.deepEqual(rows(), [])
})
