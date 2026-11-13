import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import type { Editor as EditorType } from '@tiptap/core'

import { installTestDom } from '../test-dom'

// The editor draws into the DOM, so these tests need one.
let Editor: typeof import('@tiptap/core').Editor
let TextSelection: typeof import('@tiptap/pm/state').TextSelection
let model: typeof import('@tiptap/pm/model')
let editorModule: typeof import('./markdown-editor')
let hint: typeof import('./markdown-editor-hint')
let hintMark: typeof import('./markdown-editor-hint-mark')
let inlineEdit: typeof import('./markdown-editor-inline-edit')

before(async () => {
  installTestDom()
  ;({ Editor } = await import('@tiptap/core'))
  ;({ TextSelection } = await import('@tiptap/pm/state'))
  model = await import('@tiptap/pm/model')
  editorModule = await import('./markdown-editor')
  hint = await import('./markdown-editor-hint')
  hintMark = await import('./markdown-editor-hint-mark')
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

/** The document position of the first icon. */
function iconAt(editor: EditorType): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === 'markdownIcon') {
      found = pos
    }
    return found < 0
  })
  assert.ok(found >= 0, 'an icon is in the document')
  return found
}

function select(editor: EditorType, from: number, to = from) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, from, to)))
}

function target(editor: EditorType) {
  return inlineEdit.inlineEditTarget(editor.state)
}

/** Puts a hint with `text` over the selection, as the popover's Apply does. */
function addHint(editor: EditorType, text: string) {
  assert.equal(hint.editHint(editor), true)
  assert.equal(hint.applyHint(editor, text), true)
}

test('a selected word opens the popover with an empty note, and Apply writes the hint', () => {
  const editor = open('one word here')
  select(editor, at(editor, 'word'), at(editor, 'word', 4))
  assert.equal(hint.editHint(editor), true)
  assert.deepEqual(target(editor), {
    kind: 'hint',
    from: at(editor, 'word'),
    to: at(editor, 'word', 4),
    values: { text: '' },
    existing: false,
  })
  assert.equal(hint.applyHint(editor, 'A note'), true)
  assert.equal(editorModule.readMarkdown(editor), 'one :hint[word]{text="A note"} here')
  assert.equal(target(editor), null)
  assert.equal(editor.state.selection.from, at(editor, 'word', 4))
  editor.destroy()
})

test('a hint over formatted text, an icon and an emoji is written as one, and reads back whole', () => {
  const editor = open('Ship **today** :icon[rocket]{color=primary} 🚀 please')
  select(editor, at(editor, 'today'), at(editor, ' please'))
  addHint(editor, 'Before the freeze')
  const markdown = editorModule.readMarkdown(editor)
  assert.equal(markdown, 'Ship :hint[**today** :icon[rocket]{color=primary} 🚀]{text="Before the freeze"} please')
  const reopened = open(markdown)
  assert.equal(editorModule.readMarkdown(reopened), markdown)
  // Every node it covers carries the hint, the icon included.
  select(reopened, iconAt(reopened))
  hint.editHint(reopened)
  assert.deepEqual(target(reopened), {
    kind: 'hint',
    from: at(reopened, 'today'),
    to: at(reopened, ' please'),
    values: { text: 'Before the freeze' },
    existing: true,
  })
  editor.destroy()
  reopened.destroy()
})

test('a hint on a word inside bold, strikethrough or a link sits inside it, and the run stays whole', () => {
  for (const [markdown, word, expected] of [
    ['**ship today please**', 'today', '**ship :hint[today]{text="N"} please**'],
    ['~~one two three~~', 'two', '~~one :hint[two]{text="N"} three~~'],
    ['[a link here](https://example.com)', 'link', '[a :hint[link]{text="N"} here](https://example.com)'],
    ['a **bold** b', 'old', 'a **b:hint[old]{text="N"}** b'],
  ]) {
    const editor = open(markdown)
    select(editor, at(editor, word), at(editor, word, word.length))
    addHint(editor, 'N')
    assert.equal(editorModule.readMarkdown(editor), expected)
    const reopened = open(expected)
    assert.equal(editorModule.readMarkdown(reopened), expected)
    editor.destroy()
    reopened.destroy()
  }
})

