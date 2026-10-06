'use client'

import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { type EditorState, TextSelection, type Transaction } from '@tiptap/pm/state'
import {
  addColumn,
  addRow,
  CellSelection,
  isInTable,
  moveTableColumn,
  moveTableRow,
  removeColumn,
  removeRow,
  selectionCell,
  TableMap,
} from '@tiptap/pm/tables'
import {
  type Editor,
  Extension,
  NodeViewContent,
  type NodeViewProps,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  useEditorState,
} from '@tiptap/react'

import {
  MarkdownTable,
  type MarkdownTableCell,
  type MarkdownTableCommand,
  type MarkdownTableSelection,
} from './components/markdown-table'
import { MarkdownTableSchemaNode, tableShape } from './markdown-editor-table-markdown'
import { tabSeparatedPaste } from './markdown-editor-table-paste'

/*
 * Tables in the editor: drawn by `MarkdownTable`, the component `Markdown`
 * renders a table with, in its editable form; its controls report commands by
 * row and column index, carried out here with prosemirror-tables' own table
 * operations.
 */

/** The cell holding the caret (a cell selection's anchor), if it is in the table at `tablePos`. */
export function activeCell(state: EditorState, tablePos: number): MarkdownTableCell | null {
  if (!isInTable(state)) {
    return null
  }
  const $cell = selectionCell(state)
  if ($cell.before(-1) !== tablePos) {
    return null
  }
  const { top, left } = TableMap.get($cell.node(-1)).findCell($cell.pos - $cell.start(-1))
  return { row: top, column: left }
}

/** The cells the caret or a cell selection covers, if it is in the table at `tablePos`. */
export function selectedCells(state: EditorState, tablePos: number): MarkdownTableSelection | null {
  if (!isInTable(state)) {
    return null
  }
  const { selection } = state
  const $anchor = selection instanceof CellSelection ? selection.$anchorCell : selectionCell(state)
  const $head = selection instanceof CellSelection ? selection.$headCell : $anchor
  if ($anchor.before(-1) !== tablePos) {
    return null
  }
  const start = $anchor.start(-1)
  const rect = TableMap.get($anchor.node(-1)).rectBetween($anchor.pos - start, $head.pos - start)
  return { top: rect.top, bottom: rect.bottom - 1, left: rect.left, right: rect.right - 1 }
}

/** The whole of the table at `tablePos`, as the rectangle prosemirror-tables' operations take. */
function wholeTable(table: ProseMirrorNode, tablePos: number) {
  const map = TableMap.get(table)
  return { map, table, tableStart: tablePos + 1, left: 0, top: 0, right: map.width, bottom: map.height }
}

/** Puts the caret in a cell of the table at `tablePos`, clamped to the table. */
function placeCaret(tr: Transaction, tablePos: number, row: number, column: number): void {
  const table = tr.doc.nodeAt(tablePos)
  if (!table) {
    return
  }
  const map = TableMap.get(table)
  const r = Math.max(0, Math.min(row, map.height - 1))
  const c = Math.max(0, Math.min(column, map.width - 1))
  const cellPos = tablePos + 1 + map.map[r * map.width + c]
  tr.setSelection(TextSelection.near(tr.doc.resolve(cellPos + 1)))
}

