// Writing into the composer through its handle: what a reply quoted from the
// transcript leaves behind -- the text, the focus, and where the caret is.
//
// Mounted, because the caret is placed after the kit bar has taken the new text
// and that only happens in a real commit.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { AgentCommandBarSession, AgentComposerHandle, UseAgentCommandBarOptions } from './agent-command-bar'
import { installTestDom } from './test-dom'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRef: typeof import('react').createRef
let createRoot: typeof import('react-dom/client').createRoot
let useAgentCommandBar: typeof import('./agent-command-bar').useAgentCommandBar

const SESSION: AgentCommandBarSession = {
  sessionKey: 'session-under-test',
  send: () => {},
  waiting: false,
  sending: false,
}

before(async () => {
  container = installTestDom()
  ;({ act, createRef } = await import('react'))
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useAgentCommandBar } = await import('./agent-command-bar'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)

function Bar(options: UseAgentCommandBarOptions) {
  return useAgentCommandBar(options)
}

async function mount(savedDraft: string) {
  await unmount()
  const composerRef = createRef<AgentComposerHandle>()
  const options: UseAgentCommandBarOptions = {
    session: SESSION,
    approvalTitles: { yolo: 'yolo', on: 'on', off: 'off' },
    autoApprove: false,
    savedDraft,
    composerRef,
  }
  const next = createRoot(container)
  root = next
  await act(async () => next.render(<Bar {...options} />))
  const handle = composerRef.current
  assert.ok(handle, 'the hook published no handle')
  return handle
}

function composer(): HTMLTextAreaElement {
  const textarea = container.querySelector('textarea')
  assert.ok(textarea, 'no composer rendered')
  return textarea
}

test('update loads the new text, focuses the composer and puts the caret at the end', async () => {
  const handle = await mount('draft')
  let seen: string | undefined
  await act(async () =>
    handle.update((current) => {
      seen = current
      return `${current}\n\n> quoted\n\n`
    }),
  )
  assert.equal(seen, 'draft', 'update is handed what the composer holds')
  const textarea = composer()
  assert.equal(textarea.value, 'draft\n\n> quoted\n\n')
  // Booleans, not the elements: a failing comparison prints its operands, and
  // printing a jsdom element walks the whole window -- the run stalls instead
  // of reporting.
  assert.equal(document.activeElement === textarea, true, 'the composer does not have focus')
  assert.equal(textarea.selectionStart, textarea.value.length)
  assert.equal(textarea.selectionEnd, textarea.value.length)
})

test('an update that leaves the text as it was still puts the caret at the end', async () => {
  // Loading a DIFFERENT text moves the caret to the end by itself, so the case
  // above cannot tell whether the handle places it. Unchanged text leaves the
  // textarea's value untouched, and only the handle moves the caret then.
  const handle = await mount('draft')
  const textarea = composer()
  textarea.setSelectionRange(0, 0)
  await act(async () => handle.update((current) => current))
  assert.equal(textarea.selectionStart, textarea.value.length)
  assert.equal(document.activeElement === textarea, true, 'the composer does not have focus')
})
