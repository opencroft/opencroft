'use client'

import { useState, useRef, type DragEvent } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Pencil, Trash2 } from 'lucide-react'

import { ChatListItem, type ChatListItemAction } from '@/components/ui/chat/chat-list-item'
import type { StatusVariant } from '@/components/ui/utils/status-indicator'
import { cn } from '@/lib/utils'

export interface ChatListLeaf {
  id: string
  title: string
  description?: string
  avatarUrl?: string | null
  statusIndicator?: StatusVariant
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

type Drag =
  | { kind: 'folder'; id: string }
  | { kind: 'item'; id: string; list: string }

type Over = { list: string; index: number; pos: 'before' | 'after' }

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

// Reorder within a single list only. Folders never mix with items, and an item
// never leaves its container via drag — it enters a folder only through the
// "Move to new folder" row-menu action.
function applyDrop(s: ListState, drag: Drag, over: Over): ListState {
  const next: ListState = JSON.parse(JSON.stringify(s))

  if (drag.kind === 'folder') {
    if (over.list !== 'folders') return s
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

  // item — must stay in its own list
  if (drag.list !== over.list) return s
  const list = over.list === 'items' ? next.itemOrder : next.folders[over.list.slice(7)].itemIds
  const from = list.indexOf(drag.id)
  if (from < 0) return s
  const to = over.index + (over.pos === 'after' ? 1 : 0)
  list.splice(from, 1)
  let target = from < to ? to - 1 : to
  target = Math.max(0, Math.min(target, list.length))
  list.splice(target, 0, drag.id)
  return next
}

// A container for chat-list-items. **Folders always sit above loose items.**
// Reorder within a section only (folders with folders, items with items) — you
// can't drag chats between folders. File a chat into a folder via **Move to new
// folder** in its row menu (creates a folder after the last folder). Folder
// headers have always-visible rename + delete (delete returns the chats to the
// loose list). Self-contained; calls onChange on every structural change.
export function ChatList({ nodes, activeId, defaultFolderOpen = true, onSelect, onRename, onClose, onDelete, onChange, onRenameFolder, onCreateFolder, onDeleteFolder, className }: ChatListProps) {
  const [state, setState] = useState<ListState>(() => initState(nodes, defaultFolderOpen))
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const idCounter = useRef(0)

  const reset = () => {
    setDrag(null)
    setOver(null)
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

  // "Move to new folder": create a folder after the last folder and move the
  // item into it.
  const moveToNewFolder = (itemId: string) => {
    const next: ListState = JSON.parse(JSON.stringify(state))
    let fromList: string[] | null = null
    const io = next.itemOrder.indexOf(itemId)
    if (io >= 0) fromList = next.itemOrder
    else {
      for (const fid of next.folderOrder) {
        const j = next.folders[fid].itemIds.indexOf(itemId)
        if (j >= 0) {
          fromList = next.folders[fid].itemIds
          break
        }
      }
    }
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
    const next: ListState = JSON.parse(JSON.stringify(state))
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

  const renderItem = (id: string, list: string, index: number) => {
    const leaf = state.items[id]
    if (!leaf) return null
    const isDragged = drag?.kind === 'item' && drag.id === id
    const line = over && over.list === list && over.index === index ? over.pos : null
    return (
      <div key={id} className='relative'>
        {line === 'before' ? <div className='absolute -top-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' /> : null}
        <div
          draggable
          onDragStart={(e) => {
            setDrag({ kind: 'item', id, list })
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', id)
          }}
          onDragOver={(e) => {
            if (!drag || drag.kind !== 'item' || drag.list !== list) return
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'move'
            const r = e.currentTarget.getBoundingClientRect()
            setOver({ list, index, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
          }}
          onDrop={performDrop}
          className={cn(isDragged && 'opacity-40')}
        >
          <ChatListItem
            id={leaf.id}
            title={leaf.title}
            description={leaf.description}
            avatarUrl={leaf.avatarUrl}
            statusIndicator={leaf.statusIndicator}
            active={leaf.id === activeId}
            onSelect={onSelect}
            onRename={onRename}
            onClose={onClose}
            onDelete={onDelete}
            actions={itemActions}
          />
        </div>
        {line === 'after' ? <div className='absolute -bottom-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' /> : null}
      </div>
    )
  }

  return (
    <div className={cn('relative flex w-full min-w-0 flex-col gap-0.5', className)} onDragEnd={reset}>
      {state.folderOrder.map((fid, i) => {
        const f = state.folders[fid]
        const isDraggedFolder = drag?.kind === 'folder' && drag.id === fid
        const line = over && over.list === 'folders' && over.index === i ? over.pos : null
        return (
          <div key={fid} className='relative'>
            {line === 'before' ? <div className='absolute -top-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' /> : null}
            <div
              draggable={editing !== fid}
              onDragStart={(e) => {
                setDrag({ kind: 'folder', id: fid })
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', fid)
              }}
              onDragOver={(e) => {
                if (!drag || drag.kind !== 'folder') return
                e.preventDefault()
                e.stopPropagation()
                e.dataTransfer.dropEffect = 'move'
                const r = e.currentTarget.getBoundingClientRect()
                setOver({ list: 'folders', index: i, pos: e.clientY < r.top + r.height / 2 ? 'before' : 'after' })
              }}
              onDrop={performDrop}
              className={cn(
                'flex cursor-grab items-center gap-1 rounded-md px-1 py-1 text-xs font-medium text-muted-foreground hover:bg-muted',
                isDraggedFolder && 'opacity-40',
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
            {line === 'after' ? <div className='absolute -bottom-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' /> : null}
          </div>
        )
      })}

      {state.itemOrder.map((id, i) => renderItem(id, 'items', i))}
    </div>
  )
}