/** Carries out a table control's command on the table at `tablePos`. */
export function runTableCommand(editor: Editor, tablePos: number, command: MarkdownTableCommand): void {
  const { state, view } = editor
  const table = state.doc.nodeAt(tablePos)
  if (!editor.isEditable || table?.type.name !== 'table') {
    return
  }
  const rect = wholeTable(table, tablePos)
  const { map, tableStart } = rect
  const cellAt = (row: number, column: number) => state.doc.resolve(tableStart + map.map[row * map.width + column])
  const caret = activeCell(state, tablePos) ?? { row: 0, column: 0 }
  const tr = state.tr

  switch (command.type) {
    case 'moveRow':
    case 'moveColumn': {
      const move = command.type === 'moveRow' ? moveTableRow : moveTableColumn
      move({ from: command.from, to: command.to, pos: tableStart })(state, view.dispatch)
      view.focus()
      return
    }
    case 'selectRow':
      view.dispatch(tr.setSelection(CellSelection.rowSelection(cellAt(command.index, 0))))
      return
    case 'selectColumn':
      view.dispatch(tr.setSelection(CellSelection.colSelection(cellAt(0, command.index))))
      return
    case 'insertRow':
      addRow(tr, rect, command.index)
      placeCaret(tr, tablePos, command.index, caret.column)
      break
    case 'insertColumn':
      addColumn(tr, rect, command.index)
      placeCaret(tr, tablePos, caret.row, command.index)
      break
    case 'deleteRow':
      if (map.height < 2) {
        return
      }
      removeRow(tr, rect, command.index)
      placeCaret(tr, tablePos, command.index, caret.column)
      break
    case 'deleteColumn':
      if (map.width < 2) {
        return
      }
      removeColumn(tr, rect, command.index)
      placeCaret(tr, tablePos, caret.row, command.index)
      break
    case 'alignColumn':
      for (let row = 0; row < map.height; row++) {
        tr.setNodeAttribute(tableStart + map.map[row * map.width + command.index], 'align', command.align)
      }
      break
    case 'deleteTable':
      tr.delete(tablePos, tablePos + table.nodeSize)
      break
  }
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

/**
 * Enter in a cell goes to the cell below, adding a row at the bottom, as in a
 * spreadsheet. A second paragraph in a cell is something GFM cannot write.
 */
function enterGoesDown(editor: Editor): boolean {
  const { state, view } = editor
  if (!isInTable(state) || state.selection instanceof CellSelection) {
    return false
  }
  const $cell = selectionCell(state)
  const tablePos = $cell.before(-1)
  const rect = wholeTable($cell.node(-1), tablePos)
  const { top, left } = rect.map.findCell($cell.pos - $cell.start(-1))
  const tr = state.tr
  if (top + 1 >= rect.map.height) {
    addRow(tr, rect, rect.map.height)
  }
  placeCaret(tr, tablePos, top + 1, left)
  view.dispatch(tr.scrollIntoView())
  return true
}

function sameCells(a: MarkdownTableSelection | null, b: MarkdownTableSelection | null): boolean {
  return (
    a === b ||
    (a !== null && b !== null && a.top === b.top && a.bottom === b.bottom && a.left === b.left && a.right === b.right)
  )
}

function TableView({ editor, getPos }: NodeViewProps) {
  const { editable, selection } = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const pos = getPos()
      return {
        editable: current.isEditable,
        selection: current.isEditable && typeof pos === 'number' ? selectedCells(current.state, pos) : null,
      }
    },
    equalityFn: (a, b) => b !== null && a.editable === b.editable && sameCells(a.selection, b.selection),
  })
  const onCommand = (command: MarkdownTableCommand) => {
    const pos = getPos()
    if (typeof pos === 'number') {
      runTableCommand(editor, pos, command)
    }
  }
  return (
    <NodeViewWrapper>
      <MarkdownTable
        table={<NodeViewContent<'table'> as='table' />}
        editing={editable ? { selection, onCommand } : undefined}
      />
    </NodeViewWrapper>
  )
}

/** The table node, drawn by `MarkdownTable`. */
export const MarkdownTableNode = MarkdownTableSchemaNode.extend({
  addNodeView() {
    // The rows go straight into the table's body, so the table element the
    // component frames is a real table and the browser lays it out as one.
    return ReactNodeViewRenderer(TableView, { contentDOMElementTag: 'tbody' })
  },
})

/*
 * Ahead of the editor's own keys and paste handling: its Enter would split the
 * cell's paragraph before this one is asked, and the editor's markdown paste
 * would take tab-separated text as a paragraph. A separate extension, because
 * raising the table node's own priority would move it ahead of the paragraph
 * in the schema, which is what an empty block is filled with.
 */
export const MarkdownTableEditing = Extension.create({
  name: 'markdownTableEditing',
  priority: 200,
  addKeyboardShortcuts() {
    return { Enter: () => enterGoesDown(this.editor) }
  },
  addProseMirrorPlugins() {
    return [tableShape, tabSeparatedPaste]
  },
})
