'use client'

import { useState, useRef, useEffect, type DragEvent, type TouchEvent as ReactTouchEvent } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Pencil, Trash2 } from 'lucide-react'

import { ChatListItem, type ChatListItemAction, type ChatStatus } from '@/components/ui/chat/chat-list-item'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'

export interface ChatListLeaf {
  id: string
  title: string
  description?: string
  avatarUrl?: string | null
  status?: ChatStatus
  hasDraft?: boolean
}

export interface ChatListFolderInput {
  id: string
  name: string
  open?: boolean
  items: ChatListLeaf[]
}

export type ChatListNode =
  | { type: 'item'; item: ChatListLeaf }
  | { type: 'folder'; folder: ChatListFolderInput }

interface ChatListProps {
  nodes: ChatListNode[]
  activeId?: string
  defaultFolderOpen?: boolean
  onSelect?: (id: string) => void
  onRename?: (id: string) => void
  onStopProcess?: (id: string) => void
  onClose?: (id: string) => void
  onDelete?: (id: string) => void
  onChange?: (nodes: ChatListNode[]) => void
  onRenameFolder?: (folderId: string, name: string) => void
  onCreateFolder?: (folderId: string) => void
  onDeleteFolder?: (folderId: string) => void
  className?: string
}

interface FolderState {
  name: string
  open: boolean
  itemIds: string[]
}

interface ListState {
  items: Record<string, ChatListLeaf>
  folders: Record<string, FolderState>
  folderOrder: string[]
  itemOrder: string[]
}

// A drag payload. Items carry their source list so they can move across lists;
// folders only reorder among themselves.
type Drag =
  | { kind: 'item'; id: string; from: string }
  | { kind: 'folder'; id: string }

// Where a drop would land: between two items in a list, onto a folder (append),
// or onto the top-level drop zone.
type Over =
  | { kind: 'item-slot'; list: string; index: number; pos: 'before' | 'after' }
  | { kind: 'folder'; folderId: string }
  | { kind: 'top-level' }

// Long-press pickup activation constraint (the dnd-kit pattern):
// a press held still this long arms a drag; moving past the tolerance before it
// fires is a scroll. The tolerance sits below the browser's touch-slop so a
// still hold never accidentally scrolls, and the delay sits well under the row
// menu's ~700ms long-press so a drag commits first.
const PICKUP_DELAY_MS = 250
const PICKUP_TOLERANCE_PX = 5

// An in-flight touch press on a row. Held in a ref (no re-render) until it drags,
// scrolls, is released as a press (-> row menu), or is dropped when the row menu
// opens (see `handleMenuOpen`). `move`/`end` are the non-passive window listeners
// bound for this one press.
interface Press {
  id: string
  list: string
  startX: number
  startY: number
  committed: boolean
  aborted: boolean
  moved: boolean
  timer: ReturnType<typeof setTimeout> | null
  move?: (e: TouchEvent) => void
  end?: (e: TouchEvent) => void
}

function initState(nodes: ChatListNode[], defaultFolderOpen: boolean): ListState {
  const items: Record<string, ChatListLeaf> = {}
  const folders: Record<string, FolderState> = {}
  const folderOrder: string[] = []
  const itemOrder: string[] = []
  for (const n of nodes) {
    if (n.type === 'item') {
      items[n.item.id] = { ...n.item }
      itemOrder.push(n.item.id)
    } else {
      folders[n.folder.id] = {
        name: n.folder.name,
        open: n.folder.open ?? defaultFolderOpen,
        itemIds: n.folder.items.map((i) => i.id),
      }
      for (const i of n.folder.items) items[i.id] = { ...i }
      folderOrder.push(n.folder.id)
    }
  }
  return { items, folders, folderOrder, itemOrder }
}

function stateToNodes(s: ListState): ChatListNode[] {
  const out: ChatListNode[] = s.folderOrder.map((id) => ({
    type: 'folder',
    folder: { id, name: s.folders[id].name, open: s.folders[id].open, items: s.folders[id].itemIds.map((iid) => s.items[iid]) },
  }))
  for (const id of s.itemOrder) out.push({ type: 'item', item: s.items[id] })
  return out
}

function clone(s: ListState): ListState {
  return JSON.parse(JSON.stringify(s))
}

// Resolve a list id ('items' | `folder:${id}`) to the live order array in s.
function listRef(s: ListState, list: string): string[] | null {
  if (list === 'items') return s.itemOrder
  if (list.startsWith('folder:')) return s.folders[list.slice(7)]?.itemIds ?? null
  return null
}

