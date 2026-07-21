'use client'

import { useState, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, Pencil } from 'lucide-react'

import { ChatListItem } from '@/components/ui/chat/chat-list-item'
import { cn } from '@/lib/utils'

export interface ChatListLeaf {
  id: string
  title: string
  description?: string
  avatarUrl?: string | null
  pending?: boolean
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
  onChange?: (nodes: ChatListNode[]) => void
  onRenameFolder?: (folderId: string, name: string) => void
  className?: string
}

type TopEntry = { kind: 'item'; id: string } | { kind: 'folder'; id: string }

interface FolderState {
  name: string
  open: boolean
  itemIds: string[]
}

interface ListState {
  items: Record<string, ChatListLeaf>
  folders: Record<string, FolderState>
  top: TopEntry[]
}

type Drag = { id: string; kind: 'item' | 'folder' }

type Over =
  | { type: 'line'; container: 'top' | 'folder'; folderId?: string; index: number; pos: 'before' | 'after' }
  | { type: 'inside'; folderId: string }
  | { type: 'end'; container: 'top' | 'folder'; folderId?: string }

function initState(nodes: ChatListNode[], defaultFolderOpen: boolean): ListState {
  const items: Record<string, ChatListLeaf> = {}
  const folders: Record<string, FolderState> = {}
  const top: TopEntry[] = []
  for (const n of nodes) {
    if (n.type === 'item') {
      items[n.item.id] = { ...n.item }
      top.push({ kind: 'item', id: n.item.id })
    } else {
      folders[n.folder.id] = {
        name: n.folder.name,
        open: n.folder.open ?? defaultFolderOpen,
        itemIds: n.folder.items.map((i) => i.id),
      }
      for (const i of n.folder.items) items[i.id] = { ...i }
      top.push({ kind: 'folder', id: n.folder.id })
    }
  }
  return { items, folders, top }
}

function stateToNodes(s: ListState): ChatListNode[] {
  return s.top.map((e) =>
    e.kind === 'item'
      ? { type: 'item', item: s.items[e.id] }
      : {
          type: 'folder',
          folder: {
            id: e.id,
            name: s.folders[e.id].name,
            open: s.folders[e.id].open,
            items: s.folders[e.id].itemIds.map((id) => s.items[id]),
          },
        },
  )
}

function findItem(s: ListState, id: string): { container: 'top' | 'folder'; folderId?: string; index: number } | null {
  const ti = s.top.findIndex((e) => e.kind === 'item' && e.id === id)
  if (ti >= 0) return { container: 'top', index: ti }
  for (const fid of Object.keys(s.folders)) {
    const idx = s.folders[fid].itemIds.indexOf(id)
    if (idx >= 0) return { container: 'folder', folderId: fid, index: idx }
  }
  return null
}

function removeItem(s: ListState, id: string): boolean {
  const loc = findItem(s, id)
  if (!loc) return false
  if (loc.container === 'top') s.top.splice(loc.index, 1)
  else s.folders[loc.folderId as string].itemIds.splice(loc.index, 1)
  return true
}

