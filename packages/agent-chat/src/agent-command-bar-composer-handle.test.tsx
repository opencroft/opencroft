// Writing into the composer through its handle: what a reply quoted from the
// transcript leaves behind -- the text, the focus, and where the caret is.
//
// Mounted, because the caret is placed after the composer has taken the new
// text and that only happens in a real commit.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import type { AgentCommandBarSession, AgentComposerHandle, UseAgentCommandBarOptions } from './agent-command-bar'
import { appendQuotedReply } from './message-quote'
import { composerEditor, installComposerDom, settle } from './test-composer'

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
  container = installComposerDom()
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
  await settle()
  const handle = composerRef.current
  assert.ok(handle, 'the hook published no handle')
  return handle
}

/** Whether the caret is at the very end of the composer's text. */
function caretAtEnd(): boolean {
  const { state } = composerEditor(container)
  const end = state.doc.content.size - 1
  return state.selection.empty && state.selection.from === end
}

test('update loads the new text, focuses the composer and puts the caret at the end', async () => {
  const handle = await mount('draft')
  let seen: string | undefined
  await act(async () =>
    handle.update((current) => {
      seen = current
      return `${current}\n\n> quoted`
    }),
  )
  await settle()
  assert.equal(seen, 'draft', 'update is handed what the composer holds')
  const editor = composerEditor(container)
  assert.deepEqual(
    editor.state.doc.content.content.map((node) => [node.type.name, node.textContent]),
    [
      ['paragraph', 'draft'],
      ['blockquote', 'quoted'],
      ['paragraph', ''],
    ],
  )
  // Booleans, not the elements: a failing comparison prints its operands, and
  // printing a jsdom element walks the whole window -- the run stalls instead
  // of reporting.
  assert.equal(document.activeElement === editor.view.dom, true, 'the composer does not have focus')
  assert.equal(caretAtEnd(), true, 'the caret is not at the end')
})

test("a reply's quote goes in as a formatted quote, its lines kept, the caret on a line after it", async () => {
  const handle = await mount('draft')
  await act(async () => handle.update((current) => appendQuotedReply(current, 'first line\nsecond line\n\nthird')))
  await settle()
  const editor = composerEditor(container)
  assert.deepEqual(editor.getJSON().content, [
    { type: 'paragraph', content: [{ type: 'text', text: 'draft' }] },
    {
      type: 'blockquote',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'first line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'third' }] },
      ],
    },
    { type: 'paragraph' },
  ])
  assert.equal(editor.view.dom.textContent?.includes('>'), false, 'a quote mark is drawn as text')
  assert.equal(caretAtEnd(), true, 'the caret is not at the end')
})

test('an update that leaves the text as it was still puts the caret at the end', async () => {
  // Loading a DIFFERENT text moves the caret to the end by itself, so the case
  // above cannot tell whether the handle places it. Here the load puts back the
  // text that is already there.
  const handle = await mount('draft')
  await act(async () => {
    composerEditor(container).commands.setTextSelection(1)
  })
  await act(async () => handle.update((current) => current))
  await settle()
  assert.equal(caretAtEnd(), true, 'the caret is not at the end')
  assert.equal(document.activeElement === composerEditor(container).view.dom, true, 'the composer does not have focus')
})
