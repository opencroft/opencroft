// What a controlled editor reports when someone ends a list at the end of the
// text, in the field with the agent dialect and in the toolbar look: the
// empty paragraphs left below the list are no part of the markdown, the value
// the caller passes back is what the editor already holds, and a value loaded
// from outside is never reported.

import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { composerEditor, installComposerDom, pressKey, typeText } from '../test-composer'
import type { MarkdownEditorVariant } from './markdown-editor-frame'

let root: import('react-dom/client').Root | null = null
let container: HTMLElement
let act: typeof import('react').act
let createRoot: typeof import('react-dom/client').createRoot
let MarkdownEditor: typeof import('./markdown-editor').MarkdownEditor

before(async () => {
  container = installComposerDom()
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

interface Look {
  variant: MarkdownEditorVariant
  dialect: 'agent' | 'document'
}

const LOOKS: Look[] = [
  { variant: 'field', dialect: 'agent' },
  { variant: 'toolbar', dialect: 'document' },
]

/** Mount a fresh editor on `markdown`; `render` passes it a new value, as its caller would. */
async function mount({ variant, dialect }: Look, markdown: string) {
  await unmount()
  const next = createRoot(container)
  root = next
  const changes: string[] = []
  const render = (value: string) =>
    act(async () => {
      next.render(
        <MarkdownEditor
          value={value}
          onChange={(changed) => changes.push(changed)}
          variant={variant}
          dialect={dialect}
        />,
      )
    })
  await render(markdown)
  // The editor is created after the first render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { editor: composerEditor(container), changes, render }
}

/** `- a`, Enter, `b`, Enter, Enter: a list of two items, and the caret on the line below it. */
async function writeListAndLeaveIt(editor: import('@tiptap/core').Editor) {
  await typeText(container, '- a')
  await pressKey(container, 'Enter')
  await act(async () => {
    editor.commands.insertContent('b')
  })
  await pressKey(container, 'Enter')
  await pressKey(container, 'Enter')
}

for (const look of LOOKS) {
  const name = `${look.variant}, ${look.dialect} dialect`

  test(`${name}: ending a list reports the list alone, and text typed below it follows a blank line`, async () => {
    const { editor, changes } = await mount(look, '')
    await writeListAndLeaveIt(editor)
    assert.equal(editor.state.selection.$head.parent.type.name, 'paragraph', 'the caret is out of the list')
    assert.equal(changes.at(-1), '- a\n- b')
    await act(async () => {
      editor.commands.insertContent('c')
    })
    assert.equal(changes.at(-1), '- a\n- b\n\nc')
  })

  test(`${name}: the reported value passed back is neither loaded nor reported, and the caret stays`, async () => {
    const { editor, changes, render } = await mount(look, '')
    await writeListAndLeaveIt(editor)
    const reported = changes.length
    const doc = editor.state.doc
    const caret = editor.state.selection.from
    await render(changes[reported - 1])
    assert.equal(editor.state.doc, doc, 'the document is the one the editor held')
    assert.equal(editor.state.selection.from, caret)
    assert.equal(changes.length, reported)
  })

  test(`${name}: a value loaded from outside, a list at its end or not, is never reported`, async () => {
    const { changes, render } = await mount(look, '- a\n- b')
    await render('- a\n- b\n\nc')
    await render('- a\n- b')
    assert.deepEqual(changes, [])
  })
}
