import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import type { Editor as EditorType } from '@tiptap/core'
import { renderToStaticMarkup } from 'react-dom/server'

import type { MentionCandidate } from './mention-autocomplete'
import type { BlockInsert } from './markdown-editor-block-inserts'
import { installTestDom } from '../test-dom'

// The editor draws into the DOM, so these tests need one.
let Editor: typeof import('@tiptap/core').Editor
let Extension: typeof import('@tiptap/core').Extension
let TextSelection: typeof import('@tiptap/pm/state').TextSelection
let NodeSelection: typeof import('@tiptap/pm/state').NodeSelection
let editorModule: typeof import('./markdown-editor')
let blocks: typeof import('./markdown-editor-blocks')
let inserts: typeof import('./markdown-editor-block-inserts')
let menus: typeof import('./markdown-editor-suggestion-menu')
let mentions: typeof import('./markdown-mentions')
let sections: typeof import('./markdown-editor-sections')
let Markdown: typeof import('./markdown').Markdown

before(async () => {
  installTestDom()
  ;({ Editor, Extension } = await import('@tiptap/core'))
  ;({ TextSelection, NodeSelection } = await import('@tiptap/pm/state'))
  editorModule = await import('./markdown-editor')
  blocks = await import('./markdown-editor-blocks')
  inserts = await import('./markdown-editor-block-inserts')
  menus = await import('./markdown-editor-suggestion-menu')
  mentions = await import('./markdown-mentions')
  sections = await import('./markdown-editor-sections')
  ;({ Markdown } = await import('./markdown'))
})

function open(
  markdown: string,
  slashMenu?: import('./markdown-editor-slash-menu').SlashMenuStore,
  mentionMenu?: import('./markdown-editor-mention-menu').MentionMenuStore,
): EditorType {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorModule.markdownEditorExtensions({ slashMenu, mentionMenu }),
    content: editorModule.markdownContent(markdown),
  })
}

/** What the editor writes back for a document it was given. */
function roundTrip(markdown: string): string {
  const editor = open(markdown)
  const out = editorModule.readMarkdown(editor)
  editor.destroy()
  return out
}

/** Types `text` at the end of the document's first textblock, then lists the document's top-level nodes. */
function typeIntoFirstBlock(editor: EditorType, text: string): string[] {
  let end = -1
  editor.state.doc.descendants((node, pos) => {
    if (end < 0 && node.isTextblock) {
      end = pos + 1 + node.content.size
    }
    return end < 0
  })
  editor.view.dispatch(editor.state.tr.insertText(text, end))
  return editor.state.doc.content.content.map((node) => node.type.name)
}

test('an editor of its own document keeps a paragraph after a final block and a history of its own', () => {
  const editor = open(':::note\nx\n:::')
  assert.deepEqual(typeIntoFirstBlock(editor, 'y'), ['markdownCallout', 'paragraph'])
  assert.ok(editor.can().undo())
  editor.destroy()
})

test('an editor of a shared document adds nothing to it and leaves its history to the binding', () => {
  // A binding that keeps no history, so any history left would be the editor's.
  const binding = Extension.create({ name: 'testBinding' })
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorModule.markdownEditorExtensions({ collaboration: [binding] }),
    content: editorModule.markdownContent(':::note\nx\n:::'),
  })
  assert.deepEqual(typeIntoFirstBlock(editor, 'y'), ['markdownCallout'])
  // No undo command at all: the binding brings its own.
  assert.equal('undo' in editor.commands, false)
  editor.destroy()
})

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

const GRID = '::::grid{layout=1/3+2/3}\n:::col\nLeft.\n\n:::\n\n:::col\nRight.\n\n:::\n\n::::'

test('a grid opens as columns under its layout, and what the editor writes it gives back unchanged', () => {
  const editor = open(GRID)
  assert.deepEqual(nodeNames(editor).slice(0, 3), ['markdownGrid', 'markdownGridColumn', 'paragraph'])
  assert.equal(editor.state.doc.firstChild?.attrs.layout, '1/3+2/3')
  assert.equal(editor.state.doc.firstChild?.childCount, 2)
  assert.equal(editorModule.readMarkdown(editor), GRID)
  editor.destroy()
  // Written as the docs show it, without blank lines, it reads the same.
  assert.equal(roundTrip('::::grid{layout=1/3+2/3}\n:::col\nLeft.\n:::\n:::col\nRight.\n:::\n::::'), GRID)
})

