import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import type { Editor as EditorType } from '@tiptap/core'
import { renderToStaticMarkup } from 'react-dom/server'

import { installTestDom } from './test-dom'

// The editor parses markdown through the DOM, so these tests need one.
let Editor: typeof import('@tiptap/core').Editor
let TextSelection: typeof import('@tiptap/pm/state').TextSelection
let editorModule: typeof import('./markdown-editor')
let blocks: typeof import('./markdown-editor-blocks')
let inserts: typeof import('./markdown-editor-block-inserts')
let slash: typeof import('./markdown-editor-slash-menu')
let Markdown: typeof import('./components/markdown').Markdown

before(async () => {
  installTestDom()
  ;({ Editor } = await import('@tiptap/core'))
  ;({ TextSelection } = await import('@tiptap/pm/state'))
  editorModule = await import('./markdown-editor')
  blocks = await import('./markdown-editor-blocks')
  inserts = await import('./markdown-editor-block-inserts')
  slash = await import('./markdown-editor-slash-menu')
  ;({ Markdown } = await import('./components/markdown'))
})

function open(markdown: string, slashMenu?: import('./markdown-editor-slash-menu').SlashMenuStore): EditorType {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorModule.markdownEditorExtensions({ slashMenu }),
    content: markdown,
  })
}

/** What the editor writes back for a document it was given. */
function roundTrip(markdown: string): string {
  const editor = open(markdown)
  const out = editorModule.readMarkdown(editor)
  editor.destroy()
  return out
}

function nodeNames(editor: EditorType): string[] {
  const names: string[] = []
  editor.state.doc.descendants((node) => {
    names.push(node.type.name)
  })
  return names
}

test('every callout kind opens as a callout and is written back in attribute form', () => {
  for (const kind of ['note', 'tip', 'important', 'warning', 'caution']) {
    const editor = open(`:::${kind}\nBody.\n:::`)
    const callout = editor.state.doc.firstChild
    assert.equal(callout?.type.name, 'markdownCallout', kind)
    assert.equal(callout?.attrs.kind, kind)
    assert.equal(editorModule.readMarkdown(editor), `:::${kind}\nBody.\n\n:::`)
    editor.destroy()
  }
})

test('a title survives the round trip, including quotes and ampersands', () => {
  assert.equal(
    roundTrip(':::warning{title="Before you upgrade"}\nBack up.\n:::'),
    ':::warning{title="Before you upgrade"}\nBack up.\n\n:::',
  )
  const tricky = roundTrip(':::tip{title="Say &quot;hi&quot; & wave"}\nx\n:::')
  assert.equal(tricky, ':::tip{title="Say &quot;hi&quot; &amp; wave"}\nx\n\n:::')
  // And the renderer reads what the editor wrote as the same title.
  assert.match(
    renderToStaticMarkup(<Markdown text={tricky} />),
    /<span class="flex-1">Say &quot;hi&quot; &amp; wave<\/span>/,
  )
})

test('a label becomes the heading, written back as the attribute', () => {
  assert.equal(roundTrip(':::note[Heads *up*]\nBody.\n:::'), ':::note{title="Heads up"}\nBody.\n\n:::')
  assert.equal(roundTrip(':::details[Full log]\nx\n:::'), ':::details{summary="Full log"}\nx\n\n:::')
})

test('details and tabs round-trip, with the outer fence one colon longer', () => {
  assert.equal(roundTrip(':::details{summary="Log"}\nline\n:::'), ':::details{summary="Log"}\nline\n\n:::')
  const tabs = '::::tabs\n:::tab{label="npm"}\n`npm i`\n:::\n:::tab{label="pnpm"}\n`pnpm add`\n:::\n::::'
  const editor = open(tabs)
  assert.deepEqual(nodeNames(editor).slice(0, 3), ['markdownTabs', 'markdownTab', 'paragraph'])
  assert.equal(
    editorModule.readMarkdown(editor),
    '::::tabs\n:::tab{label="npm"}\n`npm i`\n\n:::\n\n:::tab{label="pnpm"}\n`pnpm add`\n\n:::\n\n::::',
  )
  editor.destroy()
})

test('nesting decides the colons: a tip inside a tab inside tabs inside a warning', () => {
  // Written with more colons than it needs; the editor writes the fewest that
  // still nest: three for the innermost, one more per level outwards.
  const out = roundTrip(
    [
      ':::::::::warning',
      ':::::::tabs',
      ':::::tab{label="Linux"}',
      ':::tip',
      'deep',
      ':::',
      ':::::',
      ':::::::',
      ':::::::::',
    ].join('\n'),
  )
  assert.equal(out, '::::::warning\n:::::tabs\n::::tab{label="Linux"}\n:::tip\ndeep\n\n:::\n\n::::\n\n:::::\n\n::::::')
})

test('an unknown directive is kept exactly: name, label and attributes', () => {
  const editor = open(':::someday[Later]{a=b .c #d}\nStill **here**.\n:::')
  assert.equal(editor.state.doc.firstChild?.type.name, 'markdownDirective')
  assert.equal(editorModule.readMarkdown(editor), ':::someday[Later]{a=b .c #d}\nStill **here**.\n\n:::')
  editor.destroy()
})