test('a hint over the whole of a bold word or a link goes around it', () => {
  for (const [markdown, word, expected] of [
    ['a **bold** b', 'bold', 'a :hint[**bold**]{text="N"} b'],
    ['a [link](https://example.com) b', 'link', 'a :hint[[link](https://example.com)]{text="N"} b'],
  ]) {
    const editor = open(markdown)
    select(editor, at(editor, word), at(editor, word, word.length))
    addHint(editor, 'N')
    assert.equal(editorModule.readMarkdown(editor), expected)
    const reopened = open(expected)
    assert.equal(editorModule.readMarkdown(reopened), expected)
    editor.destroy()
    reopened.destroy()
  }
})

test('inline code takes a hint, alone, among other text, or in part', () => {
  for (const [from, to, expected] of [
    ['code', 'code', 'a :hint[`code`]{text="N"} b'],
    ['a ', ' b', ':hint[a `code` b]{text="N"}'],
    ['od', 'od', 'a `c`:hint[`od`]{text="N"}`e` b'],
  ]) {
    const editor = open('a `code` b')
    select(editor, at(editor, from), at(editor, to, to.length))
    addHint(editor, 'N')
    assert.equal(editorModule.readMarkdown(editor), expected)
    const reopened = open(expected)
    assert.equal(editorModule.readMarkdown(reopened), expected)
    editor.destroy()
    reopened.destroy()
  }
})

test('inline code shuts out every other mark but a hint', () => {
  const editor = open('a')
  const code = editor.schema.marks.code
  const others = Object.values(editor.schema.marks).filter((mark) => mark !== code)
  assert.ok(others.some((mark) => mark.name === 'bold'))
  assert.ok(others.some((mark) => mark.name === hintMark.HINT_MARK))
  for (const mark of others) {
    assert.equal(code.excludes(mark), mark.name !== hintMark.HINT_MARK, mark.name)
  }
  editor.destroy()
})

test('an icon or an image carries its hint as an attribute, text as a mark', () => {
  const markdown = 'a :hint[x :icon[star] ![alt](/i.png)]{text="N"} b'
  const editor = open(markdown)
  const carried: [string, string | null, string[]][] = []
  editor.state.doc.descendants((node) => {
    if (node.isInline) {
      carried.push([node.type.name, (node.attrs.hint as string | null | undefined) ?? null, node.marks.map((mark) => mark.type.name)])
    }
  })
  assert.deepEqual(carried, [
    ['text', null, []],
    ['text', null, [hintMark.HINT_MARK]],
    ['markdownIcon', 'N', []],
    ['text', null, [hintMark.HINT_MARK]],
    ['markdownImage', 'N', []],
    ['text', null, []],
  ])
  assert.equal(editorModule.readMarkdown(editor), markdown)
  editor.destroy()
})

test('hinted text, icons and images survive the HTML that copy and paste go through', () => {
  const markdown = 'Just :hint[:icon[star]]{text="Star"} here, :hint[today :icon[rocket]]{text="Soon"} and :hint[![alt](/i.png)]{text="Pic"} end'
  const editor = open(markdown)
  const { schema } = editor.state
  const html = document.createElement('div')
  html.appendChild(model.DOMSerializer.fromSchema(schema).serializeFragment(editor.state.doc.content))
  const pasted = model.DOMParser.fromSchema(schema).parseSlice(html)
  assert.deepEqual(pasted.content.toJSON(), editor.state.doc.content.toJSON())
  editor.destroy()
})