// Pure tree transform. Folders live only at the top level (never nested) — the
// logic never inserts a folder into a folder's items, enforcing one level.
function applyDrop(s: ListState, drag: Drag, over: Over): ListState {
  const next: ListState = JSON.parse(JSON.stringify(s))

  if (over.type === 'end') {
    if (over.container === 'top') {
      if (drag.kind === 'item') {
        if (!removeItem(next, drag.id)) return s
        next.top.push({ kind: 'item', id: drag.id })
      } else {
        const fi = next.top.findIndex((e) => e.kind === 'folder' && e.id === drag.id)
        if (fi < 0) return s
        const [me] = next.top.splice(fi, 1)
        next.top.push(me)
      }
      return next
    }
    // end of a folder (items only)
    if (drag.kind !== 'item') return s
    if (!removeItem(next, drag.id)) return s
    const f = next.folders[over.folderId as string]
    if (!f) return s
    f.itemIds.push(drag.id)
    return next
  }

  if (over.type === 'inside') {
    if (drag.kind !== 'item') return s
    if (!removeItem(next, drag.id)) return s
    const f = next.folders[over.folderId]
    if (!f) return s
    f.itemIds.push(drag.id)
    return next
  }

  // over.type === 'line'
  if (drag.kind === 'item') {
    const loc = findItem(next, drag.id)
    if (!loc) return s
    if (!removeItem(next, drag.id)) return s
    let target = over.index + (over.pos === 'after' ? 1 : 0)
    if (over.container === 'top') {
      if (loc.container === 'top' && loc.index < over.index) target -= 1
      next.top.splice(target, 0, { kind: 'item', id: drag.id })
    } else {
      const f = next.folders[over.folderId as string]
      if (!f) return s
      if (loc.container === 'folder' && loc.folderId === over.folderId && loc.index < over.index) target -= 1
      f.itemIds.splice(target, 0, drag.id)
    }
    return next
  }

  // folder reorder, top level only
  if (over.container !== 'top') return s
  const fi = next.top.findIndex((e) => e.kind === 'folder' && e.id === drag.id)
  if (fi < 0) return s
  next.top.splice(fi, 1)
  let target = over.index + (over.pos === 'after' ? 1 : 0)
  if (fi < over.index) target -= 1
  target = Math.max(0, Math.min(target, next.top.length))
  next.top.splice(target, 0, { kind: 'folder', id: drag.id })
  return next
}