// Apply a drop to a cloned state. Items may cross lists (move between folders,
// in/out of the top level); folders only reorder within the folder list.
function applyDrop(s: ListState, drag: Drag, over: Over): ListState {
  if (drag.kind === 'folder') {
    if (over.kind !== 'item-slot' || over.list !== 'folders') return s
    const next = clone(s)
    const list = next.folderOrder
    const from = list.indexOf(drag.id)
    if (from < 0) return s
    const to = over.index + (over.pos === 'after' ? 1 : 0)
    list.splice(from, 1)
    let target = from < to ? to - 1 : to
    target = Math.max(0, Math.min(target, list.length))
    list.splice(target, 0, drag.id)
    return next
  }

  // item
  const next = clone(s)
  const fromList = listRef(next, drag.from)
  if (!fromList) return s
  const fromIdx = fromList.indexOf(drag.id)
  if (fromIdx < 0) return s
  fromList.splice(fromIdx, 1)

  if (over.kind === 'folder') {
    const f = next.folders[over.folderId]
    if (!f) return s
    f.itemIds.push(drag.id)
    return next
  }
  if (over.kind === 'top-level') {
    next.itemOrder.push(drag.id)
    return next
  }

  // item-slot — items never enter the folder-order list
  if (over.list === 'folders') return s
  const toList = listRef(next, over.list)
  if (!toList) return s
  let to = over.index + (over.pos === 'after' ? 1 : 0)
  // same-list moves need to account for the just-removed element shifting indices
  if (drag.from === over.list && fromIdx < to) to -= 1
  to = Math.max(0, Math.min(to, toList.length))
  toList.splice(to, 0, drag.id)
  return next
}

