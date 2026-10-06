import assert from 'node:assert/strict'
import { before, test } from 'node:test'

import type { Editor as EditorType } from '@tiptap/core'
import { renderToStaticMarkup } from 'react-dom/server'

import { installTestDom } from './test-dom'

// The editor parses markdown through the DOM, so these tests need one.
let Editor: typeof import('@tiptap/core').Editor
let TextSelection: typeof import('@tiptap/pm/state').TextSelection
let CellSelection: typeof import('@tiptap/pm/tables').CellSelection
let TableMap: typeof import('@tiptap/pm/tables').TableMap
let editorModule: typeof import('./markdown-editor')
let table: typeof import('./markdown-editor-table')
let paste: typeof import('./markdown-editor-table-paste')
let Markdown: typeof import('./components/markdown').Markdown

before(async () => {
  installTestDom()
  ;({ Editor } = await import('@tiptap/core'))
  ;({ TextSelection } = await import('@tiptap/pm/state'))
  ;({ CellSelection, TableMap } = await import('@tiptap/pm/tables'))
  editorModule = await import('./markdown-editor')
  table = await import('./markdown-editor-table')
  paste = await import('./markdown-editor-table-paste')
  ;({ Markdown } = await import('./components/markdown'))
})

const GRID = '| a | b |\n| --- | --- |\n| c | d |'

function open(markdown: string): EditorType {
  return new Editor({
    element: document.createElement('div'),
    extensions: editorModule.markdownEditorExtensions({}),
    content: editorModule.markdownContent(markdown),
  })
}

function markdownOf(editor: EditorType): string {
  return editorModule.readMarkdown(editor)
}

/** The position of the first table in the document. */
function tablePos(editor: EditorType): number {
  let found = -1
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === 'table') {
      found = pos
    }
    return found < 0
  })
  assert.ok(found >= 0, 'the document holds a table')
  return found
}

/** Puts the caret in the cell at `row`, `column` of the first table. */
function caretIn(editor: EditorType, row: number, column: number): void {
  const pos = tablePos(editor)
  const node = editor.state.doc.nodeAt(pos)
  assert.ok(node)
  let cellPos = pos + 1
  for (let r = 0; r < row; r++) {
    cellPos += node.child(r).nodeSize
  }
  cellPos += 1
  for (let c = 0; c < column; c++) {
    cellPos += node.child(row).child(c).nodeSize
  }
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(cellPos + 1))))
}

// jsdom has no ClipboardEvent; a paste only hands its event to the handlers.
function pasteText(editor: EditorType, text: string): void {
  editor.view.pasteText(text, new Event('paste') as ClipboardEvent)
}

function pasteHTML(editor: EditorType, html: string): void {
  editor.view.pasteHTML(html, new Event('paste') as ClipboardEvent)
}

function run(editor: EditorType, command: import('./components/markdown-table').MarkdownTableCommand): string {
  table.runTableCommand(editor, tablePos(editor), command)
  return markdownOf(editor)
}

/* ─── Markdown both ways ──────────────────────────────────────────────── */

test('a pipe inside a cell is written escaped, so the row keeps its cells', () => {
  const editor = open('| a | b |\n| --- | --- |\n| x \\| y | z |')
  assert.equal(editor.state.doc.firstChild?.child(1).child(0).textContent, 'x | y')
  assert.equal(markdownOf(editor), '| a | b |\n| --- | --- |\n| x \\| y | z |')
  editor.destroy()
})

test('column alignment survives the round trip', () => {
  const editor = open('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |')
  assert.equal(markdownOf(editor), '| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |')
  editor.destroy()
})

test('a table that is not GFM-shaped is still written as GFM, never as HTML', () => {
  // Markdown reads HTML as text, so the off-shape table is loaded as HTML.
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: editorModule.markdownEditorExtensions({}),
    content:
      '<table><tr><td>a</td><td colspan="2">b</td></tr><tr><td>c</td><td>d</td><td><p>e</p><p>f</p></td></tr></table>',
  })
  assert.equal(markdownOf(editor), '| a | b |  |\n| --- | --- | --- |\n| c | d | e<br>f |')
  editor.destroy()
})

test('a line break in a cell is written as <br> and read back as a break', () => {
  const source = '| a | b |\n| --- | --- |\n| one<br>two | d |'
  const editor = open(source)
  const cell = editor.state.doc.firstChild?.child(1).child(0)
  assert.deepEqual(
    cell?.firstChild?.content.content.map((node) => node.type.name),
    ['text', 'hardBreak', 'text'],
  )
  assert.equal(markdownOf(editor), source)
  editor.destroy()
})