test('a hint over an icon alone is kept', () => {
  const editor = open('Go :icon[rocket] now')
  select(editor, iconAt(editor), iconAt(editor) + 1)
  addHint(editor, 'Launch')
  assert.equal(editorModule.readMarkdown(editor), 'Go :hint[:icon[rocket]]{text="Launch"} now')
  editor.destroy()
})

test('quotes, ampersands and brackets survive a round trip, in the note and in the content', () => {
  const editor = open('a [b] c')
  select(editor, at(editor, '[b]'), at(editor, '[b]', 3))
  addHint(editor, 'Say "hi" & <go> } ]\n  now')
  const markdown = editorModule.readMarkdown(editor)
  assert.equal(markdown, 'a :hint[\\[b\\]]{text="Say &quot;hi&quot; &amp; <go> } ] now"} c')
  const reopened = open(markdown)
  assert.equal(editorModule.readMarkdown(reopened), markdown)
  select(reopened, at(reopened, 'b'))
  hint.editHint(reopened)
  assert.equal(target(reopened)?.values.text, 'Say "hi" & <go> } ] now')
  editor.destroy()
  reopened.destroy()
})

test('a caret inside a hint edits the whole hint, filled with its note', () => {
  const editor = open('see :hint[the *guide*]{text="Old"} now')
  select(editor, at(editor, 'guide', 2))
  hint.editHint(editor)
  assert.deepEqual(target(editor), {
    kind: 'hint',
    from: at(editor, 'the '),
    to: at(editor, 'guide', 5),
    values: { text: 'Old' },
    existing: true,
  })
  hint.applyHint(editor, 'New')
  assert.equal(editorModule.readMarkdown(editor), 'see :hint[the *guide*]{text="New"} now')
  editor.destroy()
})

test('removing a hint leaves its content as it was', () => {
  const editor = open('see :hint[the *guide*]{text="Old"} now')
  select(editor, at(editor, 'the', 1))
  hint.editHint(editor)
  assert.equal(hint.removeHint(editor), true)
  assert.equal(editorModule.readMarkdown(editor), 'see the *guide* now')
  assert.equal(target(editor), null)
  editor.destroy()
})

test('a caret outside any hint has nothing to put one on, and a read-only editor opens none', () => {
  const editor = open('one word here')
  select(editor, at(editor, 'word', 2))
  assert.equal(hint.hintTarget(editor.state), null)
  assert.equal(hint.editHint(editor), false)
  select(editor, at(editor, 'word'), at(editor, 'word', 4))
  editor.setEditable(false)
  assert.equal(hint.editHint(editor), false)
  assert.equal(target(editor), null)
  editor.destroy()
})

test('a note of only whitespace writes nothing and leaves the popover open', () => {
  const editor = open('one word here')
  select(editor, at(editor, 'word'), at(editor, 'word', 4))
  hint.editHint(editor)
  assert.equal(hint.applyHint(editor, '  '), false)
  assert.equal(editorModule.readMarkdown(editor), 'one word here')
  assert.equal(target(editor)?.kind, 'hint')
  editor.destroy()
})

test('cancelling changes nothing', () => {
  const editor = open('one word here')
  select(editor, at(editor, 'word'), at(editor, 'word', 4))
  hint.editHint(editor)
  inlineEdit.cancelInlineEdit(editor)
  assert.equal(target(editor), null)
  assert.equal(editorModule.readMarkdown(editor), 'one word here')
  editor.destroy()
})

test('text typed right after a hint is outside it', () => {
  const editor = open('a :hint[word]{text="n"} b')
  select(editor, at(editor, 'word', 4))
  editor.commands.insertContent('s')
  assert.equal(editorModule.readMarkdown(editor), 'a :hint[word]{text="n"}s b')
  editor.destroy()
})

test('a hint with no note reads as its content alone', () => {
  const editor = open('a :hint[**b**] c')
  assert.equal(editorModule.readMarkdown(editor), 'a **b** c')
  editor.destroy()
})
