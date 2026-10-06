import { Fragment, type Schema, Slice } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'

import { cellParagraph, inTable, isHeaderRow } from './markdown-editor-table-markdown'

/*
 * Pasting cells from a spreadsheet as text.
 *
 * A spreadsheet puts a copied range on the clipboard twice: as an HTML table,
 * which the editor's schema already reads as a table, and as tab-separated
 * text. The text is what arrives when there is no HTML -- a plain-text paste, a
 * terminal, a TSV file opened in an editor -- and without this it would land as
 * one paragraph of tab-joined words.
 *
 * Turned into a table here, it then goes where any pasted table goes: inside a
 * table, prosemirror-tables places the cells from the caret's cell on, adding
 * rows and columns as needed; outside one, it is inserted as a new table.
 */

/**
 * The rows of a tab-separated range, or null when the text is not one: every
 * line must split into the same number of cells, at least two. A cell may be
 * quoted the way spreadsheets quote a cell holding a tab, a newline or a quote
 * (`"a ""b"""`); its lines stay apart, as `\n` in the cell's text, and a tab
 * inside one becomes a space.
 */
export function parseTabSeparated(text: string): string[][] | null {
  if (!text.includes('\t')) {
    return null
  }
  const source = text.replace(/\r\n?/g, '\n').replace(/\n$/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quoted) {
      if (char !== '"') {
        cell += char
      } else if (source[index + 1] === '"') {
        cell += '"'
        index++
      } else {
        quoted = false
      }
    } else if (char === '"' && cell === '') {
      quoted = true
    } else if (char === '\t') {
      row.push(cell)
      cell = ''
    } else if (char === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += char
    }
  }
  row.push(cell)
  rows.push(row)
  const width = rows[0].length
  if (width < 2 || rows.some((cells) => cells.length !== width)) {
    return null
  }
  return rows.map((cells) =>
    cells.map((value) =>
      value
        .split('\n')
        .map((line) => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n'),
    ),
  )
}

/** A table holding `rows`, as a slice a paste can place. A `\n` in a cell's text is a line break in it. */
export function tableSlice(schema: Schema, rows: string[][]): Slice {
  const { table, tableRow, tableHeader, tableCell } = schema.nodes
  const node = table.create(
    null,
    rows.map((cells, rowIndex) =>
      tableRow.create(
        null,
        cells.map((value) =>
          (isHeaderRow(rowIndex) ? tableHeader : tableCell).create(
            null,
            cellParagraph(
              schema,
              value.split('\n').map((line) => (line ? Fragment.from(schema.text(line)) : Fragment.empty)),
            ),
          ),
        ),
      ),
    ),
  )
  return new Slice(Fragment.from(node), 0, 0)
}

/**
 * Reads tab-separated text as a table. Outside a table one line is not taken
 * for a table -- a single line with a tab in it is more likely prose -- while
 * inside one it is a row of cells.
 *
 * Must come before the markdown extension's own text parser, which takes
 * whatever reaches it.
 */
export const tabSeparatedPaste = new Plugin({
  key: new PluginKey('markdownTableTabSeparatedPaste'),
  props: {
    clipboardTextParser(text, $context) {
      const rows = parseTabSeparated(text)
      if (!rows || (rows.length < 2 && !inTable($context))) {
        // Not ours: the next parser along reads it.
        return null as unknown as Slice
      }
      return tableSlice($context.doc.type.schema, rows)
    },
  },
})
