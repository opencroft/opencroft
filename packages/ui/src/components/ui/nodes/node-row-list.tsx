'use client'

import { type KeyboardEvent, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Pencil } from 'lucide-react'

import { NodeValueInput } from './node-value-input'
import { RowContextMenu } from '../utils/row-context-menu'
import { useRowDrag } from '../utils/row-drag'
import { cn } from 'cn'

/** One row of the list: what identifies it, and the name it shows. */
export interface NodeRow {
  id: string
  label: string
}

/** Where a dragged row would land: before or after the row at `index`. */
export interface NodeRowSlot {
  index: number
  pos: 'before' | 'after'
}

export interface NodeRowListProps {
  /** What the rows are, for assistive technology: "Inputs", "Cases". */
  label: string
  rows: NodeRow[]
  /** Told every row's id in the new order, once a row is dropped in another place. */
  onReorder: (ids: string[]) => void
  /**
   * Told a row's new name, trimmed: never an empty one, nor the same one. The
   * host may refuse it (a name another row has); the row then shows its own.
   */
  onRename: (id: string, label: string) => void
  /**
   * Deletes the row (the row menu's Delete, or Delete or Backspace on the row);
   * the host deletes whatever hangs on it too.
   */
  onDelete: (id: string) => void
  /**
   * Draws a row's line, its name and `rowEnd`, in its place, such as inside
   * the pin it names. What opens under the row (`rowBelow`) stays outside it.
   */
  wrapRow?: (row: NodeRow, content: ReactNode) => ReactNode
  /** Controls at the end of a row, after its name. */
  rowEnd?: (row: NodeRow) => ReactNode
  /** What opens under a row, such as another list of its own. */
  rowBelow?: (row: NodeRow) => ReactNode
  /** A field after the last row that adds one: told the trimmed, non-empty text. */
  add?: { label: string; placeholder: string; onAdd: (label: string) => void }
  className?: string
}

/** `ids` with `dragged` dropped at `slot`, or null when that leaves the order as it is. */
export function reorderedIds(ids: readonly string[], dragged: string, slot: NodeRowSlot): string[] | null {
  const from = ids.indexOf(dragged)
  if (from < 0) {
    return null
  }
  let to = slot.index + (slot.pos === 'after' ? 1 : 0)
  if (from < to) {
    to -= 1
  }
  if (to === from) {
    return null
  }
  const next = ids.filter((id) => id !== dragged)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, dragged)
  return next
}

/**
 * The host's own `list` put in the order `onReorder` reported. An entry `ids`
 * does not name (one added since the list was drawn) keeps its place after
 * the others.
 */
export function inRowOrder<T>(list: readonly T[], idOf: (entry: T) => string, ids: readonly string[]): T[] {
  const at = (entry: T) => {
    const i = ids.indexOf(idOf(entry))
    return i < 0 ? ids.length : i
  }
  return [...list].sort((a, b) => at(a) - at(b))
}

// Compact on a card; at least 44 px tall where the pointer is a finger, the
// height of the field that replaces the name while renaming.
const ROW = 'flex h-7 min-w-0 items-center gap-0.5 rounded-md pointer-coarse:h-11'
const SLOT_LINE = 'absolute left-1 right-1 z-10 h-0.5 rounded-full bg-primary'
// The keys a row takes beyond Enter, Space, the menu key and the arrows, as
// `aria-keyshortcuts` names them.
const ROW_KEYS = 'Shift+F10 Alt+ArrowUp Alt+ArrowDown Delete Backspace'

