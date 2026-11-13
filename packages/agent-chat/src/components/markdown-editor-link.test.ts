import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import type { Editor as EditorType } from '@tiptap/core'

import { installTestDom } from '../test-dom'

// The editor draws into the DOM, so these tests need one.
let Editor: typeof import('@tiptap/core').Editor
let TextSelection: typeof import('@tiptap/pm/state').TextSelection
let editorModule: typeof import('./markdown-editor')
let link: typeof import('./markdown-editor-link')
let inlineEdit: typeof import('./markdown-editor-inline-edit')

before(async () => {
  installTestDom()
  ;({ Editor } = await import('@tiptap/core'))
  ;({ TextSelection } = await import('@tiptap/pm/state'))
  editorModule = await import('./markdown-editor')
  link = await import('./markdown-editor-link')
  inlineEdit = await import('./markdown-editor-inline-edit')
})

function open(markdown: string): EditorType {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorModule.markdownEditorExtensions({}),
    content: editorModule.markdownContent(markdown),
  })
}

/** The document position of the first `text` in it, plus `offset`. */
function at(editor: EditorType, text: string, offset = 0): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.isText) {
      const index = node.text?.indexOf(text) ?? -1
      if (index >= 0) {
        found = pos + index + offset
      }
    }
    return found < 0
  })
  assert.ok(found >= 0, `"${text}" is in the document`)
  return found
}

function select(editor: EditorType, from: number, to = from) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
}

function selectWord(editor: EditorType, word: string) {
  select(editor, at(editor, word), at(editor, word, word.length))
}

function target(editor: EditorType) {
  return inlineEdit.inlineEditTarget(editor.state)
}

test('a selected word opens the popover with the word as its text and no address', () => {
  const editor = open('one word here')
  selectWord(editor, 'word')
  assert.equal(link.editLink(editor), true)
  assert.deepEqual(target(editor), {
    kind: 'link',
    from: at(editor, 'word'),
    to: at(editor, 'word', 4),
    values: { text: 'word', href: '' },
    existing: false,
  })
  editor.destroy()
})

test('applying the address links the selected word, and the markdown says so', () => {
  const editor = open('one word here')
  selectWord(editor, 'word')
  link.editLink(editor)
  assert.equal(link.applyLink(editor, 'word', 'https://example.com'), true)
  assert.equal(editorModule.readMarkdown(editor), 'one [word](https://example.com) here')
  assert.equal(target(editor), null)
  // The caret is after the link.
  assert.equal(editor.state.selection.empty, true)
  assert.equal(editor.state.selection.from, at(editor, 'word', 4))
  editor.destroy()
})

test('changed text replaces the selection and keeps its formatting', () => {
  const editor = open('one **bold** here')
  selectWord(editor, 'bold')
  link.editLink(editor)
  link.applyLink(editor, 'strong', 'https://example.com')
  assert.equal(editorModule.readMarkdown(editor), 'one [**strong**](https://example.com) here')
  editor.destroy()
})

test('unchanged text keeps the formatting inside the selection', () => {
  const editor = open('one **bold** and plain here')
  select(editor, at(editor, 'bold'), at(editor, 'plain', 5))
  link.editLink(editor)
  assert.equal(target(editor)?.values.text, 'bold and plain')
  link.applyLink(editor, 'bold and plain', 'https://example.com')
  assert.equal(editorModule.readMarkdown(editor), 'one [**bold** and plain](https://example.com) here')
  editor.destroy()
})

test('at a caret the popover starts empty and applying inserts the link there', () => {
  const editor = open('before after')
  select(editor, at(editor, ' after'))
  link.editLink(editor)
  assert.deepEqual(target(editor)?.values, { text: '', href: '' })
  link.applyLink(editor, 'the docs', 'https://example.com/docs')
  assert.equal(editorModule.readMarkdown(editor), 'before[the docs](https://example.com/docs) after')
  editor.destroy()
})

test('with no text the address is the text', () => {
  const editor = open('before after')
  select(editor, at(editor, ' after'))
  link.editLink(editor)
  link.applyLink(editor, '', 'https://example.com')
  assert.equal(editorModule.readMarkdown(editor), 'before<https://example.com> after')
  editor.destroy()
})

test('a caret inside a link edits the whole link, filled with its text and address', () => {
  const editor = open('see [the guide](https://example.com/guide) now')
  select(editor, at(editor, 'guide', 2))
  link.editLink(editor)
  assert.deepEqual(target(editor), {
    kind: 'link',
    from: at(editor, 'the guide'),
    to: at(editor, 'the guide', 9),
    values: { text: 'the guide', href: 'https://example.com/guide' },
    existing: true,
  })
  link.applyLink(editor, 'the manual', 'https://example.com/manual')
  assert.equal(editorModule.readMarkdown(editor), 'see [the manual](https://example.com/manual) now')
  editor.destroy()
})

test('removing a link leaves its text as plain text', () => {
  const editor = open('see [the guide](https://example.com/guide) now')
  select(editor, at(editor, 'guide', 2))
  link.editLink(editor)
  assert.equal(link.removeLink(editor), true)
  assert.equal(editorModule.readMarkdown(editor), 'see the guide now')
  assert.equal(target(editor), null)
  editor.destroy()
})

test('cancelling changes nothing and keeps the selection', () => {
  const editor = open('one word here')
  selectWord(editor, 'word')
  link.editLink(editor)
  inlineEdit.cancelInlineEdit(editor)
  assert.equal(target(editor), null)
  assert.equal(editorModule.readMarkdown(editor), 'one word here')
  assert.deepEqual([editor.state.selection.from, editor.state.selection.to], [at(editor, 'word'), at(editor, 'word', 4)])
  editor.destroy()
})

test('an address the link refuses writes nothing and leaves the popover open', () => {
  const editor = open('one word here')
  selectWord(editor, 'word')
  link.editLink(editor)
  assert.equal(link.applyLink(editor, 'word', 'javascript:alert(1)'), false)
  assert.equal(editorModule.readMarkdown(editor), 'one word here')
  assert.equal(target(editor)?.kind, 'link')
  editor.destroy()
})

test('the picked text is followed through edits made while the popover is open', () => {
  const editor = open('one word here')
  selectWord(editor, 'word')
  link.editLink(editor)
  // Someone else types at the start of the paragraph meanwhile.
  editor.view.dispatch(editor.state.tr.insertText('so ', at(editor, 'one')))
  link.applyLink(editor, 'word', 'https://example.com')
  assert.equal(editorModule.readMarkdown(editor), 'so one [word](https://example.com) here')
  editor.destroy()
})

test('Mod-K opens the popover, and a read-only editor opens none', () => {
  const editor = open('one word here')
  selectWord(editor, 'word')
  // Through the view's own key handling: TipTap's `keyboardShortcut` command
  // replays only the steps of what the key did, and opening changes no text.
  // Mod is Ctrl here: the test DOM's navigator names no Apple platform.
  const modK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })
  editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, modK))
  assert.equal(target(editor)?.kind, 'link')
  inlineEdit.cancelInlineEdit(editor)
  editor.setEditable(false)
  assert.equal(link.editLink(editor), false)
  assert.equal(target(editor), null)
  editor.destroy()
})