test('the renderer draws <br> as a line break, and no other raw HTML as an element', () => {
  const html = renderToStaticMarkup(
    <Markdown text={'| a |\n| --- |\n| one<br>two |\n\nSome <b>bold</b> and a<br/>break.'} />,
  )
  assert.match(html, /<td>one<br\/>\s*two<\/td>/)
  assert.match(html, /a<br\/>\s*break/)
  assert.doesNotMatch(html, /<b>/)
})

test('the renderer frames a table and keeps its alignment', () => {
  const html = renderToStaticMarkup(<Markdown text={'| a | b |\n| :-: | --: |\n| x | z |'} />)
  // The frame is the box that scrolls; the table inside it keeps GFM's alignment.
  assert.match(html, /<div class="my-2 w-fit max-w-full overflow-x-auto rounded-md border[^"]*"><table><thead>/)
  assert.match(html, /<th style="text-align:center">a<\/th><th style="text-align:right">b<\/th>/)
})

/* ─── Shape ───────────────────────────────────────────────────────────── */

test('a cell given a second paragraph is folded back into one, with a line break between', () => {
  const editor = open('| a | b |\n| --- | --- |\n| one two | d |')
  caretIn(editor, 1, 0)
  // Split the cell's paragraph after "one", the way a plain paragraph split would.
  const { $from } = editor.state.selection
  editor.view.dispatch(editor.state.tr.split($from.start() + 'one'.length))
  assert.equal(editor.state.doc.firstChild?.child(1).child(0).childCount, 1)
  assert.equal(markdownOf(editor), '| a | b |\n| --- | --- |\n| one<br> two | d |')
  editor.destroy()
})

/* ─── Keys ────────────────────────────────────────────────────────────── */

// Through the view's own key handling. TipTap's `keyboardShortcut` command
// keeps only the document steps a key produced, and drops where the caret went.
function pressEnter(editor: EditorType): void {
  const event = new KeyboardEvent('keydown', { key: 'Enter' })
  editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, event))
}

test('Enter in a cell moves to the cell below, and adds a row under the last one', () => {
  const editor = open(GRID)
  caretIn(editor, 0, 1)
  pressEnter(editor)
  assert.deepEqual(table.activeCell(editor.state, tablePos(editor)), { row: 1, column: 1 })
  pressEnter(editor)
  assert.deepEqual(table.activeCell(editor.state, tablePos(editor)), { row: 2, column: 1 })
  assert.equal(markdownOf(editor), '| a | b |\n| --- | --- |\n| c | d |\n|  |  |')
  editor.destroy()
})

test('Shift+Enter in a cell breaks the line inside the cell', () => {
  const editor = open(GRID)
  caretIn(editor, 1, 0)
  editor.commands.setTextSelection(editor.state.selection.$from.end())
  const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true })
  editor.view.someProp('handleKeyDown', (handle) => handle(editor.view, event))
  editor.commands.insertContent('x')
  assert.deepEqual(table.activeCell(editor.state, tablePos(editor)), { row: 1, column: 0 })
  assert.equal(markdownOf(editor), '| a | b |\n| --- | --- |\n| c<br>x | d |')
  editor.destroy()
})

/* ─── Commands ────────────────────────────────────────────────────────── */

test('insert puts an empty row or column at the boundary and the caret in it', () => {
  const editor = open(GRID)
  caretIn(editor, 1, 1)
  assert.equal(run(editor, { type: 'insertRow', index: 1 }), '| a | b |\n| --- | --- |\n|  |  |\n| c | d |')
  assert.deepEqual(table.activeCell(editor.state, tablePos(editor)), { row: 1, column: 1 })
  assert.equal(
    run(editor, { type: 'insertColumn', index: 0 }),
    '|  | a | b |\n| --- | --- | --- |\n|  |  |  |\n|  | c | d |',
  )
  assert.deepEqual(table.activeCell(editor.state, tablePos(editor)), { row: 1, column: 0 })
  editor.destroy()
})

test('inserting before the header row makes the new row the header', () => {
  const editor = open(GRID)
  caretIn(editor, 0, 0)
  assert.equal(run(editor, { type: 'insertRow', index: 0 }), '|  |  |\n| --- | --- |\n| a | b |\n| c | d |')
  editor.destroy()
})

