'use client'

import { useState, useRef, type DragEvent, type PointerEvent } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Pencil, Trash2 } from 'lucide-react'

import { ChatListItem, type ChatListItemAction, type ChatStatus } from '@/components/ui/chat/chat-list-item'
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

// Horizontal movement past this starts a touch pointer-drag.
const MOVE_TOLERANCE_PX = 8

// An in-flight touch press on a row. Held in a ref (no re-render) until it
// either becomes a drag or is cancelled (movement stays sub-tolerance, the
// finger lifts, or the row menu opens -- see `handleMenuOpen`).
interface TouchPress {
  id: string
  list: string
  pointerId: number
  startX: number
  startY: number
  dragging: boolean
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
// via **Move to new folder** in its row menu. Folder headers have always-visible
// rename + delete (delete returns the chats to the loose list). Self-contained;
// calls onChange on every structural change.
//
// Touch gesture arbitration: the row menu opens through Radix's
// native contextmenu (right-click on desktop, the browser's long-press on
// touch -- ContextMenu has no controlled/imperative open). A per-row pointer
// controller (touch only) starts a pointer-based drag on horizontal movement;
// when a row's menu opens, `handleMenuOpen` cancels the in-flight press so the
// long-press that opened the menu can't also start a drag. Vertical movement is
// left to the browser (pan-y scroll). Desktop mouse drag (native HTML5 DnD) and
// right-click are untouched.
export function ChatList({ nodes, activeId, defaultFolderOpen = true, onSelect, onRename, onStopProcess, onClose, onDelete, onChange, onRenameFolder, onCreateFolder, onDeleteFolder, className }: ChatListProps) {
  const [state, setState] = useState<ListState>(() => initState(nodes, defaultFolderOpen))
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Live position of the pointer-dragged row, to render the lifted ghost.
  const [touchDrag, setTouchDrag] = useState<{ id: string; x: number; y: number } | null>(null)
  const idCounter = useRef(0)
  const pressRef = useRef<TouchPress | null>(null)

  const reset = () => {
    setDrag(null)
    setOver(null)
  }

  const clearPress = () => {
    pressRef.current = null
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

  // --- Touch gesture arbitration ---

  // The folder header under a screen point, if any (used to hit-test drop
  // targets during a pointer drag).
  const folderAtPoint = (x: number, y: number): string | null => {
    if (typeof document === 'undefined') return null
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const header = el?.closest('[data-folder-header]') as HTMLElement | null
    return header?.dataset.folderId ?? null
  }

  // The row menu just opened (Radix native contextmenu). Cancel the in-flight
  // touch press so the long-press that opened the menu can't also start a drag;
  // if a drag had already begun, abort it.
  const handleMenuOpen = (open: boolean) => {
    if (!open) return
    if (pressRef.current?.dragging) {
      setTouchDrag(null)
      reset()
    }
    clearPress()
  }

  const onTouchPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = pressRef.current
    if (!p || p.pointerId !== e.pointerId) return
    const dx = Math.abs(e.clientX - p.startX)
    const dy = Math.abs(e.clientY - p.startY)
    if (!p.dragging) {
      if (dx > MOVE_TOLERANCE_PX && dx > dy) {
        // Horizontal move wins -> start a pointer drag.
        p.dragging = true
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag({ kind: 'item', id: p.id, from: p.list })
        setTouchDrag({ id: p.id, x: e.clientX, y: e.clientY })
        const fid = folderAtPoint(e.clientX, e.clientY)
        setOver(fid ? { kind: 'folder', folderId: fid } : null)
      }
      return
    }
    // Already dragging: follow the finger and highlight the folder under it.
    setTouchDrag({ id: p.id, x: e.clientX, y: e.clientY })
    const fid = folderAtPoint(e.clientX, e.clientY)
    setOver(fid ? { kind: 'folder', folderId: fid } : null)
  }

  const onTouchPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const p = pressRef.current
    if (!p || p.pointerId !== e.pointerId) return
    if (p.dragging) {
      const fid = folderAtPoint(e.clientX, e.clientY)
      let target: Over | null = null
      if (fid) target = { kind: 'folder', folderId: fid }
      else if (p.list !== 'items') target = { kind: 'top-level' }
      // else: dropped in empty space while already top-level -> no-op
      if (target) {
        const next = applyDrop(state, { kind: 'item', id: p.id, from: p.list }, target)
        if (next !== state) commit(next)
      }
      setTouchDrag(null)
      reset()
    }
    clearPress()
  }

  const onTouchPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    const p = pressRef.current
    if (!p || p.pointerId !== e.pointerId) return
    if (p.dragging) {
      setTouchDrag(null)
      reset()
    }
    clearPress()
  }

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
          draggable
          onPointerDown={(e) => {
            // Touch-only gesture arbitration; mouse falls through to native DnD.
            if (e.pointerType !== 'touch') return
            pressRef.current = { id, list, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dragging: false }
          }}
          onPointerMove={onTouchPointerMove}
          onPointerUp={onTouchPointerUp}
          onPointerCancel={onTouchPointerCancel}
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
          className={cn(isDragged && 'opacity-40')}
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
                'flex cursor-grab items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:bg-muted',
                isDraggedFolder && 'opacity-40',
                intoThis && 'ring-2 ring-primary bg-primary/10',
              )}
            >
              {editing === fid ? (
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
              ) : (
                <button
                  type='button'
                  onClick={() => setState((s) => ({ ...s, folders: { ...s.folders, [fid]: { ...s.folders[fid], open: !s.folders[fid].open } } }))}
                  className='inline-flex min-w-0 flex-1 items-center gap-1 outline-none'
                >
                  {f.open ? <ChevronDown className='size-3.5 shrink-0' /> : <ChevronRight className='size-3.5 shrink-0' />}
                  {f.open ? <FolderOpen className='size-3.5 shrink-0' /> : <Folder className='size-3.5 shrink-0' />}
                  <span className='truncate'>{f.name}</span>
                </button>
              )}
              {editing !== fid ? (
                <>
                  <button
                    type='button'
                    aria-label='Rename folder'
                    onClick={(e) => {
                      e.stopPropagation()
                      startRename(fid, f.name)
                    }}
                    className='inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground'
                  >
                    <Pencil className='size-3' />
                  </button>
                  <button
                    type='button'
                    aria-label='Delete folder'
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteFolder(fid)
                    }}
                    className='inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-destructive'
                  >
                    <Trash2 className='size-3' />
                  </button>
                </>
              ) : null}
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

      {/* Lifted ghost following the finger during a touch pointer-drag. */}
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
