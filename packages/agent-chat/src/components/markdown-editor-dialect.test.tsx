import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { installTestDom } from '../test-dom'

// The editor in each dialect, on text an agent reads as written: its lines,
// its placeholders and a word in angle brackets.
let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownEditor: typeof import('./markdown-editor').MarkdownEditor

before(async () => {
  container = installTestDom()
  ;({ act } = await import('react'))
  ;({ MarkdownEditor } = await import('./markdown-editor'))
  ;({ createRoot } = await import('react-dom/client'))
})

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(unmount)

/** Mount a fresh editor on `markdown`, in `dialect` (the default when absent). */
async function mount(markdown: string, dialect?: 'document' | 'agent') {
  await unmount()
  const next = createRoot(container)
  root = next
  const changes: string[] = []
  await act(async () => {
    next.render(<MarkdownEditor value={markdown} onChange={(changed) => changes.push(changed)} dialect={dialect} />)
  })
  // The editor is created after the first render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const element = container.querySelector('.ProseMirror') as
    | (HTMLElement & { editor?: import('@tiptap/core').Editor })
    | null
  assert.ok(element?.editor, 'the editor is mounted')
  return { editor: element.editor, changes }
}

const STORED = '{{task.key}}: {{task.summary}}\nRead the \\<file> named in {{steps.review.summary}}.'

test('in the agent dialect, opening the stored text reports no edit', async () => {
  const { changes } = await mount(STORED, 'agent')
  assert.deepEqual(changes, [])
})

test('in the agent dialect, an edit keeps the lines, the placeholders and the escaped word as written', async () => {
  const { editor, changes } = await mount(STORED, 'agent')
  await act(async () => {
    editor.chain().focus('end').insertContent(' Done').run()
  })
  assert.deepEqual(changes, [`${STORED} Done`])
})

test('in the agent dialect, a word typed in angle brackets is written with one backslash', async () => {
  const { editor, changes } = await mount('', 'agent')
  await act(async () => {
    // As text: a string would be read as HTML, the word as a tag.
    editor.chain().focus('end').insertContent({ type: 'text', text: 'name the <word> here' }).run()
  })
  assert.equal(changes.at(-1), 'name the \\<word> here')
})

test('in the document dialect, the same edit joins the lines and writes the word as entities', async () => {
  // What the agent dialect is for: without it, the first edit rewrites what the agent reads.
  const { editor, changes } = await mount(STORED)
  await act(async () => {
    editor.chain().focus('end').insertContent(' Done').run()
  })
  assert.deepEqual(changes, [
    '{{task.key}}: {{task.summary}} Read the &lt;file&gt; named in {{steps.review.summary}}. Done',
  ])
})