test('tabs holding anything besides tabs, and a tab on its own, are kept as unknown directives', () => {
  const stray = open('::::tabs\nstray\n:::tab{label="A"}\ninside\n:::\n::::')
  assert.ok(!nodeNames(stray).includes('markdownTabs'))
  assert.equal(editorModule.readMarkdown(stray), '::::tabs\nstray\n\n:::tab{label="A"}\ninside\n\n:::\n\n::::')
  stray.destroy()
  assert.equal(roundTrip(':::tab{label="A"}\nalone\n:::'), ':::tab{label="A"}\nalone\n\n:::')
})

test('a body line of colons stays text in its block across a save and a reopen', () => {
  // Typed into the body, a line of exactly `:::` (or `::::`) would otherwise
  // be written plain and read back as a fence, dropping what follows out of
  // the block. It is written with its first colon escaped instead.
  for (const colons of [':::', '::::']) {
    const editor = open(':::note\nbefore\n:::')
    let end = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'before') {
        end = pos + node.nodeSize
      }
    })
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)))
    editor.commands.splitBlock()
    type(editor, `${colons}`)
    editor.commands.splitBlock()
    type(editor, 'after')
    const saved = editorModule.readMarkdown(editor)
    assert.equal(saved, `:::note\nbefore\n\n\\${colons}\n\nafter\n\n:::`, colons)
    editor.destroy()

    // Reopened, it is the same one callout holding all three paragraphs.
    const reopened = open(saved)
    assert.equal(reopened.state.doc.childCount, 1, colons)
    assert.deepEqual(
      reopened.state.doc.firstChild?.content.content.map((paragraph) => paragraph.textContent),
      ['before', colons, 'after'],
    )
    assert.equal(editorModule.readMarkdown(reopened), saved)
    reopened.destroy()

    // And the renderer reads the saved text the same way.
    const html = renderToStaticMarkup(<Markdown text={saved} />)
    assert.equal((html.match(/role="note"/g) ?? []).length, 1)
    assert.match(html, new RegExp(`<p>${colons}</p><p>after</p>`))
  }
})

test('after a hard break, a line of colons is escaped too; mid-line colons are left alone', () => {
  const editor = open('')
  editor.commands.focus('end')
  type(editor, 'first')
  editor.commands.setHardBreak()
  type(editor, ':::')
  assert.equal(editorModule.readMarkdown(editor), 'first\\\n\\:::')
  editor.destroy()
  assert.equal(roundTrip('ratio a::: b'), 'ratio a::: b')
})

test('text around the blocks is untouched, and text directives stay text', () => {
  assert.equal(
    roundTrip('See file:README.\n\n:::note\nx\n:::\n\nAfter.'),
    'See file:README.\n\n:::note\nx\n\n:::\n\nAfter.',
  )
})

test('the Blocks list is the expected list, in order, and each entry inserts its block', () => {
  assert.deepEqual(
    inserts.BLOCK_INSERTS.map((item) => item.label),
    ['Note', 'Tip', 'Important', 'Warning', 'Caution', 'Spoiler', 'Tabs', 'Table', 'Divider'],
  )
  const expected: Record<string, RegExp> = {
    note: /^:::note\n/,
    tip: /^:::tip\n/,
    important: /^:::important\n/,
    warning: /^:::warning\n/,
    caution: /^:::caution\n/,
    spoiler: /^:::details\n/,
    tabs: /^::::tabs\n:::tab\{label="Tab 1"\}\n[\s\S]*:::tab\{label="Tab 2"\}/,
    table: /^\| +\| +\| +\|\n\| -+ \| -+ \| -+ \|/,
    divider: /^---/,
  }
  for (const item of inserts.BLOCK_INSERTS) {
    const editor = open('')
    assert.ok(item.insert(editor.chain().focus()).run(), item.id)
    assert.match(editorModule.readMarkdown(editor), expected[item.id], item.id)
    editor.destroy()
  }
})

test('inserting tabs leaves the caret in the first tab, which is the one shown', () => {
  const editor = open('')
  inserts.BLOCK_INSERTS.find((item) => item.id === 'tabs')
    ?.insert(editor.chain().focus())
    .run()
  const { $from } = editor.state.selection
  assert.equal($from.node($from.depth - 1).type.name, 'markdownTab')
  assert.equal($from.node($from.depth - 1).attrs.heading, 'Tab 1')
  assert.equal(blocks.activeTab(editor.state, 0), 0)
  editor.destroy()
})

test('the shown tab follows the caret', () => {
  const editor = open('::::tabs\n:::tab{label="A"}\none\n:::\n:::tab{label="B"}\ntwo\n:::\n::::')
  assert.equal(blocks.activeTab(editor.state, 0), 0)
  const second = editor.state.doc.firstChild?.child(0).nodeSize ?? 0
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(1 + second + 2))))
  assert.equal(blocks.activeTab(editor.state, 0), 1)
  editor.destroy()
})

