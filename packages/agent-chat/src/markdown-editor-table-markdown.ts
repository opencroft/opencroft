import type { JSONContent, MarkdownRendererHelpers } from '@tiptap/core'
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table'
import { Fragment, type Node as ProseMirrorNode, type ResolvedPos, type Schema } from '@tiptap/pm/model'
import { type EditorState, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state'

import { renderInlineLines } from './markdown-editor-markdown'

/*
 * A table in this editor is always one GFM can write: a header row first, body
 * rows after it, no merged cells, and one paragraph in each cell. GFM has no
 * way to write anything else, and the chat's renderer does not draw raw HTML,
 * so a table written any other way would vanish from every page showing it.
 *
 * A cell's paragraph may hold line breaks: GFM cannot put a newline in a cell,
 * so a break is written as `<br>`, the one piece of HTML every renderer here
 * draws, and the editor reads it back as a break. Content that arrives as
 * several lines -- paragraphs, a list, a code block -- is folded into one
 * paragraph with a break between the lines.
 *
 * Two halves: the shape is restored after any change that broke it (a paste, a
 * moved header row, a deleted one), so what the editor shows is what will be
 * saved; and the writer below writes GFM whatever it is handed, so a document
 * opened with an off-shape table and saved untouched still saves as markdown.
 */

/**
 * Whether the row at `rowIndex` is a header row. GFM has exactly one, the
 * first; this is the one place that rule is stated, for the shape, the writer
 * and pasted tables alike.
 */
export function isHeaderRow(rowIndex: number): boolean {
  return rowIndex === 0
}

/** Whether `$pos` is anywhere inside a table. */
export function inTable($pos: ResolvedPos): boolean {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.spec.tableRole === 'table') {
      return true
    }
  }
  return false
}

const BREAK = '<br>'

const DELIMITERS: Record<string, string> = { left: ':---', center: ':---:', right: '---:' }

/**
 * A cell's markdown with its `|` escaped -- unescaped, a pipe ends the cell
 * and pushes the rest of the row one column over. A backslash escape already
 * in the markdown is kept as it is, so an escaped backslash before a pipe
 * stays one.
 */
function escapePipes(markdown: string): string {
  return markdown.replace(/\\.|\|/g, (match) => (match === '|' ? '\\|' : match))
}

const INLINE_TEXTBLOCKS = new Set(['paragraph', 'heading'])

/** The lines of a block that is not a paragraph of inline content: a code block's, a list's items. */
function blockLines(block: JSONContent): string[] {
  const text = (node: JSONContent): string =>
    node.text ?? (node.content ?? []).map(text).join(node.type === 'codeBlock' ? '' : '\n')
  return text(block)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function writeCell(cell: JSONContent | undefined, h: MarkdownRendererHelpers): string {
  const lines = (cell?.content ?? []).map((block) =>
    INLINE_TEXTBLOCKS.has(block.type ?? '')
      ? renderInlineLines(block.content ?? [], h, { separator: BREAK, escapeStarts: false })
      : blockLines(block)
          .map((line) => h.renderChildren([{ type: 'text', text: line }]))
          .join(BREAK),
  )
  return escapePipes(lines.join(BREAK))
}

/**
 * A table as GFM. The column alignment is the header cell's; a row shorter
 * than the widest is padded with empty cells.
 */
export function writeTable(table: JSONContent, h: MarkdownRendererHelpers): string {
  const rows = table.content ?? []
  const width = Math.max(0, ...rows.map((row) => row.content?.length ?? 0))
  const columns = Array.from({ length: width }, (_, column) => column)
  const lines: string[] = []
  rows.forEach((row, rowIndex) => {
    lines.push(`| ${columns.map((column) => writeCell(row.content?.[column], h)).join(' | ')} |`)
    if (isHeaderRow(rowIndex)) {
      const header = row.content ?? []
      const delimiters = columns.map((column) => DELIMITERS[header[column]?.attrs?.align as string] ?? '---')
      lines.push(`| ${delimiters.join(' | ')} |`)
    }
  })
  return lines.join('\n')
}

/** One paragraph holding `lines`, a line break between each two. */
export function cellParagraph(schema: Schema, lines: Fragment[]): ProseMirrorNode {
  const parts: ProseMirrorNode[] = []
  for (const line of lines.filter((fragment) => fragment.size > 0)) {
    if (parts.length > 0) {
      parts.push(schema.nodes.hardBreak.create())
    }
    line.forEach((node) => {
      parts.push(node)
    })
  }
  return schema.nodes.paragraph.create(null, parts)
}

/** A cell's whole content as one paragraph: a line per paragraph, and per line of anything else, marks kept. */
function asOneParagraph(cell: ProseMirrorNode): ProseMirrorNode {
  const { schema } = cell.type
  const lines: Fragment[] = []
  cell.forEach((block) => {
    if (block.isTextblock && !block.type.spec.code) {
      lines.push(block.content)
    } else {
      lines.push(...blockLines(block.toJSON()).map((line) => Fragment.from(schema.text(line))))
    }
  })
  return cellParagraph(schema, lines)
}

/** The transaction that puts every table in GFM's shape, or null when all already are. */
export function shapeTables(state: EditorState): Transaction | null {
  const { tableHeader, tableCell, paragraph } = state.schema.nodes
  let tr: Transaction | null = null
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'table') {
      return !node.isTextblock
    }
    node.forEach((row, rowOffset, rowIndex) => {
      row.forEach((cell, cellOffset) => {
        const type = isHeaderRow(rowIndex) ? tableHeader : tableCell
        const merged = cell.attrs.colspan !== 1 || cell.attrs.rowspan !== 1
        const oneParagraph = cell.childCount === 1 && cell.firstChild?.type === paragraph
        if (cell.type === type && !merged && oneParagraph) {
          return
        }
        tr ??= state.tr
        const at = tr.mapping.map(pos + 1 + rowOffset + 1 + cellOffset)
        // A merged cell keeps its content in its first slot; the slots it
        // covered come back as empty cells when the table is next fixed up.
        tr.setNodeMarkup(at, type, { ...cell.attrs, colspan: 1, rowspan: 1, colwidth: null })
        if (!oneParagraph) {
          tr.replaceWith(at + 1, at + 1 + cell.content.size, asOneParagraph(cell))
        }
      })
    })
    return false
  })
  return tr
}

/** Keeps every table in GFM's shape after each change to the document. */
export const tableShape = new Plugin({
  key: new PluginKey('markdownTableShape'),
  appendTransaction: (transactions, _previous, state) =>
    transactions.some((transaction) => transaction.docChanged) ? shapeTables(state) : null,
})

/** The table node, writing GFM as above. */
export const MarkdownTableSchemaNode = Table.extend({
  renderMarkdown: (node, h) => writeTable(node, h),
})

/** Tables' schema and markdown, without the editor's view and editing behaviour. */
export const tableSchemaExtensions = [MarkdownTableSchemaNode, TableRow, TableHeader, TableCell]