// A container for chat-list-items. **Folders always sit above loose items.**
// Items drag freely: between folders, into a folder (drop on its header), out to
// the top level (drop on the 'Move to top level' zone), or before/after another
// item. Folders reorder among themselves. File an item into a brand-new folder
// via **Move to new folder** in its row menu. Folder headers carry no
// always-visible buttons: rename + delete are reached through the same context
// menu the chat rows use (right-click / long-press), each entry only when the
// host passed its callback. Self-contained;
// calls onChange on every structural change.
//
// Touch gesture arbitration (long-press pickup, no grip): the row
// carries NO grip -- one press serves scroll, drag and menu, and movement tells
// them apart (the dnd-kit `activationConstraint { delay, tolerance }` pattern).
// Finger down starts a ~250ms timer; move past ~5px before it fires is a scroll
// (handed to the browser); still within tolerance when it fires arms the row (a
// brief lift), and any later movement drags it in ANY direction (vertical
// included: filing a chat into a folder is a vertical drag). Once armed, dragging
// has to take the gesture off the browser, and with no touch-action:none element
// to start from that means a NON-PASSIVE touchmove listener (bound on the press)
// calling preventDefault -- pointer events can't be cancelled, which is why the
// earlier handle-less attempt failed. Released without moving, the press is left
// to the row menu, which opens via Radix's own ~700ms long-press (movement
// cancels it); our 250ms pickup sits comfortably below it, and `handleMenuOpen`
// drops an armed pickup the moment the menu opens. Desktop mouse drag (native
// HTML5 DnD on the whole row) and right-click are untouched.
export function ChatList({ nodes, activeId, defaultFolderOpen = true, onSelect, onRename, onStopProcess, onClose, onDelete, onChange, onRenameFolder, onCreateFolder, onDeleteFolder, className }: ChatListProps) {
  const [state, setState] = useState<ListState>(() => initState(nodes, defaultFolderOpen))
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Live position of the pointer-dragged row, to render the lifted ghost.
  const [touchDrag, setTouchDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  // The row armed by a still long-press (picked up, not yet dragged): rendered
  // with a lift style; cleared on drag, drop, release or menu-open.
  const [liftedId, setLiftedId] = useState<string | null>(null)
  const idCounter = useRef(0)
  const pressRef = useRef<Press | null>(null)
  // Mirror of `state` for the async touch handlers (they fire off-render).
  const stateRef = useRef(state)
  stateRef.current = state

  const reset = () => {
    setDrag(null)
    setOver(null)
  }

  // Tear down an in-flight touch press (timer + non-passive window listeners)
  // and clear its visual state. Used when the row menu opens mid-press and on
  // unmount.
  const cancelPress = () => {
    const p = pressRef.current
    if (!p) return
    if (p.timer) { clearTimeout(p.timer); p.timer = null }
    if (p.move) window.removeEventListener('touchmove', p.move)
    if (p.end) {
      window.removeEventListener('touchend', p.end)
      window.removeEventListener('touchcancel', p.end)
    }
    pressRef.current = null
    setLiftedId(null)
  }

  const commit = (next: ListState) => {
    setState(next)
    onChange?.(stateToNodes(next))
  }

  const performDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!drag || !over) {
      reset()
      return
    }
    const next = applyDrop(state, drag, over)
    if (next !== state) commit(next)
    reset()
  }

  const startRename = (id: string, name: string) => {
    setEditing(id)
    setDraft(name)
  }

  const commitRename = (id: string) => {
    const name = draft.trim()
    setEditing(null)
    if (!name) return
    const f = state.folders[id]
    if (!f || f.name === name) return
    commit({ ...state, folders: { ...state.folders, [id]: { ...f, name } } })
    onRenameFolder?.(id, name)
  }

  const newFolderId = () => {
    let id = ''
    do {
      idCounter.current += 1
      id = `folder-${idCounter.current}`
    } while (state.folders[id])
    return id
  }

  // 'Move to new folder': create a folder after the last folder and move the
  // item into it.
  const moveToNewFolder = (itemId: string) => {
    const next: ListState = clone(state)
    const fromList = listRef(next, 'items')?.includes(itemId) ? listRef(next, 'items') : next.folderOrder.map((fid) => next.folders[fid].itemIds).find((l) => l.includes(itemId))
    if (!fromList) return
    fromList.splice(fromList.indexOf(itemId), 1)
    const id = newFolderId()
    next.folders[id] = { name: 'New folder', open: true, itemIds: [itemId] }
    next.folderOrder.push(id)
    commit(next)
    onCreateFolder?.(id)
    startRename(id, 'New folder')
  }

  const deleteFolder = (id: string) => {
    const next: ListState = clone(state)
    const f = next.folders[id]
    if (!f) return
    next.itemOrder.push(...f.itemIds)
    delete next.folders[id]
    next.folderOrder = next.folderOrder.filter((fid) => fid !== id)
    commit(next)
    onDeleteFolder?.(id)
  }

  const itemActions: ChatListItemAction[] = [
    { label: 'Move to new folder', icon: <FolderPlus className='size-3' />, onSelect: moveToNewFolder },
  ]

  // --- Touch gesture arbitration (long-press pickup, no grip) ---

  // The folder header under a screen point, if any (used to hit-test drop
  // targets while a row is dragged).
  const folderAtPoint = (x: number, y: number): string | null => {
    if (typeof document === 'undefined') return null
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const header = el?.closest('[data-folder-header]') as HTMLElement | null
    return header?.dataset.folderId ?? null
  }

  // The row menu opened (Radix native long-press, ~700ms -- comfortably above our
  // 250ms pickup). A still press that reached the menu is a menu invocation, not
  // a drag: drop the armed pickup so the lift snaps back. (Movement already
  // canceled the menu before it could open, so a real drag never reaches here.)
  const handleMenuOpen = (open: boolean) => {
    if (!open) return
    cancelPress()
  }

  // One press serves scroll, drag and menu; movement tells them apart. On finger
  // down we start a PICKUP_DELAY_MS timer and watch for movement. Move past the
  // tolerance before it fires -> scroll (never preventDefault'd, the browser
  // keeps it). Still within tolerance when it fires -> arm the row (lift). Any
  // move after that drags it -- and dragging has to take the gesture off the
  // browser, which (with no touch-action:none grip) means a NON-PASSIVE touchmove
  // calling preventDefault; pointer events can't be cancelled, which is why the
  // earlier handle-less attempt failed. Release without moving leaves the press
  // to the row menu.
  const startPress = (id: string, list: string, e: ReactTouchEvent<HTMLDivElement>) => {
    if (pressRef.current) return
    const t0 = e.touches[0]
    const p: Press = { id, list, startX: t0.clientX, startY: t0.clientY, committed: false, aborted: false, moved: false, timer: null }
    pressRef.current = p

    const move = (ev: TouchEvent) => {
      if (pressRef.current !== p) return
      const t = ev.touches[0]
      const dx = t.clientX - p.startX
      const dy = t.clientY - p.startY
      if (p.aborted) return
      if (!p.committed) {
        if (Math.abs(dx) > PICKUP_TOLERANCE_PX || Math.abs(dy) > PICKUP_TOLERANCE_PX) {
          // Moved before the pickup delay -> a scroll. Hand the gesture back; we
          // never preventDefault'd, so the browser scrolls.
          p.aborted = true
          if (p.timer) { clearTimeout(p.timer); p.timer = null }
          setLiftedId(null)
        }
        return
      }
      // Armed: this movement drags the row. Cancel the browser's scroll.
      ev.preventDefault()
      if (!p.moved) {
        p.moved = true
        setLiftedId(null)
        setDrag({ kind: 'item', id: p.id, from: p.list })
      }
      setTouchDrag({ id: p.id, x: t.clientX, y: t.clientY })
      const fid = folderAtPoint(t.clientX, t.clientY)
      setOver(fid ? { kind: 'folder', folderId: fid } : null)
    }

    const end = (ev: TouchEvent) => {
      if (pressRef.current !== p) return
      if (p.timer) { clearTimeout(p.timer); p.timer = null }
      if (p.committed && p.moved) {
        const t = ev.changedTouches[0]
        const fid = folderAtPoint(t.clientX, t.clientY)
        let target: Over | null = null
        if (fid) target = { kind: 'folder', folderId: fid }
        else if (p.list !== 'items') target = { kind: 'top-level' }
        // else: dropped in empty space while already top-level -> no-op
        if (target) {
          const next = applyDrop(stateRef.current, { kind: 'item', id: p.id, from: p.list }, target)
          if (next !== stateRef.current) commit(next)
        }
      }
      // committed && !moved -> a press; leave it to the row menu. aborted -> scroll.
      setTouchDrag(null)
      setLiftedId(null)
      setDrag(null)
      setOver(null)
      pressRef.current = null
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
    }

    p.move = move
    p.end = end

    p.timer = setTimeout(() => {
      if (pressRef.current !== p || p.aborted) return
      // Held still within tolerance for the delay -> pick the row up.
      p.committed = true
      setLiftedId(p.id)
    }, PICKUP_DELAY_MS)

    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', end)
    window.addEventListener('touchcancel', end)
  }

  // Drop any in-flight press if the list unmounts mid-gesture (no listener leak).
  useEffect(() => () => { cancelPress() }, [])

  const renderItem = (id: string, list: string, index: number) => {
    const leaf = state.items[id]
    if (!leaf) return null
    const isDragged = (drag?.kind === 'item' && drag.id === id) || touchDrag?.id === id
    const slotOver = over?.kind === 'item-slot' && over.list === list && over.index === index ? over : null
    return (
      <div key={id} className='relative'>
        {slotOver && slotOver.pos === 'before' ? (
          <div className='absolute -top-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' />
        ) : null}
        <div
          data-row-id={id}
          data-row-list={list}
          draggable
          onTouchStart={(e) => startPress(id, list, e)}
          onDragStart={(e) => {
            setDrag({ kind: 'item', id, from: list })
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', id)
          }}
          onDragOver={(e) => {
            // Any item can land before/after any other item, across lists.
            if (!drag || drag.kind !== 'item') return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            const r = e.currentTarget.getBoundingClientRect()
            setOver({ kind: 'item-slot', list, index, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
          }}
          onDrop={performDrop}
          className={cn(isDragged && 'opacity-40', liftedId === id && 'rounded-md bg-muted ring-2 ring-primary')}
        >
          <ChatListItem
            id={leaf.id}
            title={leaf.title}
            description={leaf.description}
            avatarUrl={leaf.avatarUrl}
            status={leaf.status}
            hasDraft={leaf.hasDraft}
            active={leaf.id === activeId}
            onSelect={onSelect}
            onRename={onRename}
            onStopProcess={onStopProcess}
            onClose={onClose}
            onDelete={onDelete}
            actions={itemActions}
            onMenuOpenChange={handleMenuOpen}
          />
        </div>
        {slotOver && slotOver.pos === 'after' ? (
          <div className='absolute -bottom-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' />
        ) : null}
      </div>
    )
  }

  return (
    <div className={cn('relative flex w-full min-w-0 flex-col gap-0.5', className)} onDragEnd={reset}>
      {state.folderOrder.map((fid, i) => {
        const f = state.folders[fid]
        const isDraggedFolder = drag?.kind === 'folder' && drag.id === fid
        const folderSlotOver = over?.kind === 'item-slot' && over.list === 'folders' && over.index === i ? over : null
        const intoThis = over?.kind === 'folder' && over.folderId === fid
        // The folder header label is the context-menu trigger (right-click on
        // desktop, long-press on touch -- the same mechanism the chat rows use)
        // when the host passed any folder action. No always-visible buttons on
        // the header; each entry shows only for the callback it needs. Rename
        // keeps its inline editing; delete returns the chats to the loose list.
        // The draggable header div around it stays the native HTML5 DnD source
        // and drop target for folder reorder / file-item-into-folder, so the
        // menu and drag never compete (right-click can't start a drag, and
        // folders don't drag on touch -- a menu opening starts nothing).
        const toggle = (
          <button
            type='button'
            onClick={() => setState((s) => ({ ...s, folders: { ...s.folders, [fid]: { ...s.folders[fid], open: !s.folders[fid].open } } }))}
            className='inline-flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 outline-none'
          >
            {f.open ? <ChevronDown className='size-3.5 shrink-0' /> : <ChevronRight className='size-3.5 shrink-0' />}
            {f.open ? <FolderOpen className='size-3.5 shrink-0' /> : <Folder className='size-3.5 shrink-0' />}
            <span className='truncate'>{f.name}</span>
          </button>
        )
        const headerLabel = editing === fid ? (
          <input
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                commitRename(fid)
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setEditing(null)
              }
            }}
            onBlur={() => commitRename(fid)}
            className='min-w-0 flex-1 rounded-sm bg-background px-1 py-0.5 text-foreground outline-none ring-1 ring-ring'
          />
        ) : onRenameFolder || onDeleteFolder ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>{toggle}</ContextMenuTrigger>
            <ContextMenuContent className='min-w-[8rem]' onClick={(e) => e.stopPropagation()}>
              {onRenameFolder ? (
                <ContextMenuItem onClick={() => startRename(fid, f.name)}>
                  <Pencil className='size-3' />
                  Rename
                </ContextMenuItem>
              ) : null}
              {onDeleteFolder ? (
                <ContextMenuItem className='text-destructive focus:text-destructive' onClick={() => deleteFolder(fid)}>
                  <Trash2 className='size-3' />
                  Delete
                </ContextMenuItem>
              ) : null}
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          toggle
        )
        return (
          <div key={fid} className='relative'>
            {folderSlotOver && folderSlotOver.pos === 'before' ? (
              <div className='absolute -top-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' />
            ) : null}
            <div
              data-folder-header
              data-folder-id={fid}
              draggable={editing !== fid}
              style={{ touchAction: 'pan-y', WebkitTouchCallout: 'none' }}
              onDragStart={(e) => {
                setDrag({ kind: 'folder', id: fid })
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', fid)
              }}
              onDragOver={(e) => {
                if (!drag) return
                if (drag.kind === 'item') {
                  // Dropping an item on a folder header files it in.
                  e.preventDefault()
                  e.stopPropagation()
                  e.dataTransfer.dropEffect = 'move'
                  setOver({ kind: 'folder', folderId: fid })
                } else if (drag.kind === 'folder' && drag.id !== fid) {
                  // Dropping a folder on another reorders them.
                  e.preventDefault()
                  e.stopPropagation()
                  e.dataTransfer.dropEffect = 'move'
                  const r = e.currentTarget.getBoundingClientRect()
                  setOver({ kind: 'item-slot', list: 'folders', index: i, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
                }
              }}
              onDrop={performDrop}
              className={cn(
                'flex cursor-grab items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted',
                isDraggedFolder && 'opacity-40',
                intoThis && 'ring-2 ring-primary bg-primary/10',
              )}
            >
              {headerLabel}
            </div>
            {f.open ? (
              <div className='flex flex-col gap-0.5 py-0.5 pl-3'>
                {f.itemIds.map((itemId, j) => renderItem(itemId, `folder:${fid}`, j))}
              </div>
            ) : null}
            {folderSlotOver && folderSlotOver.pos === 'after' ? (
              <div className='absolute -bottom-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' />
            ) : null}
          </div>
        )
      })}

      {state.itemOrder.map((id, i) => renderItem(id, 'items', i))}

      {/* While dragging an item, surface a clear 'out of any folder' target. */}
      {drag?.kind === 'item' && drag.from !== 'items' ? (
        <div
          onDragOver={(e) => {
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            setOver({ kind: 'top-level' })
          }}
          onDrop={performDrop}
          className={cn(
            'mt-1 flex items-center justify-center rounded-md border border-dashed py-1.5 text-[10px]',
            over?.kind === 'top-level' ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
          )}
        >
          Move to top level
        </div>
      ) : null}

      {/* Lifted ghost following the finger during a touch drag. */}
      {touchDrag ? (() => {
        const leaf = state.items[touchDrag.id]
        if (!leaf) return null
        return (
          <div
            className='pointer-events-none fixed z-50'
            style={{ left: touchDrag.x, top: touchDrag.y, transform: 'translateY(-50%)' }}
          >
            <div className='w-64 rounded-md bg-background p-1 shadow-lg ring-1 ring-border'>
              <ChatListItem
                id={leaf.id}
                title={leaf.title}
                description={leaf.description}
                avatarUrl={leaf.avatarUrl}
                status={leaf.status}
                hasDraft={leaf.hasDraft}
              />
            </div>
          </div>
        )
      })() : null}
    </div>
  )
}