test('delete removes a row or a column, and never the last one', () => {
  const editor = open('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |')
  caretIn(editor, 1, 1)
  assert.equal(run(editor, { type: 'deleteRow', index: 1 }), '| a | b | c |\n| --- | --- | --- |\n| 4 | 5 | 6 |')
  assert.equal(run(editor, { type: 'deleteColumn', index: 0 }), '| b | c |\n| --- | --- |\n| 5 | 6 |')
  // Deleting the header row promotes the row under it.
  assert.equal(run(editor, { type: 'deleteRow', index: 0 }), '| 5 | 6 |\n| --- | --- |')
  assert.equal(run(editor, { type: 'deleteRow', index: 0 }), '| 5 | 6 |\n| --- | --- |')
  assert.equal(run(editor, { type: 'deleteColumn', index: 0 }), '| 6 |\n| --- |')
  assert.equal(run(editor, { type: 'deleteColumn', index: 0 }), '| 6 |\n| --- |')
  editor.destroy()
})

test('move carries a row or a column with its content; the first row is always the header', () => {
  const editor = open('| a | b |\n| --- | --- |\n| c | d |\n| e | f |')
  caretIn(editor, 1, 0)
  assert.equal(run(editor, { type: 'moveRow', from: 2, to: 1 }), '| a | b |\n| --- | --- |\n| e | f |\n| c | d |')
  assert.equal(run(editor, { type: 'moveColumn', from: 0, to: 1 }), '| b | a |\n| --- | --- |\n| f | e |\n| d | c |')
  assert.equal(run(editor, { type: 'moveRow', from: 0, to: 2 }), '| f | e |\n| --- | --- |\n| d | c |\n| b | a |')
  editor.destroy()
})

test('align sets a whole column, and left writes no alignment', () => {
  const editor = open(GRID)
  caretIn(editor, 1, 1)
  assert.equal(run(editor, { type: 'alignColumn', index: 1, align: 'right' }), '| a | b |\n| --- | ---: |\n| c | d |')
  assert.equal(run(editor, { type: 'alignColumn', index: 1, align: null }), GRID)
  editor.destroy()
})

test('select makes a cell selection over the whole row or column', () => {
  const editor = open(GRID)
  caretIn(editor, 0, 0)
  table.runTableCommand(editor, tablePos(editor), { type: 'selectColumn', index: 1 })
  const selection = editor.state.selection
  assert.ok(selection instanceof CellSelection)
  const cells: string[] = []
  selection.forEachCell((cell) => {
    cells.push(cell.textContent)
  })
  assert.deepEqual(cells, ['b', 'd'])
  editor.destroy()
})

test('delete table removes the table and leaves the text around it', () => {
  const editor = open(`Before.\n\n${GRID}\n\nAfter.\n`)
  caretIn(editor, 1, 1)
  assert.equal(run(editor, { type: 'deleteTable' }), 'Before.\n\nAfter.')
  editor.destroy()
})

test('the active cell is reported only for the table holding the caret', () => {
  const editor = open(`${GRID}\n\nBetween.\n\n${GRID}`)
  caretIn(editor, 1, 0)
  const first = tablePos(editor)
  assert.deepEqual(table.activeCell(editor.state, first), { row: 1, column: 0 })
  let second = -1
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'table' && offset !== first) {
      second = offset
    }
  })
  assert.ok(second > first)
  assert.equal(table.activeCell(editor.state, second), null)
  editor.destroy()
})

test('the selected cells are the caret cell, or a cell selection block, and only in the table holding it', () => {
  const editor = open(`| a | b | c |\n| --- | --- | --- |\n| d | e | f |\n| g | h | i |\n\nBetween.\n\n${GRID}`)
  const tables: number[] = []
  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === 'table') {
      tables.push(offset)
    }
  })
  assert.equal(tables.length, 2)
  const [first, second] = tables

  caretIn(editor, 1, 2)
  assert.deepEqual(table.selectedCells(editor.state, first), { top: 1, bottom: 1, left: 2, right: 2 })
  assert.equal(table.selectedCells(editor.state, second), null)

  // Dragged from the bottom right up to the middle: the block, whichever way it was made.
  const firstTable = editor.state.doc.nodeAt(first)
  assert.ok(firstTable)
  const map = TableMap.get(firstTable)
  const cellPos = (row: number, column: number) => first + 1 + map.map[row * map.width + column]
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cellPos(2, 2), cellPos(0, 1))),
  )
  assert.deepEqual(table.selectedCells(editor.state, first), { top: 0, bottom: 2, left: 1, right: 2 })
  assert.equal(table.selectedCells(editor.state, second), null)
  editor.destroy()
})