test('a layout is written bare, whether it was read quoted or as the label', () => {
  const expected = '::::grid{layout=1/2+1/2}\n:::col\nA\n\n:::\n\n:::col\nB\n\n:::\n\n::::'
  assert.equal(roundTrip('::::grid{layout="1/2+1/2"}\n:::col\nA\n:::\n:::col\nB\n:::\n::::'), expected)
  assert.equal(roundTrip('::::grid[1/2+1/2]\n:::col\nA\n:::\n:::col\nB\n:::\n::::'), expected)
})

test('a grid copied from one editor and pasted into another keeps its layout', () => {
  const source = open(GRID)
  const { dom } = source.view.serializeForClipboard(source.state.doc.slice(0, source.state.doc.content.size))
  const target = open('')
  // jsdom has no ClipboardEvent; a paste only hands its event to the handlers.
  target.view.pasteHTML(dom.innerHTML, new Event('paste') as ClipboardEvent)
  assert.equal(editorModule.readMarkdown(target), GRID)
  source.destroy()
  target.destroy()
})

test('a grid holding anything besides columns, and a column on its own, are kept as unknown directives', () => {
  const stray = open('::::grid{layout=full}\nstray\n:::col\ninside\n:::\n::::')
  assert.ok(!nodeNames(stray).includes('markdownGrid'))
  assert.equal(editorModule.readMarkdown(stray), '::::grid{layout=full}\nstray\n\n:::col\ninside\n\n:::\n\n::::')
  stray.destroy()
  assert.equal(roundTrip(':::col\nalone\n:::'), ':::col\nalone\n\n:::')
})

test('a grid without a layout of its own, or with columns its layout does not have, is kept as written', () => {
  for (const info of ['grid', 'grid{layout=1/2}', 'grid{layout=1/3+2/3}', 'grid{layout="2/3 + 1/3"}']) {
    const source = `::::${info}\n:::col\nA\n:::\n::::`
    const editor = open(source)
    assert.ok(!nodeNames(editor).includes('markdownGrid'), info)
    assert.equal(editorModule.readMarkdown(editor), `::::${info}\n:::col\nA\n\n:::\n\n::::`, info)
    editor.destroy()
  }
})

test('a column holds other blocks, and each fence is as long as its own nesting needs', () => {
  const nested = [
    ':::::grid{layout=1/2+1/2}',
    '::::col',
    ':::tip',
    'Inside.',
    '',
    ':::',
    '',
    '::::',
    '',
    ':::col',
    'Beside it.',
    '',
    ':::',
    '',
    ':::::',
  ].join('\n')
  assert.equal(roundTrip(nested), nested)
})

/** Puts the caret at the start of the grid's column `index`. */
function caretInColumn(editor: EditorType, index: number): void {
  const grid = editor.state.doc.firstChild
  assert.equal(grid?.type.name, 'markdownGrid')
  let pos = 1
  for (let k = 0; k < index; k++) {
    pos += grid.child(k).nodeSize
  }
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 2))))
}

test('inserting a section, writing in it and changing its layout saves markdown that reopens and renders the same', () => {
  const editor = open('')
  assert.equal(sections.sectionLayoutAt(editor.state), undefined)
  sections.chooseSectionLayout(editor, '1/2+1/2')
  // The caret starts in the first column.
  const { $from } = editor.state.selection
  assert.equal($from.node($from.depth - 1).type.name, 'markdownGridColumn')
  assert.equal($from.index($from.depth - 2), 0)
  assert.equal(sections.sectionLayoutAt(editor.state), '1/2+1/2')
  type(editor, 'First')
  caretInColumn(editor, 1)
  type(editor, 'Second')
  sections.chooseSectionLayout(editor, '1/3+2/3')

  const saved = editorModule.readMarkdown(editor)
  editor.destroy()
  assert.equal(saved, '::::grid{layout=1/3+2/3}\n:::col\nFirst\n\n:::\n\n:::col\nSecond\n\n:::\n\n::::')
  assert.equal(roundTrip(saved), saved)
  const html = renderToStaticMarkup(<Markdown text={saved} />)
  assert.match(html, /@3xl:col-span-4[^>]*><p>First<\/p>/)
  assert.match(html, /@3xl:col-span-8[^>]*><p>Second<\/p>/)
})

