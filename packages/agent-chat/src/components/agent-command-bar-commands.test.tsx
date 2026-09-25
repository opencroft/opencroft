// What picking a command writes into the composer.
//
// Mounted rather than rendered to markup, because the thing under test is a
// keystroke and a mousedown and the text they leave behind: the popup row can
// show one spelling while the insertion writes another, and only the round trip
// through the real handlers sees both.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { AvailableCommand } from 'agent-client/types'

import { installTestDom } from '../test-dom'

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
let useState: typeof import('react').useState
let createRoot: typeof import('react-dom/client').createRoot
let AgentCommandBar: typeof import('./agent-command-bar').AgentCommandBar

before(async () => {
  container = installTestDom()
  // jsdom lays nothing out, so it has no scrollIntoView; the popup calls it to
  // keep the active row visible, which is nothing these tests look at.
  window.HTMLElement.prototype.scrollIntoView = () => {}
  ;({ act, useState } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ AgentCommandBar } = await import('./agent-command-bar'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)

// The bar under a host that owns its value, as every real host does. Returns
// every value the bar reported, in order.
async function mount(): Promise<string[]> {
  await unmount()
  const reported: string[] = []
  function Host() {
    const [value, setValue] = useState('')
    return (
      <AgentCommandBar
        value={value}
        onValueChange={(next) => {
          reported.push(next)
          setValue(next)
        }}
        onSend={() => {}}
        commands={COMMANDS}
      />
    )
  }
  const next = createRoot(container)
  root = next
  await act(async () => next.render(<Host />))
  return reported
}

function composer(): HTMLTextAreaElement {
  const textarea = container.querySelector('textarea')
  assert.ok(textarea, 'no composer rendered')
  return textarea
}

// Change the textarea the way typing does, so React's onChange fires.
async function type(text: string) {
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
  await act(async () => {
    setValue?.call(composer(), text)
    composer().dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

async function press(key: string) {
  await act(async () => {
    composer().dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

function rows(): string[] {
  return [...container.querySelectorAll('[role="option"] > span:first-child')].map((span) => span.textContent ?? '')
}

test('a slash opens every command, each shown the way it is typed', async () => {
  await mount()
  await type('/')
  assert.deepEqual(rows(), ['/review', '$my-skill'])
})

test('picking a `$` name from the slash popup replaces the slash with the name as spelled', async () => {
  const reported = await mount()
  await type('/')
  await press('ArrowDown')
  await press('Enter')
  assert.equal(reported.at(-1), '$my-skill ')
  // The trailing space settles the token, so the popup is gone.
  assert.deepEqual(rows(), [])
})

test('a dollar opens only the `$` names, and Enter inserts one as spelled', async () => {
  const reported = await mount()
  await type('$')
  assert.deepEqual(rows(), ['$my-skill'])
  await press('Enter')
  assert.equal(reported.at(-1), '$my-skill ')
})

test('a slash command is still inserted behind its slash', async () => {
  const reported = await mount()
  await type('/rev')
  assert.deepEqual(rows(), ['/review'])
  await act(async () => {
    container.querySelector('[role="option"]')?.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }))
  })
  assert.equal(reported.at(-1), '/review ')
})
