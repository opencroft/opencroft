import type { ComponentProps, ReactNode } from 'react'
import { cn } from 'cn'

import { MarkdownTableEditor } from './markdown-table-editor'

export type MarkdownTableAlign = 'left' | 'center' | 'right'

/**
 * What the editable form asks its host to do. Rows and columns are counted
 * from 0, the header row included; an insert's `index` is the position the
 * new row or column takes, so `0` is before the first and the count is after
 * the last.
 */
export type MarkdownTableCommand =
  | { type: 'insertRow'; index: number }
  | { type: 'insertColumn'; index: number }
  | { type: 'deleteRow'; index: number }
  | { type: 'deleteColumn'; index: number }
  | { type: 'moveRow'; from: number; to: number }
  | { type: 'moveColumn'; from: number; to: number }
  | { type: 'alignColumn'; index: number; align: MarkdownTableAlign | null }
  | { type: 'selectRow'; index: number }
  | { type: 'selectColumn'; index: number }
  | { type: 'deleteTable' }

export interface MarkdownTableCell {
  row: number
  column: number
}

/** A block of cells: rows `top` to `bottom` and columns `left` to `right`, both ends included. */
export interface MarkdownTableSelection {
  top: number
  bottom: number
  left: number
  right: number
}

export interface MarkdownTableEditing {
  /**
   * The cells the caret or a cell selection is in; null when it is outside the
   * table. Only these rows and columns show their controls.
   */
  selection: MarkdownTableSelection | null
  onCommand: (command: MarkdownTableCommand) => void
}

export interface MarkdownTableProps extends ComponentProps<'table'> {
  /** The rows: a `thead` and a `tbody`, or bare `tr`s. */
  children?: ReactNode
  /**
   * A table element somebody else owns -- an editor's -- framed as it is, in
   * place of the one this would build from `children`.
   */
  table?: ReactNode
  /**
   * Makes it the editable form, for an editor: the frame grows the row and
   * column controls around the table.
   */
  editing?: MarkdownTableEditing
}

// The frame is the spoiler's box. The table scrolls sideways inside it, so a
// wide table never widens the page; it hugs a narrow table instead of
// stretching it across the column.
const FRAME = 'w-fit max-w-full overflow-x-auto rounded-md border'

// The table and its cells, styled from the frame so the same look lands on
// whichever table is inside it -- the rendered one, or the one an editor owns.
// Sizes come from the surrounding prose scale where it sets them.
const LOOK = cn(
  'text-[length:var(--prose-table-size,0.875em)]',
  '[&_table]:border-collapse',
  '[&_:is(th,td)]:min-w-[4em] [&_:is(th,td)]:border-b [&_:is(th,td)]:border-r [&_:is(th,td)]:align-top',
  '[&_:is(th,td)]:[padding:var(--prose-cell-padding,0.5em_0.75em)]',
  '[&_:is(th,td):last-child]:border-r-0 [&_table>:last-child>tr:last-child>*]:border-b-0',
  '[&_th]:bg-muted/50 [&_th]:text-left [&_th]:font-medium',
  '[&_th]:[white-space:var(--prose-table-white-space,normal)]',
)

/**
 * A markdown table: one framed box with a muted header row and hairlines
 * between rows and columns. A table wider than its column scrolls inside the
 * frame.
 *
 * Given `editing` it is the same table made editable, for an editor: a strip
 * above the columns and one beside the rows. The rows and columns of the
 * selection get a grip each (press for its menu, drag with a mouse to move it)
 * and a `+` on either side; the rest get none. A right-click or long press on
 * any cell opens the same actions for that cell.
 */
export function MarkdownTable({ table, editing, children, ...props }: MarkdownTableProps) {
  const content = table ?? <table {...props}>{children}</table>
  if (editing) {
    return (
      <MarkdownTableEditor editing={editing} frameClassName={cn(FRAME, LOOK)}>
        {content}
      </MarkdownTableEditor>
    )
  }
  return <div className={cn('my-2', FRAME, LOOK)}>{content}</div>
}