test('a layout with more blocks adds empty columns at the end, and every layout inserts its count of columns', () => {
  const editor = open('::::grid{layout=1/2+1/2}\n:::col\nA\n:::\n:::col\nB\n:::\n::::')
  caretInColumn(editor, 0)
  sections.chooseSectionLayout(editor, '1/4+1/4+1/4+1/4')
  assert.equal(
    editorModule.readMarkdown(editor),
    '::::grid{layout=1/4+1/4+1/4+1/4}\n:::col\nA\n\n:::\n\n:::col\nB\n\n:::\n\n:::col\n\n:::\n\n:::col\n\n:::\n\n::::',
  )
  editor.destroy()
  for (const layout of ['full', '1/3+2/3', '1/2+1/4+1/4', '1/4+1/4+1/4+1/4'] as const) {
    const fresh = open('')
    sections.chooseSectionLayout(fresh, layout)
    assert.equal(fresh.state.doc.firstChild?.childCount, layout === 'full' ? 1 : layout.split('+').length, layout)
    assert.equal(sections.sectionLayoutAt(fresh.state), layout)
    fresh.destroy()
  }
})

test('a layout with fewer blocks moves what the dropped columns held to the end of the last one kept', () => {
  const editor = open('::::grid{layout=1/3+1/3+1/3}\n:::col\nA\n:::\n:::col\nB\n:::\n:::col\nC\n:::\n::::')
  caretInColumn(editor, 2)
  sections.chooseSectionLayout(editor, '1/2+1/2')
  assert.equal(
    editorModule.readMarkdown(editor),
    '::::grid{layout=1/2+1/2}\n:::col\nA\n\n:::\n\n:::col\nB\n\nC\n\n:::\n\n::::',
  )
  sections.chooseSectionLayout(editor, 'full')
  assert.equal(editorModule.readMarkdown(editor), '::::grid{layout=full}\n:::col\nA\n\nB\n\nC\n\n:::\n\n::::')
  editor.destroy()
})

test('dropped empty columns leave nothing behind, and an empty column kept takes what moves into it', () => {
  const editor = open('')
  sections.chooseSectionLayout(editor, '1/4+1/4+1/4+1/4')
  caretInColumn(editor, 2)
  type(editor, 'Third')
  sections.chooseSectionLayout(editor, '1/2+1/2')
  assert.equal(
    editorModule.readMarkdown(editor),
    '::::grid{layout=1/2+1/2}\n:::col\n\n:::\n\n:::col\nThird\n\n:::\n\n::::',
  )
  editor.destroy()
})

test('a grid an edit leaves with columns its layout does not have is written with the equal layout', () => {
  const editor = open('::::grid{layout=1/4+3/4}\n:::col\nA\n:::\n:::col\nB\n:::\n::::')
  const grid = editor.state.doc.firstChild
  assert.ok(grid)
  const second = 1 + grid.child(0).nodeSize
  editor.view.dispatch(editor.state.tr.delete(second, second + grid.child(1).nodeSize))
  assert.equal(editorModule.readMarkdown(editor), '::::grid{layout=full}\n:::col\nA\n\n:::\n\n::::')
  caretInColumn(editor, 0)
  assert.equal(sections.sectionLayoutAt(editor.state), 'full')
  editor.destroy()
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
    ['Note', 'Tip', 'Important', 'Warning', 'Caution', 'Spoiler', 'Tabs', 'Table', 'Divider', 'Icon'],
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
    icon: /^:icon\[smile\]$/,
  }
  for (const item of inserts.BLOCK_INSERTS) {
    const editor = open('')
    assert.ok(item.insert(editor.chain().focus()).run(), item.id)
    assert.match(editorModule.readMarkdown(editor), expected[item.id], item.id)
    editor.destroy()
  }
})

test('an icon opens as one icon node and is written back as it was read', () => {
  const editor = open('Ship :icon[rocket]{color=primary} now, :icon[star] later.')
  const icons: { name: unknown; color: unknown }[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'markdownIcon') {
      icons.push({ name: node.attrs.name, color: node.attrs.color })
    }
  })
  assert.deepEqual(icons, [
    { name: 'rocket', color: 'primary' },
    { name: 'star', color: null },
  ])
  assert.equal(editorModule.readMarkdown(editor), 'Ship :icon[rocket]{color=primary} now, :icon[star] later.')
  editor.destroy()
})

test('an icon label is read as its text, and a colour the renderer does not know is kept as written', () => {
  assert.equal(roundTrip(':icon[*rocket*]{color=teal}'), ':icon[rocket]{color=teal}')
})

test('an icon inside a block leaves the block fence as it was', () => {
  assert.equal(roundTrip(':::note\nA :icon[star] here.\n:::'), ':::note\nA :icon[star] here.\n\n:::')
})

test('an icon with no label, a leaf directive and other text directives stay text', () => {
  assert.equal(roundTrip('Use :icon or :icon[] or key:value.'), 'Use :icon or :icon\\[\\] or key:value.')
  assert.ok(!nodeNames(open('Use :icon or ::icon[x].')).includes('markdownIcon'))
})

