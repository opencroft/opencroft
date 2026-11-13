// The host's `MarkdownEditor`, the one `@opencroft/client/markdown` hands an
// extension, behind its load boundary: `dialect` reaches the editor it defers.
//
// WHAT THIS DOES NOT COVER: pasting, which jsdom has no clipboard for; the
// paste reader the dialect brings is the composer's, covered in agent-chat.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'

import { installDomEnvironment } from '@/test-support/dom-environment'

const dom = await installDomEnvironment()
// What TipTap reaches beyond the document: it parses through `DOMParser` and
// measures through `getComputedStyle`.
const globals = globalThis as unknown as Record<string, unknown>
for (const name of ['DOMParser', 'getComputedStyle', 'HTMLInputElement', 'Event', 'KeyboardEvent', 'MouseEvent']) {
  globals[name] = (window as unknown as Record<string, unknown>)[name]
}

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MarkdownEditor } = await import('./markdown-editor')

let root: import('react-dom/client').Root | null = null

async function unmount() {
  const current = root
  root = null
  if (current) {
    await act(async () => current.unmount())
  }
}

after(async () => {
  await unmount()
  dom.cleanup()
})

/** Mount the host's editor on `markdown` and wait for the editor it loads. */
async function mount(markdown: string, dialect?: 'document' | 'agent') {
  await unmount()
  const next = createRoot(dom.container)
  root = next
  const changes: string[] = []
  await act(async () => {
    next.render(<MarkdownEditor value={markdown} onChange={(changed) => changes.push(changed)} dialect={dialect} />)
  })
  type EditorElement = HTMLElement & { editor?: import('@tiptap/core').Editor }
  let element: EditorElement | null = null
  // The editor module arrives through a dynamic import, then the editor is created after a render.
  for (let attempt = 0; attempt < 200 && !element?.editor; attempt++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    element = dom.container.querySelector('.ProseMirror') as EditorElement | null
  }
  assert.ok(element?.editor, 'the deferred editor is mounted')
  return { element, editor: element.editor, changes }
}

/** Line breaks in the text, not the one ProseMirror puts in an empty block for the caret. */
const lineBreaks = (element: HTMLElement) => element.querySelectorAll('br:not(.ProseMirror-trailingBreak)').length

async function typeAtEnd(editor: import('@tiptap/core').Editor, text: string) {
  await act(async () => {
    editor.chain().focus('end').insertContent({ type: 'text', text }).run()
  })
}

test("with dialect 'agent', a single newline loads as a line break and is written back as one", async () => {
  const { element, editor, changes } = await mount('line one\nline two', 'agent')
  assert.equal(lineBreaks(element), 1, 'the two lines are drawn as two')
  assert.deepEqual(changes, [], 'opening the text reports no edit')
  await typeAtEnd(editor, ' and more')
  assert.deepEqual(changes, ['line one\nline two and more'])
})

test('without a dialect, the same newline is a space', async () => {
  const { element, editor, changes } = await mount('line one\nline two')
  assert.equal(lineBreaks(element), 0)
  await typeAtEnd(editor, ' and more')
  assert.deepEqual(changes, ['line one line two and more'])
})