// A container for chat-list-items. Drag a row to reorder; drop an item onto a
// folder (header middle) to file it inside, or onto a folder's top/bottom third
// to place it beside the folder. Folders are one level deep, collapsible, and
// renameable in place (hover the pencil). Self-contained — keeps its own working
// copy of the tree (seeded from `nodes`) so it's interactive in the preview, and
// calls `onChange` whenever the structure changes / `onRenameFolder` on rename.
export function ChatList({ nodes, activeId, defaultFolderOpen = true, onSelect, onChange, onRenameFolder, className }: ChatListProps) {
  const [state, setState] = useState<ListState>(() => initState(nodes, defaultFolderOpen))
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const reset = () => {
    setDrag(null)
    setOver(null)
  }

  const performDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!drag || !over) {
      reset()
      return
    }
    const next = applyDrop(state, drag, over)
    if (next !== state) {
      setState(next)
      onChange?.(stateToNodes(next))
    }
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
    const next: ListState = { ...state, folders: { ...state.folders, [id]: { ...f, name } } }
    setState(next)
    onRenameFolder?.(id, name)
    onChange?.(stateToNodes(next))
  }

  const renderItem = (id: string, container: 'top' | 'folder', folderId: string | undefined, index: number) => {
    const leaf = state.items[id]
    if (!leaf) return null
    const isDragged = drag?.kind === 'item' && drag.id === id
    const line =
      over?.type === 'line' && over.container === container && over.folderId === folderId && over.index === index
        ? over.pos
        : null
    return (
      <div key={id} className='relative'>
        {line === 'before' ? <div className='absolute -top-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' /> : null}
        <div
          draggable
          onDragStart={(e) => {
            setDrag({ id, kind: 'item' })
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', id)
          }}
          onDragOver={(e) => {
            if (!drag || drag.kind === 'folder') return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            const r = e.currentTarget.getBoundingClientRect()
            setOver({ type: 'line', container, folderId, index, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
          }}
          onDrop={performDrop}
          className={cn(isDragged && 'opacity-40')}
        >
          <ChatListItem
            id={leaf.id}
            title={leaf.title}
            description={leaf.description}
            avatarUrl={leaf.avatarUrl}
            pending={leaf.pending}
            active={leaf.id === activeId}
            onSelect={onSelect}
            onRename={() => {}}
            onClose={() => {}}
            onDelete={() => {}}
          />
        </div>
        {line === 'after' ? <div className='absolute -bottom-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' /> : null}
      </div>
    )
  }

  return (
    <div
      className={cn('relative flex w-full min-w-0 flex-col gap-0.5', className)}
      onDragEnd={reset}
      onDragOver={(e) => {
        if (!drag) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver({ type: 'end', container: 'top' })
      }}
      onDrop={performDrop}
    >
      {state.top.map((entry, i) => {
        if (entry.kind === 'folder') {
          const f = state.folders[entry.id]
          const isDraggedFolder = drag?.kind === 'folder' && drag.id === entry.id
          const inside = over?.type === 'inside' && over.folderId === entry.id
          const line = over?.type === 'line' && over.container === 'top' && over.index === i ? over.pos : null
          return (
            <div key={entry.id} className='relative'>
              {line === 'before' ? <div className='absolute -top-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' /> : null}
              <div
                draggable={editing !== entry.id}
                onDragStart={(e) => {
                  setDrag({ id: entry.id, kind: 'folder' })
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', entry.id)
                }}
                onDragOver={(e) => {
                  if (!drag) return
                  e.preventDefault()
                  e.stopPropagation()
                  e.dataTransfer.dropEffect = 'move'
                  const r = e.currentTarget.getBoundingClientRect()
                  const ratio = (e.clientY - r.top) / r.height
                  if (drag.kind === 'item') {
                    if (ratio < 1 / 3) setOver({ type: 'line', container: 'top', index: i, pos: 'before' })
                    else if (ratio > 2 / 3) setOver({ type: 'line', container: 'top', index: i, pos: 'after' })
                    else setOver({ type: 'inside', folderId: entry.id })
                  } else {
                    setOver({ type: 'line', container: 'top', index: i, pos: ratio < 0.5 ? 'before' : 'after' })
                  }
                }}
                onDrop={performDrop}
                className={cn(
                  'group flex cursor-grab items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:bg-muted',
                  inside && 'ring-2 ring-primary ring-inset',
                  isDraggedFolder && 'opacity-40',
                )}
              >
                {editing === entry.id ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitRename(entry.id)
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        setEditing(null)
                      }
                    }}
                    onBlur={() => commitRename(entry.id)}
                    className='min-w-0 flex-1 rounded-sm bg-background px-1 py-0.5 text-foreground outline-none ring-1 ring-ring'
                  />
                ) : (
                  <button
                    type='button'
                    onClick={() => setState((s) => ({ ...s, folders: { ...s.folders, [entry.id]: { ...s.folders[entry.id], open: !s.folders[entry.id].open } } }))}
                    className='inline-flex min-w-0 flex-1 items-center gap-1 outline-none'
                  >
                    {f.open ? <ChevronDown className='size-3.5 shrink-0' /> : <ChevronRight className='size-3.5 shrink-0' />}
                    {f.open ? <FolderOpen className='size-3.5 shrink-0' /> : <Folder className='size-3.5 shrink-0' />}
                    <span className='truncate'>{f.name}</span>
                  </button>
                )}
                {editing !== entry.id ? (
                  <button
                    type='button'
                    aria-label='Rename folder'
                    onClick={(e) => {
                      e.stopPropagation()
                      startRename(entry.id, f.name)
                    }}
                    className='inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground/70 opacity-0 hover:bg-background hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100'
                  >
                    <Pencil className='size-3' />
                  </button>
                ) : null}
              </div>
              {f.open ? (
                <div
                  className='relative flex flex-col gap-0.5 py-0.5 pl-3'
                  onDragOver={(e) => {
                    if (drag?.kind !== 'item') return
                    e.preventDefault()
                    e.stopPropagation()
                    e.dataTransfer.dropEffect = 'move'
                    setOver({ type: 'end', container: 'folder', folderId: entry.id })
                  }}
                  onDrop={performDrop}
                >
                  {f.itemIds.map((itemId, j) => renderItem(itemId, 'folder', entry.id, j))}
                  {over?.type === 'end' && over.container === 'folder' && over.folderId === entry.id ? (
                    <div className='pointer-events-none absolute bottom-0 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' />
                  ) : null}
                </div>
              ) : null}
              {line === 'after' ? <div className='absolute -bottom-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' /> : null}
            </div>
          )
        }
        return renderItem(entry.id, 'top', undefined, i)
      })}
      {over?.type === 'end' && over.container === 'top' ? <div className='pointer-events-none absolute bottom-0 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' /> : null}
    </div>
  )
}