test('typed text that looks like an icon is saved so it reopens as text', () => {
  const editor = open('')
  // A plain text insertion, as typing makes; `insertContent` would read it as markdown.
  editor.view.dispatch(editor.state.tr.insertText(':icon[rocket]', 1))
  const saved = editorModule.readMarkdown(editor)
  editor.destroy()
  assert.ok(!nodeNames(open(saved)).includes('markdownIcon'), saved)
  assert.equal(roundTrip(saved), saved)
})

test('inserting an icon leaves the caret just after it, not on it, and marks it as the one whose picker opens', () => {
  const editor = open('Before')
  editor.commands.focus('end')
  inserts.BLOCK_INSERTS.find((item) => item.id === 'icon')
    ?.insert(editor.chain().focus())
    .run()
  const { selection } = editor.state
  assert.ok(!(selection instanceof NodeSelection), 'the icon is not selected')
  assert.ok(selection.empty)
  const before = editor.state.doc.resolve(selection.from).nodeBefore
  assert.equal(before?.type.name, 'markdownIcon', 'the caret is just after the icon')
  assert.equal(
    (editor.storage as unknown as Record<string, { openAt?: number }>).markdownIcon.openAt,
    selection.from - 1,
  )
  assert.equal(editorModule.readMarkdown(editor), 'Before:icon[smile]')
  editor.destroy()
})

test('an icon is not a node the selection can stop on', () => {
  const editor = open('A :icon[star] b')
  let icon: import('@tiptap/pm/model').Node | undefined
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'markdownIcon') {
      icon = node
    }
  })
  assert.ok(icon)
  assert.equal(NodeSelection.isSelectable(icon), false)
  editor.destroy()
})

test('a palette colour round-trips as written', () => {
  assert.equal(roundTrip('A :icon[star]{color=sky-300} b'), 'A :icon[star]{color=sky-300} b')
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
  editor.commands.setContent(editorModule.markdownContent(tabs('C', 'D')))
  assert.equal(blocks.activeTab(editor.state, 0), 0)
  editor.destroy()
})

test('the / menu matches by name first, then by keyword', () => {
  assert.equal(inserts.matchBlockInserts('').length, 10)
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
  const store = menus.createSuggestionMenuStore<BlockInsert>()
  const editor = open('', store)
  editor.commands.focus('end')
  type(editor, '/')
  await settle()
  assert.equal(store.get()?.items.length, 10)
  type(editor, 'tab')
  await settle()
  assert.deepEqual(
    store.get()?.items.map((item) => item.label),
    ['Tabs', 'Table'],
  )
  editor.destroy()

  const inSentence = menus.createSuggestionMenuStore<BlockInsert>()
  const other = open('', inSentence)
  other.commands.focus('end')
  type(other, 'a/b')
  await settle()
  assert.equal(inSentence.get(), null)
  other.destroy()

  // At the start of a line that already has words on it: not an empty line.
  const onText = menus.createSuggestionMenuStore<BlockInsert>()
  const worded = open('hello', onText)
  worded.commands.focus('start')
  type(worded, '/')
  await settle()
  assert.equal(onText.get(), null)
  worded.destroy()
})

test('/ in a table cell opens no menu, and Enter still moves to the cell below', async () => {
  const store = menus.createSuggestionMenuStore<BlockInsert>()
  const editor = open('| a | b |\n| --- | --- |\n|  | x |\n', store)
  let cellPos = -1
  editor.state.doc.descendants((node, pos) => {
    if (cellPos < 0 && node.type.name === 'tableCell') {
      cellPos = pos
    }
    return cellPos < 0
  })
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(cellPos + 1))))
  type(editor, '/tab')
  await settle()
  assert.equal(store.get(), null)
  const enter = new KeyboardEvent('keydown', { key: 'Enter' })
  editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, enter))
  assert.equal(editorModule.readMarkdown(editor), '| a | b |\n| --- | --- |\n| /tab | x |\n|  |  |')
  editor.destroy()
})