test('loading another document starts its tabs on the first tab, whatever the last one showed', () => {
  const tabs = (a: string, b: string) =>
    `::::tabs\n:::tab{label="${a}"}\none\n:::\n:::tab{label="${b}"}\ntwo\n:::\n::::`
  const editor = open(tabs('A', 'B'))
  const second = editor.state.doc.firstChild?.child(0).nodeSize ?? 0
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(1 + second + 2))))
  assert.equal(blocks.activeTab(editor.state, 0), 1)
  editor.commands.setContent(tabs('C', 'D'))
  assert.equal(blocks.activeTab(editor.state, 0), 0)
  editor.destroy()
})

test('the / menu matches by name first, then by keyword', () => {
  assert.equal(inserts.matchBlockInserts('').length, 9)
  assert.deepEqual(
    inserts.matchBlockInserts('war').map((item) => item.label),
    ['Warning'],
  )
  assert.deepEqual(
    inserts.matchBlockInserts('rule').map((item) => item.label),
    ['Divider'],
  )
  // A name starting with the query wins outright; words merely containing it
  // are the fallback when no name does.
  assert.deepEqual(
    inserts.matchBlockInserts('ta').map((item) => item.label),
    ['Tabs', 'Table'],
  )
  assert.deepEqual(
    inserts.matchBlockInserts('callout').map((item) => item.label),
    ['Note', 'Tip', 'Important', 'Warning', 'Caution'],
  )
  assert.deepEqual(
    inserts.matchBlockInserts('details').map((item) => item.label),
    ['Spoiler'],
  )
  assert.deepEqual(inserts.matchBlockInserts('zzz'), [])
})

/** The suggestion plugin resolves its items asynchronously; let it. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Type text the way a keyboard does: each character through the input rules first. */
function type(editor: EditorType, text: string) {
  for (const character of text) {
    const { view } = editor
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (handle) =>
      handle(view, from, to, character, () => view.state.tr.insertText(character, from, to)),
    )
    if (!handled) {
      view.dispatch(view.state.tr.insertText(character, from, to))
    }
  }
}

test('/ on an empty line opens the menu; / inside a sentence does not', async () => {
  const store = slash.createSlashMenuStore()
  const editor = open('', store)
  editor.commands.focus('end')
  type(editor, '/')
  await settle()
  assert.equal(store.get()?.items.length, 9)
  type(editor, 'tab')
  await settle()
  assert.deepEqual(
    store.get()?.items.map((item) => item.label),
    ['Tabs', 'Table'],
  )
  editor.destroy()

  const inSentence = slash.createSlashMenuStore()
  const other = open('', inSentence)
  other.commands.focus('end')
  type(other, 'a/b')
  await settle()
  assert.equal(inSentence.get(), null)
  other.destroy()

  // At the start of a line that already has words on it: not an empty line.
  const onText = slash.createSlashMenuStore()
  const worded = open('hello', onText)
  worded.commands.focus('start')
  type(worded, '/')
  await settle()
  assert.equal(onText.get(), null)
  worded.destroy()
})

test('choosing from the / menu replaces the typed command with the block', async () => {
  const store = slash.createSlashMenuStore()
  const editor = open('', store)
  editor.commands.focus('end')
  type(editor, '/warn')
  await settle()
  const state = store.get()
  assert.ok(state)
  state.choose(state.items[0])
  assert.equal(editorModule.readMarkdown(editor), ':::warning\n\n:::')
  editor.destroy()
})

test('a block body is ordinary editor text: typing in it is saved inside the block', () => {
  for (const [source, saved] of [
    [':::note\nx\n:::', ':::note\nxyz\n\n:::'],
    [':::details{summary="S"}\nx\n:::', ':::details{summary="S"}\nxyz\n\n:::'],
    ['::::tabs\n:::tab{label="A"}\nx\n:::\n::::', '::::tabs\n:::tab{label="A"}\nxyz\n\n:::\n\n::::'],
  ]) {
    const editor = open(source)
    let end = 0
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'x') {
        end = pos + 1
      }
    })
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, end)))
    type(editor, 'yz')
    assert.equal(editorModule.readMarkdown(editor), saved)
    editor.destroy()
  }
})

test('markdown shortcuts at a line start become their blocks', () => {
  const cases: [string, string][] = [
    ['# ', 'heading'],
    ['> ', 'blockquote'],
    ['- ', 'bulletList'],
    ['* ', 'bulletList'],
    ['1. ', 'orderedList'],
    ['``` ', 'codeBlock'],
    ['---', 'horizontalRule'],
  ]
  for (const [typed, node] of cases) {
    const editor = open('')
    editor.commands.focus('end')
    type(editor, typed)
    assert.ok(nodeNames(editor).includes(node), `${JSON.stringify(typed)} -> ${node}: got ${nodeNames(editor)}`)
    editor.destroy()
  }
  const inline = open('')
  inline.commands.focus('end')
  type(inline, 'run `npm test` ')
  assert.match(editorModule.readMarkdown(inline), /`npm test`/)
  assert.ok(inline.state.doc.firstChild?.child(1).marks.some((mark) => mark.type.name === 'code'))
  inline.destroy()
})
