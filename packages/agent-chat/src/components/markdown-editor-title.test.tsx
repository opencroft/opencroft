import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import type { Editor as EditorType } from '@tiptap/core'

import { installTestDom } from '../test-dom'

let Editor: typeof import('@tiptap/core').Editor
let Extension: typeof import('@tiptap/core').Extension
let Plugin: typeof import('@tiptap/pm/state').Plugin
let PluginKey: typeof import('@tiptap/pm/state').PluginKey
let TextSelection: typeof import('@tiptap/pm/state').TextSelection
let editorModule: typeof import('./markdown-editor')

before(async () => {
  installTestDom()
  ;({ Editor, Extension } = await import('@tiptap/core'))
  ;({ Plugin, PluginKey, TextSelection } = await import('@tiptap/pm/state'))
  editorModule = await import('./markdown-editor')
})

function open(markdown: string, titleHeading = true, extra: import('@tiptap/core').AnyExtension[] = []): EditorType {
  return new Editor({
    element: document.createElement('div'),
    extensions: [...editorModule.markdownEditorExtensions({ titleHeading }), ...extra],
    content: editorModule.markdownContent(markdown),
  })
}

/** The document's top-level blocks, without the empty paragraph a document of its own keeps last for the caret. */
function blocks(editor: EditorType): string[] {
  const nodes = editor.state.doc.content.content
  const last = nodes[nodes.length - 1]
  const shown = last?.type.name === 'paragraph' && last.content.size === 0 && nodes.length > 1 ? nodes.slice(0, -1) : nodes
  return shown.map((node) =>
    node.type.name === 'heading' ? `h${node.attrs.level}:${node.textContent}` : `${node.type.name}:${node.textContent}`,
  )
}

test('deleting everything leaves an empty title', () => {
  const editor = open('# Guide\n\nText\n')
  editor.commands.selectAll()
  editor.commands.deleteSelection()
  assert.deepEqual(blocks(editor), ['h1:'])
  editor.destroy()
})

test('the title cannot be made another kind of block', () => {
  const editor = open('# Guide\n\nText\n')
  editor.commands.setTextSelection(2)
  editor.commands.setParagraph()
  assert.deepEqual(blocks(editor), ['h1:Guide', 'paragraph:Text'])
  editor.commands.toggleHeading({ level: 2 })
  assert.deepEqual(blocks(editor), ['h1:Guide', 'paragraph:Text'])
  editor.destroy()
})

test('a block put before the title that is not a paragraph gets a title above it', () => {
  const editor = open('# Guide\n')
  editor.view.dispatch(editor.state.tr.insert(0, editor.schema.nodes.horizontalRule.create()))
  assert.deepEqual(blocks(editor), ['h1:', 'horizontalRule:', 'h1:Guide'])
  editor.destroy()
})

test('opening a document without a title changes nothing until it is edited', () => {
  const editor = open('Just text\n')
  assert.deepEqual(blocks(editor), ['paragraph:Just text'])
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)))
  assert.deepEqual(blocks(editor), ['paragraph:Just text'])
  editor.view.dispatch(editor.state.tr.insertText('!', 10))
  assert.deepEqual(blocks(editor), ['h1:Just text!'])
  editor.destroy()
})

test('a change brought from another editor is not followed up', () => {
  const sync = new PluginKey('y-sync')
  const SyncStandIn = Extension.create({
    name: 'syncStandIn',
    addProseMirrorPlugins: () => [new Plugin({ key: sync })],
  })
  const editor = open('# Guide\n\nText\n', true, [SyncStandIn])
  const tr = editor.state.tr.setNodeMarkup(0, editor.schema.nodes.paragraph)
  tr.setMeta(sync, { isChangeOrigin: true })
  editor.view.dispatch(tr)
  assert.deepEqual(blocks(editor), ['paragraph:Guide', 'paragraph:Text'])
  editor.destroy()
})

test('an empty title says what goes there', () => {
  const editor = open('#\n\nText\n')
  const title = editor.view.dom.querySelector('h1')
  assert.equal(title?.getAttribute('data-placeholder'), 'Title')
  assert.ok(title?.classList.contains('is-title-empty'))
  editor.commands.insertContentAt(1, 'Named')
  assert.equal(editor.view.dom.querySelector('h1')?.getAttribute('data-placeholder'), null)
  editor.destroy()
})

test('without the option the first block is free', () => {
  const editor = open('# Guide\n\nText\n', false)
  editor.commands.setTextSelection(2)
  editor.commands.setParagraph()
  assert.deepEqual(blocks(editor), ['paragraph:Guide', 'paragraph:Text'])
  editor.destroy()
})