test('choosing from the / menu replaces the typed command with the block', async () => {
  const store = menus.createSuggestionMenuStore<BlockInsert>()
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

const PEOPLE: MentionCandidate[] = [
  { handle: 'agent.ada', name: 'Ada' },
  { handle: 'bob', name: 'Bob Stone' },
]

/** Runs `body` with a mention source installed that finds `PEOPLE` by handle, recording each query it is asked. */
async function withMentionSource(body: (asked: string[]) => Promise<void>): Promise<void> {
  const asked: string[] = []
  mentions.installMarkdownMentions({
    search: async (query) => {
      asked.push(query)
      return PEOPLE.filter((person) => person.handle.includes(query))
    },
  })
  try {
    await body(asked)
  } finally {
    mentions.installMarkdownMentions(null)
  }
}

/** Puts the caret at `pos`. */
function caretAt(editor: EditorType, pos: number) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
}

test('@ at a line start or after a space lists whom the installed source finds for what follows it', async () => {
  await withMentionSource(async (asked) => {
    const store = menus.createSuggestionMenuStore<MentionCandidate>()
    const editor = open('', undefined, store)
    editor.commands.focus('end')
    type(editor, '@')
    await settle()
    assert.deepEqual(
      store.get()?.items.map((item) => item.handle),
      ['agent.ada', 'bob'],
    )
    type(editor, ' and @bo')
    await settle()
    assert.deepEqual(
      store.get()?.items.map((item) => item.handle),
      ['bob'],
    )
    assert.equal(asked.at(-1), 'bo')
    editor.destroy()
  })
})

test('@ opens nothing inside a word, in code, in a link or with no source installed', async () => {
  const cases: [string, string, number | null][] = [
    // [markdown, typed, where the caret is put first (null: the end)]
    ['', 'mail@bo', null],
    ['`a b`', '@bo', 3],
    ['```\nx\n```', ' @bo', null],
    ['[a b](https://example.com)', '@bo', 3],
  ]
  await withMentionSource(async () => {
    for (const [markdown, typed, pos] of cases) {
      const store = menus.createSuggestionMenuStore<MentionCandidate>()
      const editor = open(markdown, undefined, store)
      editor.commands.focus('end')
      if (pos !== null) {
        caretAt(editor, pos)
      }
      type(editor, typed)
      await settle()
      assert.equal(store.get(), null, `${JSON.stringify(markdown)} + ${JSON.stringify(typed)}`)
      editor.destroy()
    }
    // Control: the same store and typing in plain text does open.
    const store = menus.createSuggestionMenuStore<MentionCandidate>()
    const editor = open('a b', undefined, store)
    caretAt(editor, 3)
    type(editor, '@bo')
    await settle()
    assert.equal(store.get()?.items.length, 1)
    editor.destroy()
  })

  const store = menus.createSuggestionMenuStore<MentionCandidate>()
  const editor = open('', undefined, store)
  editor.commands.focus('end')
  type(editor, '@bo')
  await settle()
  assert.equal(store.get(), null)
  editor.destroy()
})

test('choosing from the @ list writes the handle and a space, keeps what follows the caret and puts the caret after the space', async () => {
  await withMentionSource(async () => {
    // Typed straight before a word: the word is kept, set apart by the space.
    const store = menus.createSuggestionMenuStore<MentionCandidate>()
    const glued = open('hello world', undefined, store)
    caretAt(glued, 7)
    type(glued, '@ad')
    await settle()
    const state = store.get()
    assert.ok(state)
    state.choose(state.items[0])
    assert.equal(editorModule.readMarkdown(glued), 'hello @agent.ada world')
    assert.equal(glued.state.selection.from, 7 + '@agent.ada '.length)
    glued.destroy()

    // A space already after the caret is reused, not doubled.
    const spaced = menus.createSuggestionMenuStore<MentionCandidate>()
    const editor = open('hello world', undefined, spaced)
    caretAt(editor, 6)
    type(editor, ' @ad')
    await settle()
    const menu = spaced.get()
    assert.ok(menu)
    menu.choose(menu.items[0])
    assert.equal(editorModule.readMarkdown(editor), 'hello @agent.ada world')
    assert.equal(editor.state.selection.from, 7 + '@agent.ada '.length)
    editor.destroy()
  })
})

test('Enter with the @ list open chooses instead of breaking the line; Escape closes it and keeps the text', async () => {
  await withMentionSource(async () => {
    const store = menus.createSuggestionMenuStore<MentionCandidate>()
    const editor = open('', undefined, store)
    editor.commands.focus('end')
    type(editor, '@b')
    await settle()
    const press = (key: string) =>
      editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, new KeyboardEvent('keydown', { key })))
    press('Enter')
    assert.equal(editor.state.doc.childCount, 1)
    assert.equal(editor.state.doc.textContent, '@bob ')

    type(editor, '@a')
    await settle()
    assert.ok(store.get())
    press('Escape')
    assert.equal(store.get(), null)
    assert.equal(editor.state.doc.textContent, '@bob @a')
    editor.destroy()
  })
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
