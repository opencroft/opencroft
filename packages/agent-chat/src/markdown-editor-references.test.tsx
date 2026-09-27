import assert from 'node:assert/strict'
import { afterEach, before, test } from 'node:test'

import type { Editor as EditorType } from '@tiptap/core'

import type { InlineReference, MarkdownReferenceSource } from './components/markdown-references'
import { installTestDom } from './test-dom'

let Editor: typeof import('@tiptap/core').Editor
let editorModule: typeof import('./markdown-editor')
let references: typeof import('./components/markdown-references')
let REFERENCE_REQUEST_DELAY_MS: number

before(async () => {
  installTestDom()
  ;({ Editor } = await import('@tiptap/core'))
  editorModule = await import('./markdown-editor')
  references = await import('./components/markdown-references')
  ;({ REFERENCE_REQUEST_DELAY_MS } = await import('./markdown-editor-references'))
})

afterEach(() => references.installMarkdownReferences(null))

interface Recorded {
  decorated: string[]
  requested: string[][]
}

function install(): Recorded {
  const recorded: Recorded = { decorated: [], requested: [] }
  const source: MarkdownReferenceSource = {
    recognisers: [
      { kind: 'ticket', match: 'text', pattern: /\bT-\d+\b/ },
      { kind: 'page', match: 'url', pattern: 'https://app\\.test/.*' },
    ],
    render: () => null,
    decorate: (reference: InlineReference) => {
      recorded.decorated.push(reference.id)
      return { className: 'chip', attributes: { 'data-ref': reference.kind } }
    },
    request: (refs) => recorded.requested.push(refs.map((ref) => ref.id)),
  }
  references.installMarkdownReferences(source)
  return recorded
}

function open(markdown: string): EditorType {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorModule.markdownEditorExtensions({}),
    content: markdown,
  })
}

const chips = (editor: EditorType) =>
  [...editor.view.dom.querySelectorAll('.chip')].map((node) => `${node.getAttribute('data-ref')}:${node.textContent}`)

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const DOC =
  'Fix T-1 and T-22.\n\n`T-3` stays code.\n\n```\nT-4\n```\n\nSee https://app.test/x and [label](https://app.test/y).'

test('references are styled in place, and the markdown written back is unchanged', () => {
  const plain = open(DOC)
  const expected = editorModule.readMarkdown(plain)
  plain.destroy()
  install()
  const editor = open(DOC)
  assert.deepEqual(chips(editor), ['ticket:T-1', 'ticket:T-22', 'page:https://app.test/x'])
  assert.equal(editorModule.readMarkdown(editor), expected)
  editor.destroy()
})

test('typing rescans only the block it changed', () => {
  const recorded = install()
  const editor = open('First T-1.\n\nSecond T-2.\n\nThird T-3.')
  recorded.decorated.length = 0
  // The end of the last paragraph.
  editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' and T-9')
  assert.deepEqual(recorded.decorated.sort(), ['T-3', 'T-9'])
  assert.deepEqual(chips(editor), ['ticket:T-1', 'ticket:T-2', 'ticket:T-3', 'ticket:T-9'])
  editor.destroy()
})

test('resolving waits for typing to pause, then asks once for what is there', async () => {
  const recorded = install()
  const editor = open('Start')
  await wait(REFERENCE_REQUEST_DELAY_MS + 50)
  recorded.requested.length = 0
  for (const char of ' T-123') {
    // As typed: plain text, not content parsed as markdown.
    editor.view.dispatch(editor.state.tr.insertText(char, editor.state.doc.content.size - 1))
    await wait(20)
  }
  assert.deepEqual(recorded.requested, [])
  await wait(REFERENCE_REQUEST_DELAY_MS + 50)
  assert.deepEqual(recorded.requested, [['T-123']])
  editor.destroy()
})

test('with nothing installed the editor decorates nothing', () => {
  const editor = open(DOC)
  assert.deepEqual(chips(editor), [])
  editor.destroy()
})

test('a source installed after the editor opened decorates what is already there', () => {
  const editor = open('Fix T-1.')
  assert.deepEqual(chips(editor), [])
  install()
  assert.deepEqual(chips(editor), ['ticket:T-1'])
  editor.destroy()
})
