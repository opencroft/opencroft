import { Check, GripHorizontal, GripVertical, Plus, Table2 } from 'lucide-react'
import { type CSSProperties, type PointerEvent, type ReactNode, useRef, useState } from 'react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from 'ui/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'
import { cn } from 'cn'

import type {
  MarkdownTableAlign,
  MarkdownTableCell,
  MarkdownTableCommand,
  MarkdownTableEditing,
  MarkdownTableSelection,
} from './markdown-table'
import { ACTIONS, ActionGroups, ActionItem, ALIGNS, type Axis, CONTEXT, DELETE_TABLE, DROPDOWN } from './markdown-table-actions'
import { boundaries, nearest, useTableLayout } from './markdown-table-layout'

/* ─── Grips ───────────────────────────────────────────────────────────── */

// How far a mouse press travels before it is a drag rather than a press.
const DRAG_THRESHOLD = 4

// A control's glyph is small; its hit area reaches past it on every side.
const HIT = "relative after:absolute after:-inset-1.5 after:content-['']"

interface Drag {
  axis: Axis
  from: number
  boundary: number
}

/**
 * The index a dragged row or column takes when dropped on its boundary. A
 * boundary after it lands it one before that line, since it leaves its own
 * place behind; either of its own two edges leaves it where it is.
 */
function landing({ from, boundary }: Drag): number {
  return boundary > from ? boundary - 1 : boundary
}

/**
 * A row's or column's handle. A press opens its menu and selects it; a mouse
 * drag moves it instead, with the drop line drawn by the table.
 *
 * The menu opens on the click rather than on the press the menu primitive
 * would use, because a press is also how a drag begins and a menu must not
 * open under a drag.
 */