/* ─── Paste ───────────────────────────────────────────────────────────── */

test('tab-separated text reads as rows; a quoted cell keeps its quotes and its lines', () => {
  assert.deepEqual(paste.parseTabSeparated('a\tb\r\nc\td\r\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ])
  assert.deepEqual(paste.parseTabSeparated('"x\ty"\t"say ""hi"""\n"two\nlines"\tz'), [
    ['x y', 'say "hi"'],
    ['two\nlines', 'z'],
  ])
  assert.equal(paste.parseTabSeparated('no tabs here'), null)
  // Ragged lines are not a range a spreadsheet would copy.
  assert.equal(paste.parseTabSeparated('a\tb\nc'), null)
})

test('TSV pasted into a cell lands from that cell on, adding rows and columns', () => {
  const editor = open(GRID)
  caretIn(editor, 1, 1)
  pasteText(editor, '1\t2\t3\n4\t5\t6')
  assert.equal(markdownOf(editor), '| a | b |  |  |\n| --- | --- | --- | --- |\n| c | 1 | 2 | 3 |\n|  | 4 | 5 | 6 |')
  editor.destroy()
})

test('TSV pasted outside a table becomes a table with its first line as the header', () => {
  const editor = open('Intro.')
  editor.commands.setTextSelection(editor.state.doc.content.size - 1)
  pasteText(editor, 'Name\tScore\nalice\t3\nbob\t5\n')
  assert.equal(markdownOf(editor), 'Intro.\n\n| Name | Score |\n| --- | --- |\n| alice | 3 |\n| bob | 5 |')
  editor.destroy()
})

test('a pasted cell of several lines keeps them as line breaks', () => {
  const editor = open('')
  pasteText(editor, 'Step\tNotes\n1\t"first line\nsecond line"\n')
  assert.equal(markdownOf(editor), '| Step | Notes |\n| --- | --- |\n| 1 | first line<br>second line |')
  editor.destroy()
})

test('one line with a tab outside a table stays text', () => {
  const editor = open('')
  pasteText(editor, 'just\ttext')
  assert.equal(editor.state.doc.firstChild?.type.name, 'paragraph')
  editor.destroy()
})

// What a spreadsheet puts on the clipboard: body cells only, a merged cell.
const SPREADSHEET_HTML =
  '<meta charset="utf-8"><google-sheets-html-origin><table><colgroup><col><col></colgroup><tbody>' +
  '<tr><td>Name</td><td>Score</td></tr><tr><td colspan="2">alice</td></tr><tr><td>bob</td><td>5</td></tr>' +
  '</tbody></table></google-sheets-html-origin>'

test('an HTML table pasted outside a table becomes GFM: header first, merged cells split', () => {
  const editor = open('')
  pasteHTML(editor, SPREADSHEET_HTML)
  assert.equal(markdownOf(editor), '| Name | Score |\n| --- | --- |\n| alice |  |\n| bob | 5 |')
  const first = editor.state.doc.firstChild
  assert.equal(first?.type.name, 'table')
  assert.deepEqual(
    [first?.child(0).child(0).type.name, first?.child(1).child(0).type.name],
    ['tableHeader', 'tableCell'],
  )
  editor.destroy()
})

test('an HTML table pasted into a cell lands in the cells from there on', () => {
  const editor = open(GRID)
  caretIn(editor, 1, 0)
  pasteHTML(editor, '<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>')
  assert.equal(markdownOf(editor), '| a | b |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
  editor.destroy()
})

test('cells copied from another table paste into a selected range, filling it', () => {
  const source = open('| x | y |\n| --- | --- |\n| 1 | 2 |')
  const sourcePos = tablePos(source)
  const sourceTable = source.state.doc.nodeAt(sourcePos)
  assert.ok(sourceTable)
  // Select the body row, then copy it the way the editor does.
  const rowStart = sourcePos + 1 + sourceTable.child(0).nodeSize
  source.view.dispatch(source.state.tr.setSelection(CellSelection.rowSelection(source.state.doc.resolve(rowStart + 1))))
  const { dom } = source.view.serializeForClipboard(source.state.selection.content())

  const target = open(GRID)
  caretIn(target, 0, 0)
  pasteHTML(target, dom.innerHTML)
  assert.equal(markdownOf(target), '| 1 | 2 |\n| --- | --- |\n| c | d |')
  source.destroy()
  target.destroy()
})