// The rows of an editable list on a node's card. A row is its name, as plain
// text; it moves by dragging, and its context menu renames or deletes it. The
// drag is the kit's row drag, the one the chat list runs: native drag and drop
// on a mouse; on touch a still hold picks the row up, and a longer still hold
// opens its menu. A press on a row neither drags the node nor pans the canvas.
//
// While a row is renamed its name is a node value field, focused: Enter or
// leaving it saves, Escape puts it back, and either way it is text again.
//
// From the keyboard each row is a stop of its own. The menu key, Shift+F10,
// Enter or Space opens its menu; the up and down arrows go to the row above
// or below; Alt with an arrow moves the row a place up or down; Delete or
// Backspace deletes it, as its menu's Delete does. A row keeps the focus
// through a move, a rename ended from the keyboard, and a Delete from the
// keyboard (the row then in its place takes it). The keys a row handles stop
// there, so an arrow on a row moves no node on the canvas and Delete deletes
// no node; every other key reaches the host.
//
// Rows are found by `data-node-row-list`, so a list drawn under a row of
// another (a port's choices under the port) takes only its own rows.
export function NodeRowList({
  label,
  rows,
  onReorder,
  onRename,
  onDelete,
  wrapRow,
  rowEnd,
  rowBelow,
  add,
  className,
}: NodeRowListProps) {
  const listId = useId()
  const [renaming, setRenaming] = useState<string | null>(null)
  const renameFieldRef = useRef<HTMLDivElement | null>(null)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const { drag, over, lifted, ghost, rootRef, rootProps, sourceProps } = useRowDrag<string, NodeRowSlot>({
    targetAt: (_dragged, element, point) => {
      const row = element?.closest<HTMLElement>('[data-node-row]')
      if (!row || row.dataset.nodeRowList !== listId) {
        return null
      }
      const box = row.getBoundingClientRect()
      return { index: Number(row.dataset.nodeRowIndex), pos: point.y < box.top + box.height / 2 ? 'before' : 'after' }
    },
    onDrop: (dragged, slot) => {
      const next = reorderedIds(
        rowsRef.current.map((r) => r.id),
        dragged,
        slot,
      )
      if (next) {
        onReorder(next)
      }
    },
  })

  // A row that keeps the focus until the host removes it, and then hands it
  // to the row now in its place: after a Delete from the keyboard, or a
  // rename ended with Enter or Escape (a choice renamed is a new row). The
  // host answers in a later render and may draw the row again before that (a
  // node's card draws a fresh `rows` on any change to the node), so the
  // request stands while the row is drawn. It ends with the hand-over, or
  // when the user puts the focus elsewhere. A moved row needs none: React
  // moves its element, which keeps the focus.
  const refocus = useRef<{ id: string; index: number } | null>(null)
  // The open menu was opened from the keyboard.
  const menuFromKeys = useRef(false)

  // This list's own rows in order, each with the element that takes its
  // focus (none while it is renamed): a list under a row has rows of its own.
  const ownRows = () =>
    [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-node-row]') ?? [])]
      .filter((line) => line.dataset.nodeRowList === listId)
      .map((line) => ({ id: line.dataset.nodeRow, name: line.querySelector<HTMLElement>('[data-node-row-name]') }))

  // A layout effect, so the focus is back in the same commit that dropped it,
  // before the host's own focus keeping sees a page with none.
  useLayoutEffect(() => {
    const want = refocus.current
    if (!want) {
      return
    }
    const own = ownRows()
    const kept = own.find((r) => r.id === want.id)
    if (kept) {
      kept.name?.focus()
      return
    }
    own[Math.min(want.index, own.length - 1)]?.name?.focus()
    refocus.current = null
  })

  // Deletes a row; one deleted from the keyboard hands its focus on.
  const deleteRow = (row: NodeRow, index: number, fromKeys: boolean) => {
    if (fromKeys) {
      refocus.current = { id: row.id, index }
    }
    onDelete(row.id)
  }

  const onRowKeyDown = (row: NodeRow, index: number) => (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey) || e.key === 'Enter' || e.key === ' ') {
      // Opened as a right-click opens it, anchored under the row's start.
      const box = e.currentTarget.getBoundingClientRect()
      menuFromKeys.current = true
      e.currentTarget.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left, clientY: box.bottom }),
      )
    } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      const to = index + (e.key === 'ArrowUp' ? -1 : 1)
      if (to >= 0 && to < rows.length) {
        if (e.altKey) {
          const next = reorderedIds(
            rows.map((r) => r.id),
            row.id,
            { index: to, pos: to < index ? 'before' : 'after' },
          )
          if (next) {
            onReorder(next)
          }
        } else {
          ownRows()[to]?.name?.focus()
        }
      }
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      deleteRow(row, index, true)
    } else {
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  // The field takes the focus once it is drawn, after the menu that asked for
  // it has closed.
  useEffect(() => {
    if (renaming === null) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const input = renameFieldRef.current?.querySelector('input')
      input?.focus()
      input?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [renaming])

  // A touch drag's ghost is placed against the list's own box. The finger's
  // point is in screen pixels, and a zoomed canvas scales the list, so the
  // point is brought back to the list's own pixels.
  const root = rootRef.current
  const scale = root && root.offsetWidth > 0 ? root.getBoundingClientRect().width / root.offsetWidth : 1
  const ghostRow = ghost ? rows.find((r) => r.id === ghost.drag) : undefined

  const name = (row: NodeRow, index: number) =>
    renaming === row.id ? (
      <div
        ref={renameFieldRef}
        className='min-w-0 flex-1'
        onKeyDownCapture={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') {
            refocus.current = { id: row.id, index }
          }
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setRenaming(null)
          }
        }}
      >
        <NodeValueInput
          kind='text'
          label={`Name of ${row.label}`}
          value={row.label}
          onCommit={(next) => {
            const text = String(next).trim()
            if (text !== '' && text !== row.label) {
              onRename(row.id, text)
            }
          }}
        />
      </div>
    ) : (
      <RowContextMenu
        entries={[{ label: 'Rename', icon: <Pencil className='size-3' />, onSelect: () => setRenaming(row.id) }]}
        onDelete={() => deleteRow(row, index, menuFromKeys.current)}
        onOpenChange={(open) => {
          if (!open) {
            menuFromKeys.current = false
          }
        }}
      >
        <div
          data-node-row-name=''
          role='button'
          tabIndex={0}
          aria-haspopup='menu'
          aria-keyshortcuts={ROW_KEYS}
          onKeyDown={onRowKeyDown(row, index)}
          onBlur={() => {
            // The user put the focus elsewhere, so no row takes it back. React
            // calls this for no row the host removes, so that one hands it on.
            refocus.current = null
          }}
          className='flex h-full min-w-0 flex-1 cursor-grab items-center rounded-md px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          <span className='truncate'>{row.label}</span>
        </div>
      </RowContextMenu>
    )

  return (
    <div
      ref={rootRef}
      role='list'
      aria-label={label}
      className={cn('nodrag nopan relative flex min-w-0 flex-col gap-0.5', className)}
      {...rootProps}
    >
      {rows.map((row, index) => {
        const slot = over && over.index === index ? over : null
        const line = (
          <div
            data-node-row={row.id}
            data-node-row-list={listId}
            data-node-row-index={index}
            {...sourceProps(row.id, { enabled: renaming !== row.id, text: row.label })}
            style={{ WebkitTouchCallout: 'none', userSelect: 'none' }}
            className={cn(
              ROW,
              'grow',
              renaming !== row.id && 'hover:bg-muted',
              drag === row.id && 'opacity-40',
              lifted === row.id && 'bg-muted ring-2 ring-primary',
            )}
          >
            {name(row, index)}
            {rowEnd?.(row)}
          </div>
        )
        return (
          <div key={row.id} role='listitem' className='relative flex min-w-0 flex-col gap-0.5'>
            {slot?.pos === 'before' ? <div className={cn(SLOT_LINE, '-top-0.5')} /> : null}
            {wrapRow ? wrapRow(row, line) : line}
            {rowBelow?.(row)}
            {slot?.pos === 'after' ? <div className={cn(SLOT_LINE, '-bottom-0.5')} /> : null}
          </div>
        )
      })}
      {add ? (
        <NodeValueInput
          kind='text'
          label={add.label}
          placeholder={add.placeholder}
          value=''
          onCommit={(next) => {
            const text = String(next).trim()
            if (text !== '') {
              add.onAdd(text)
            }
          }}
        />
      ) : null}
      {ghost && ghostRow ? (
        <div
          className='pointer-events-none absolute z-50 opacity-60'
          style={{ left: ghost.x / scale, top: ghost.y / scale, transform: 'translateY(-50%)' }}
        >
          <div className='rounded-md bg-background px-2 py-1 text-xs shadow-lg ring-1 ring-border'>{ghostRow.label}</div>
        </div>
      ) : null}
    </div>
  )
}