function Grip({
  axis,
  index,
  count,
  align,
  style,
  onCommand,
  onDrag,
  onDrop,
}: {
  axis: Axis
  index: number
  count: number
  /** The column's alignment; a row has none. */
  align?: MarkdownTableAlign | null
  style: CSSProperties
  onCommand: (command: MarkdownTableCommand) => void
  /** The pointer is at these client coordinates mid-drag. */
  onDrag: (clientX: number, clientY: number) => void
  /** The drag ended; `false` when it was abandoned. */
  onDrop: (commit: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const press = useRef<{ x: number; y: number; dragging: boolean } | null>(null)
  // The click that ends a drag, or a press that closed the menu, is not a request to open it.
  const swallowClick = useRef(false)
  const Icon = axis === 'row' ? GripVertical : GripHorizontal

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'mouse' || event.button !== 0) {
      return
    }
    press.current = { x: event.clientX, y: event.clientY, dragging: false }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current
    if (!current) {
      return
    }
    if (!current.dragging && Math.hypot(event.clientX - current.x, event.clientY - current.y) < DRAG_THRESHOLD) {
      return
    }
    current.dragging = true
    onDrag(event.clientX, event.clientY)
  }
  const onPointerEnd = (commit: boolean) => {
    const current = press.current
    press.current = null
    if (current?.dragging) {
      swallowClick.current = true
      onDrop(commit)
    }
  }

  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next, details) => {
        if (details.event?.type === 'mousedown') {
          if (next) {
            return
          }
          swallowClick.current = true
        }
        setOpen(next)
      }}
    >
      <DropdownMenuTrigger
        aria-label={axis === 'row' ? `Row ${index + 1}` : `Column ${index + 1}`}
        style={style}
        className={cn(
          HIT,
          'absolute flex items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground',
          axis === 'row' ? 'left-1/2 h-6 w-4 -translate-x-1/2 -translate-y-1/2' : 'top-1/2 h-4 w-6 -translate-x-1/2 -translate-y-1/2',
        )}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => onPointerEnd(true)}
        onPointerCancel={() => onPointerEnd(false)}
        onClick={() => {
          if (swallowClick.current) {
            swallowClick.current = false
            return
          }
          onCommand(axis === 'row' ? { type: 'selectRow', index } : { type: 'selectColumn', index })
          setOpen(true)
        }}
      >
        <Icon className='size-3.5' />
      </DropdownMenuTrigger>
      <DropdownMenuContent className='w-auto' finalFocus={false}>
        <ActionGroups groups={ACTIONS[axis]} index={index} count={count} onCommand={onCommand} parts={DROPDOWN} />
        {axis === 'column' ? (
          <>
            <DropdownMenuSeparator />
            {ALIGNS.map((option) => {
              const Icon = option.icon
              // Left is the default, so choosing it writes no alignment at all.
              const current = (align ?? 'left') === option.align
              return (
                <DropdownMenuItem
                  key={option.align}
                  onClick={() =>
                    onCommand({ type: 'alignColumn', index, align: option.align === 'left' ? null : option.align })
                  }
                >
                  <Icon />
                  {option.label}
                  {current ? <Check className='ml-auto' /> : null}
                </DropdownMenuItem>
              )
            })}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function InsertButton({ label, style, onInsert }: { label: string; style: CSSProperties; onInsert: () => void }) {
  return (
    <button
      type='button'
      aria-label={label}
      title={label}
      style={style}
      className={cn(
        HIT,
        'absolute flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-muted-foreground hover:border-primary hover:bg-primary hover:text-primary-foreground',
      )}
      // Keeps the editor focused, so the caret lands in what was inserted.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onInsert}
    >
      <Plus className='size-3' />
    </button>
  )
}

function TableGrip({ onCommand }: { onCommand: (command: MarkdownTableCommand) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label='Table'
        className={cn(
          HIT,
          'absolute top-1 left-1 flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <Table2 className='size-3.5' />
      </DropdownMenuTrigger>
      <DropdownMenuContent className='w-auto' finalFocus={false}>
        <ActionItem action={DELETE_TABLE} index={0} count={1} onCommand={onCommand} parts={DROPDOWN} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ─── The editable table ──────────────────────────────────────────────── */

/** `from` to `to`, both included; empty when `to` is below `from`. */
function indices(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from + 1) }, (_, offset) => from + offset)
}

/**
 * The grips and the `+` boundaries the selection's rows and columns get: a
 * grip on each, a `+` on either side of each. Clamped to the measured table,
 * which can be a row or column behind the selection for one render after an
 * insert or delete.
 */
function shownControls(selection: MarkdownTableSelection, columns: number, rows: number) {
  const right = Math.min(selection.right, columns - 1)
  const bottom = Math.min(selection.bottom, rows - 1)
  return {
    columns: indices(selection.left, right),
    columnLines: indices(selection.left, right + 1),
    rows: indices(selection.top, bottom),
    rowLines: indices(selection.top, bottom + 1),
  }
}

interface Picked {
  cell: MarkdownTableCell | null
  rows: number
  columns: number
}

/** The cell an event landed on, and the table's size, read from the DOM the event came from. */
function pickCell(frame: HTMLElement | null, target: EventTarget | null): Picked | null {
  const table = frame?.querySelector('table')
  if (!table) {
    return null
  }
  const cell = target instanceof Element ? target.closest('th, td') : null
  const inTable = cell instanceof HTMLTableCellElement && table.contains(cell)
  return {
    cell: inTable ? { row: (cell.parentElement as HTMLTableRowElement).rowIndex, column: cell.cellIndex } : null,
    rows: table.rows.length,
    columns: table.rows[0]?.cells.length ?? 0,
  }
}

/**
 * The editable form of `MarkdownTable`. Pure presentation over a table it is
 * handed: what each control does is reported through `onCommand`, and the
 * cells the caret or a cell selection is in come in as `selection`.
 *
 * The controls sit in gutters above and beside the frame, outside the text an
 * editor hosts (`contentEditable={false}`), so pressing them never puts a caret
 * in them. The column strip follows the table's sideways scroll.
 */
export function MarkdownTableEditor({
  editing,
  frameClassName,
  children,
}: {
  editing: MarkdownTableEditing
  frameClassName: string
  children?: ReactNode
}) {
  const { selection, onCommand } = editing
  const frameRef = useRef<HTMLDivElement>(null)
  const layout = useTableLayout(frameRef, selection !== null)
  const [scrollLeft, setScrollLeft] = useState(0)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [picked, setPicked] = useState<Picked | null>(null)

  const dragTo = (axis: Axis, from: number, clientX: number, clientY: number) => {
    const frame = frameRef.current
    if (!frame || !layout) {
      return
    }
    const box = frame.getBoundingClientRect()
    const boundary =
      axis === 'column'
        ? nearest(boundaries(layout.columns), clientX - box.left - layout.x + frame.scrollLeft)
        : nearest(boundaries(layout.rows), clientY - box.top - layout.y)
    setDrag({ axis, from, boundary })
  }
  const drop = (commit: boolean) => {
    if (commit && drag) {
      const to = landing(drag)
      if (to !== drag.from) {
        onCommand(
          drag.axis === 'row' ? { type: 'moveRow', from: drag.from, to } : { type: 'moveColumn', from: drag.from, to },
        )
      }
    }
    setDrag(null)
  }
  const pick = (target: EventTarget | null) => setPicked(pickCell(frameRef.current, target))

  const columnLines = layout ? boundaries(layout.columns) : []
  const rowLines = layout ? boundaries(layout.rows) : []
  const shown = layout && selection ? shownControls(selection, layout.columns.length, layout.rows.length) : null

  return (
    <div className='relative my-2 pt-6 pl-6'>
      <ContextMenu>
        <ContextMenuTrigger
          ref={frameRef}
          // The stock trigger is `select-none`; this one holds editable text.
          className={cn(frameClassName, 'select-text')}
          onScroll={(event) => setScrollLeft(event.currentTarget.scrollLeft)}
          onPointerDown={(event) => pick(event.target)}
          onContextMenu={(event) => pick(event.target)}
        >
          {children}
        </ContextMenuTrigger>
        <ContextMenuContent finalFocus={false}>
          {picked?.cell ? (
            <>
              <ActionGroups
                groups={ACTIONS.row}
                index={picked.cell.row}
                count={picked.rows}
                onCommand={onCommand}
                parts={CONTEXT}
              />
              <ContextMenuSeparator />
              <ActionGroups
                groups={ACTIONS.column}
                index={picked.cell.column}
                count={picked.columns}
                onCommand={onCommand}
                parts={CONTEXT}
              />
              <ContextMenuSeparator />
            </>
          ) : null}
          <ActionItem action={DELETE_TABLE} index={0} count={1} onCommand={onCommand} parts={CONTEXT} />
        </ContextMenuContent>
      </ContextMenu>
      {layout && shown ? (
        <div contentEditable={false} className='select-none'>
          <div className='absolute top-0 right-0 left-6 h-6 overflow-hidden'>
            {shown.columns.map((index) => (
              <Grip
                key={index}
                axis='column'
                index={index}
                count={layout.columns.length}
                align={layout.aligns[index]}
                style={{ left: layout.x + layout.columns[index].start + layout.columns[index].size / 2 - scrollLeft }}
                onCommand={onCommand}
                onDrag={(x, y) => dragTo('column', index, x, y)}
                onDrop={drop}
              />
            ))}
            {shown.columnLines.map((index) => (
              <InsertButton
                key={index}
                label='Insert column here'
                style={{ left: layout.x + columnLines[index] - scrollLeft, top: '50%' }}
                onInsert={() => onCommand({ type: 'insertColumn', index })}
              />
            ))}
          </div>
          <div className='absolute top-6 bottom-0 left-0 w-6'>
            {shown.rows.map((index) => (
              <Grip
                key={index}
                axis='row'
                index={index}
                count={layout.rows.length}
                style={{ top: layout.y + layout.rows[index].start + layout.rows[index].size / 2 }}
                onCommand={onCommand}
                onDrag={(x, y) => dragTo('row', index, x, y)}
                onDrop={drop}
              />
            ))}
            {shown.rowLines.map((index) => (
              <InsertButton
                key={index}
                label='Insert row here'
                style={{ top: layout.y + rowLines[index], left: '50%' }}
                onInsert={() => onCommand({ type: 'insertRow', index })}
              />
            ))}
          </div>
          <TableGrip onCommand={onCommand} />
          {drag && landing(drag) !== drag.from ? (
            // Where the dragged row or column will land, drawn across the
            // frame from its top-left corner. Over its own edges a drop moves
            // nothing, so there is no line to promise a move.
            <div aria-hidden className='pointer-events-none absolute top-6 left-6'>
              <div
                className='absolute bg-primary'
                style={
                  drag.axis === 'column'
                    ? { left: layout.x + columnLines[drag.boundary] - scrollLeft - 1, width: 2, height: layout.height }
                    : { top: layout.y + rowLines[drag.boundary] - 1, height: 2, width: layout.width }
                }
              />
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
