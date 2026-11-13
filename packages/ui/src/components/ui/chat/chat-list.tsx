'use client'

import { useState, useRef, useEffect } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Pencil } from 'lucide-react'

import { type ChatContextUsage, ChatListItem, type ChatListItemAction, type ChatStatus, STATUS_DOT } from './chat-list-item'
import { RowContextMenu } from '../utils/row-context-menu'
import { type RowDragInput, type RowDragPoint, useRowDrag } from '../utils/row-drag'
import { StatusIndicator } from '../utils/status-indicator'
import { cn } from 'cn'

export interface ChatListLeaf {
  id: string
  title: string
  // Where the item lives, drawn before the title as the row's detailed title --
  // see ChatListItem. For a list that mixes items from several places.
  breadcrumb?: string
  description?: string
  avatarUrl?: string | null
  // The name the avatar's fallback initial is taken from; the title when omitted.
  avatarName?: string
  status?: ChatStatus
  context?: ChatContextUsage
  hasDraft?: boolean
  // Dim the row without hiding it -- forwarded straight through to the row,
  // which already draws this state. It has to be on the leaf because the row is
  // rendered from in here: a host that hands over a tree has no other way to
  // reach that prop.
  disabled?: boolean
}

export interface ChatListFolderInput {
  id: string
  name: string
  // Whether the folder is drawn open. Left out, the list decides on its own:
  // the user's toggles stand, and a folder starts at `defaultFolderOpen`. Set
  // by the host, it is followed whenever the host's value changes -- a host
  // that remembers the user's choice hands it back here and keeps it current
  // through `onFolderOpenChange`.
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
  // Whether the user may CREATE, RENAME and DELETE folders.
  //
  // A capability the host states outright, never inferred from which callbacks
  // it passed. The folder callbacks below are NOTIFICATIONS -- this component
  // does the work itself and tells the host afterwards -- and a notification
  // must not decide whether a feature exists. Gating on one is what let a
  // deliberately flat list still offer 'Move to new folder', and what forced a
  // host that wanted folder rename/delete to pass two callbacks it had no use
  // for.
  //
  // Folders already present in `nodes` still render, and items can still be
  // dragged into them, whatever this says: it governs MANAGING folders, not
  // having them.
  allowFolders?: boolean
  onSelect?: (id: string) => void
  onRename?: (id: string) => void
  onStopProcess?: (id: string) => void
  // Forwarded straight to every row -- see ChatListItem for why the two are
  // mutually exclusive per row and why they sit right before Delete.
  onArchive?: (id: string) => void
  onUnarchive?: (id: string) => void
  onDelete?: (id: string) => void
  // Forwarded to every row: a close button at the row's end, for a list of
  // open items such as Recent. Omitted, rows have none. See ChatListItem.
  onClose?: (id: string) => void
  closeLabel?: string
  onChange?: (nodes: ChatListNode[]) => void
  onRenameFolder?: (folderId: string, name: string) => void
  onCreateFolder?: (folderId: string) => void
  onDeleteFolder?: (folderId: string) => void
  // The user opened or closed a folder. Opening is view state, not structure,
  // so it never goes through `onChange`.
  onFolderOpenChange?: (folderId: string, open: boolean) => void
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

// A content fingerprint of the host's tree. The resync below keys on this
// rather than on the `nodes` array's identity, because a host that builds the
// array inline -- the common case -- hands over a new one on every render, and
// reconciling on identity would then set state on every render and never
// settle. Folder `open` is deliberately excluded: it is view state, so a change
// to it is not an upstream change -- a host's `open` is followed on its own,
// see `hostOpenSignature`.
function leafSignature(l: ChatListLeaf) {
  return [
    l.id,
    l.title,
    l.breadcrumb ?? '',
    l.description ?? '',
    l.avatarUrl ?? '',
    l.avatarName ?? '',
    l.status ?? '',
    l.context ? [l.context.usedTokens, l.context.contextLimit, l.context.asOf ?? null] : null,
    l.hasDraft ? 1 : 0,
    l.disabled ? 1 : 0,
  ]
}

function nodesSignature(nodes: ChatListNode[]): string {
  return JSON.stringify(
    nodes.map((n) =>
      n.type === 'item'
        ? ['i', leafSignature(n.item)]
        : ['f', n.folder.id, n.folder.name, n.folder.items.map(leafSignature)],
    ),
  )
}

// The folders whose `open` the host set, and to what.
function hostOpenSignature(nodes: ChatListNode[]): string {
  return JSON.stringify(
    nodes.flatMap((n) => (n.type === 'folder' && n.folder.open !== undefined ? [[n.folder.id, n.folder.open]] : [])),
  )
}

// Rebuild the working tree from a new `nodes` prop, carrying over the one
// thing the host does not have: which folders the user has opened. Everything
// the host owns -- membership, order, titles, status -- comes from `nodes`, so
// a chat added, renamed or removed upstream lands. A folder new to this pass
// falls back to its own `open`, then to `defaultFolderOpen`.
function reconcile(prev: ListState, nodes: ChatListNode[], defaultFolderOpen: boolean): ListState {
  const next = initState(nodes, defaultFolderOpen)
  for (const fid of next.folderOrder) {
    const before = prev.folders[fid]
    if (before) next.folders[fid].open = before.open
  }
  return next
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
// menu the chat rows use (right-click / long-press). All three folder actions
// are gated on `allowFolders` -- a capability the host states -- and never on
// which notification callbacks it passed. A collapsed folder whose items
// include `waiting` ones shows the waiting dot and their count on its header.
// Self-contained; keeps a working copy
// of the tree, resyncs it when the host's `nodes` change (folder open/closed
// state and any in-flight drag survive), and calls onChange on every
// structural change.
//
// The drag itself -- native drag and drop on a mouse, a long press that picks
// a row up on touch, with the row's menu on the same press -- is the kit's row
// drag (`useRowDrag`), the one the graph outline's tree uses too. Rows and
// folder headers run the same gesture; this list says where each drop lands.
export function ChatList({ nodes, activeId, defaultFolderOpen = true, allowFolders = true, onSelect, onRename, onStopProcess, onArchive, onUnarchive, onDelete, onClose, closeLabel, onChange, onRenameFolder, onCreateFolder, onDeleteFolder, onFolderOpenChange, className }: ChatListProps) {
  const [state, setState] = useState<ListState>(() => initState(nodes, defaultFolderOpen))
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // The gesture. Its options are read when an event needs them, so the two
  // functions they call can be declared further down. A dragged row and a
  // dragged folder header carry their kind, because a folder id and a chat id
  // both come from the host and can collide.
  const { drag, over, lifted, ghost, gestureActive, rootRef: rootElRef, rootProps, sourceProps } = useRowDrag<Drag, Over>({
    targetAt: (d, el, point, input) => dropTargetAt(d, el, point, input),
    onDrop: (d, o) => {
      const next = applyDropWithPending(stateRef.current, d, o)
      if (next !== stateRef.current) commit(next)
    },
  })
  // Mirror of `state` for the async touch handlers (they fire off-render).
  const stateRef = useRef(state)
  stateRef.current = state
  // Resync bookkeeping. Three things, and the ORDER between them is the whole
  // contract -- see `applyDropWithPending` and the effect further down.
  //
  // `pendingNodesRef` is the single park for a resync that arrived while a
  // gesture was in flight. Exactly one of two places consumes it: the drop, or
  // the effect once no gesture is live. Never both -- a drop empties it
  // synchronously, before any effect can run.
  const nodesSig = nodesSignature(nodes)
  const lastNodesSigRef = useRef(nodesSig)
  const pendingNodesRef = useRef<ChatListNode[] | null>(null)
  // What we last published through `onChange`. A host that stores it and hands
  // it straight back is echoing our own commit, not reporting an external
  // change -- and treating that echo as external overwrote a parked resync with
  // a copy of our own state, losing the update outright.
  const lastEmittedSigRef = useRef<string | null>(null)

  const commit = (next: ListState) => {
    setState(next)
    const emitted = stateToNodes(next)
    // Remember what we published, so the same tree arriving back as `nodes` is
    // recognised as our own echo rather than parked as an external change.
    lastEmittedSigRef.current = nodesSignature(emitted)
    onChange?.(emitted)
  }

  // The one place a drop becomes a new tree, and the one place a parked resync
  // is applied alongside it.
  //
  // The order is explicit rather than emergent: the host's parked update lands
  // FIRST, the drop is then replayed on top of the reconciled tree, and the
  // result is published once. Running those as two independent state updates is
  // what let the drag and the resync each win separately, and each throw the
  // other's work away.
  //
  // The drop is replayed by id, so a chat removed upstream mid-drag simply does
  // not move -- applyDrop returns the tree unchanged -- rather than
  // resurrecting. The cost is that the insertion slot resolves against the
  // reconciled order, so an upstream insert above the drop point can shift the
  // landing by one. That is a rare race, and better than discarding either
  // change wholesale.
  const applyDropWithPending = (base: ListState, d: Drag, o: Over): ListState => {
    const pending = pendingNodesRef.current
    if (!pending) return applyDrop(base, d, o)
    pendingNodesRef.current = null
    return applyDrop(reconcile(base, pending, defaultFolderOpen), d, o)
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

  const toggleFolder = (fid: string) => {
    const open = !state.folders[fid].open
    setState((s) => ({ ...s, folders: { ...s.folders, [fid]: { ...s.folders[fid], open } } }))
    onFolderOpenChange?.(fid, open)
  }

  // Never reused, not even after the folder holding it is deleted: a host that
  // remembers something per folder id would otherwise hand a deleted folder's
  // memory to the new one.
  const newFolderId = () => `folder-${crypto.randomUUID()}`

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

  // Gated on the declared capability, not on `onCreateFolder` or `onChange`.
  // Creating a folder is something this component does itself; those callbacks
  // only report it afterwards, so their presence says nothing about whether
  // the action should exist at all. See `allowFolders`.
  const itemActions: ChatListItemAction[] = allowFolders
    ? [{ label: 'Move to new folder', icon: <FolderPlus className='size-3' />, onSelect: moveToNewFolder }]
    : []

  // Where a folder dragged by touch lands: the gap between folder headers
  // nearest the finger's height. A folder can only ever land between folders,
  // so the height alone decides it, clamped at both ends -- above the first
  // header is before it, anywhere below the last is after it. Headers are
  // short and stacked tight, and a finger that had to hit the upper half of
  // its neighbour to move above it mostly missed and dropped nothing.
  const folderSlotAt = (y: number): Over | null => {
    const headers = [...(rootElRef.current?.querySelectorAll<HTMLElement>('[data-folder-header]') ?? [])]
    const last = headers.at(-1)
    if (!last) return null
    for (const header of headers) {
      const r = header.getBoundingClientRect()
      if (y < r.top + r.height / 2) return { kind: 'item-slot', list: 'folders', index: Number(header.dataset.folderIndex), pos: 'before' }
    }
    return { kind: 'item-slot', list: 'folders', index: Number(last.dataset.folderIndex), pos: 'after' }
  }

  // Where a drop at a point lands, for a mouse and a finger alike. What counts
  // as a target depends on WHAT is being dragged. A dragged item files into a
  // folder (its header), moves out to the top level (the zone, on the drags
  // where it renders at all), or inserts before/after any row. A dragged folder
  // only reorders among folders: under a mouse, by the half of the header it is
  // over (never its own); under a finger, by height alone (`folderSlotAt`),
  // ignoring the horizontal position -- more forgiving, as a finger has no
  // hover to aim with.
  // Indices come from the DOM (`data-*-index`) so they always reflect the
  // current render rather than a value captured at press-start.
  const dropTargetAt = (d: Drag, el: Element | null, point: RowDragPoint, input: RowDragInput): Over | null => {
    if (d.kind === 'folder') {
      if (input === 'touch') return folderSlotAt(point.y)
      const header = el?.closest<HTMLElement>('[data-folder-header]')
      if (!header || header.dataset.folderId === d.id) return null
      const r = header.getBoundingClientRect()
      return { kind: 'item-slot', list: 'folders', index: Number(header.dataset.folderIndex), pos: point.y < r.top + r.height / 2 ? 'before' : 'after' }
    }
    if (!el) return null
    const folderHeader = el.closest<HTMLElement>('[data-folder-header]')
    if (folderHeader) return { kind: 'folder', folderId: folderHeader.dataset.folderId ?? '' }
    if (el.closest('[data-top-level-zone]')) return { kind: 'top-level' }
    const row = el.closest<HTMLElement>('[data-row-id]')
    if (row) {
      const r = row.getBoundingClientRect()
      return { kind: 'item-slot', list: row.dataset.rowList ?? '', index: Number(row.dataset.rowIndex), pos: point.y < r.top + r.height / 2 ? 'before' : 'after' }
    }
    return null
  }

  // Resync the working tree when the host's `nodes` change.
  //
  // The tree is uncontrolled by design -- drag-and-drop has to own it between
  // commits -- but uncontrolled must not mean deaf: seeded once and never
  // resynced, a chat added, renamed or removed upstream never appeared at all,
  // and both call sites worked around that by keying the element on a
  // serialisation of the data to force a remount, discarding every bit of
  // internal state on each change.
  //
  // A reconcile mid-drag would pull the tree out from under the finger, so a
  // change that arrives during one is held and applied on the drop.
  useEffect(() => {
    if (nodesSig !== lastNodesSigRef.current) {
      lastNodesSigRef.current = nodesSig
      // Our own commit coming back is not an external change. Without this the
      // echo overwrote a parked resync with a copy of our own state, and the
      // update was gone for good -- the drag looked correct and the upstream
      // change simply never appeared.
      if (nodesSig !== lastEmittedSigRef.current) pendingNodesRef.current = nodes
    }
    // HELD: a gesture owns the tree, so the park is left alone until it ends.
    if (gestureActive) return
    // APPLIED, second and only other consumer of the park: a gesture that ended
    // without a drop -- a scroll, a tap, a drop on nothing -- plus the ordinary
    // no-gesture case. A drop empties the park synchronously, so this cannot
    // double-apply it.
    const pending = pendingNodesRef.current
    if (!pending) return
    pendingNodesRef.current = null
    setState((s) => reconcile(s, pending, defaultFolderOpen))
  }, [nodesSig, nodes, gestureActive, defaultFolderOpen])

  // Follow the host's `open` when it changes. Kept apart from the resync above
  // on purpose: opening a folder is view state, so it is neither held for a
  // gesture nor part of what tells the host's tree from our own echo of it.
  const hostOpenSig = hostOpenSignature(nodes)
  useEffect(() => {
    const hostOpen: [string, boolean][] = JSON.parse(hostOpenSig)
    setState((s) => {
      const differing = hostOpen.filter(([fid, open]) => s.folders[fid] && s.folders[fid].open !== open)
      if (differing.length === 0) return s
      const folders = { ...s.folders }
      for (const [fid, open] of differing) folders[fid] = { ...folders[fid], open }
      return { ...s, folders }
    })
  }, [hostOpenSig])

  const renderItem = (id: string, list: string, index: number) => {
    const leaf = state.items[id]
    if (!leaf) return null
    const isDragged = (drag?.kind === 'item' && drag.id === id) || (ghost?.drag.kind === 'item' && ghost.drag.id === id)
    const slotOver = over?.kind === 'item-slot' && over.list === list && over.index === index ? over : null
    return (
      <div key={id} className='relative'>
        {slotOver && slotOver.pos === 'before' ? (
          <div className='absolute -top-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' />
        ) : null}
        <div
          data-row-id={id}
          data-row-list={list}
          data-row-index={index}
          {...sourceProps({ kind: 'item', id, from: list }, { text: id })}
          className={cn(isDragged && 'opacity-40', lifted?.kind === 'item' && lifted.id === id && 'rounded-md bg-muted ring-2 ring-primary')}
        >
          <ChatListItem
            id={leaf.id}
            title={leaf.title}
            breadcrumb={leaf.breadcrumb}
            description={leaf.description}
            avatarUrl={leaf.avatarUrl}
            avatarName={leaf.avatarName}
            status={leaf.status}
            context={leaf.context}
            hasDraft={leaf.hasDraft}
            disabled={leaf.disabled}
            active={leaf.id === activeId}
            onSelect={onSelect}
            onRename={onRename}
            onStopProcess={onStopProcess}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            onDelete={onDelete}
            onClose={onClose}
            closeLabel={closeLabel}
            actions={itemActions}
          />
        </div>
        {slotOver && slotOver.pos === 'after' ? (
          <div className='absolute -bottom-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' />
        ) : null}
      </div>
    )
  }

  return (
    <div ref={rootElRef} className={cn('relative flex w-full min-w-0 flex-col gap-0.5', className)} {...rootProps}>
      {state.folderOrder.map((fid, i) => {
        const f = state.folders[fid]
        const isDraggedFolder = (drag?.kind === 'folder' && drag.id === fid) || (ghost?.drag.kind === 'folder' && ghost.drag.id === fid)
        const folderSlotOver = over?.kind === 'item-slot' && over.list === 'folders' && over.index === i ? over : null
        const intoThis = over?.kind === 'folder' && over.folderId === fid
        // The folder header label is the context-menu trigger (right-click on
        // desktop, long-press on touch -- the same mechanism the chat rows use)
        // when the host passed any folder action. No always-visible buttons on
        // the header; each entry shows only for the callback it needs. Rename
        // keeps its inline editing; delete returns the chats to the loose list.
        // The draggable header div around it stays the native HTML5 DnD source
        // and drop target for folder reorder / file-item-into-folder on mouse;
        // on touch it runs the same long-press gesture a row does, so a folder
        // reorders by hold-and-drag there too. Menu and drag never compete on
        // either pointer: right-click can't start a drag, and on touch the
        // pickup commits first while the menu needs a longer still hold.
        // A closed folder hides its rows, and with them each row's "Needs you"
        // dot, so the header carries that dot for them, with how many threads
        // inside are waiting. An open folder shows the rows themselves and
        // draws nothing extra. Read from the items' own `status`, so it clears
        // the moment the last of them stops waiting.
        const waitingCount = f.open ? 0 : f.itemIds.filter((iid) => state.items[iid]?.status === 'waiting').length
        const waitingLabel = `${waitingCount} waiting`
        const toggle = (
          <button
            type='button'
            onClick={() => toggleFolder(fid)}
            className='inline-flex min-w-0 flex-1 items-center gap-1 rounded-md px-1 py-1 outline-none'
          >
            {f.open ? <ChevronDown className='size-3.5 shrink-0' /> : <ChevronRight className='size-3.5 shrink-0' />}
            {f.open ? <FolderOpen className='size-3.5 shrink-0' /> : <Folder className='size-3.5 shrink-0' />}
            <span className='truncate'>{f.name}</span>
            {waitingCount > 0 ? (
              <span data-folder-waiting={waitingCount} title={waitingLabel} className='ml-auto inline-flex shrink-0 items-center gap-1.5 pl-1 text-primary tabular-nums'>
                <StatusIndicator variant={STATUS_DOT.waiting} aria-hidden />
                {waitingCount}
                <span className='sr-only'> waiting</span>
              </span>
            ) : null}
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
        ) : allowFolders ? (
          // The folder header's menu is the same component a chat row uses, so a
          // folder and a chat are deleted through the same control rather than
          // two that happen to match.
          <RowContextMenu
            entries={[
              { label: 'Rename', icon: <Pencil className='size-3' />, onSelect: () => startRename(fid, f.name) },
            ]}
            onDelete={() => deleteFolder(fid)}
          >
            {toggle}
          </RowContextMenu>
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
              data-folder-index={i}
              // Same press as a row: hold to lift and reorder among folders,
              // hold longer for the rename/delete menu, tap to toggle open.
              // Suppressed while the inline rename input is up, so a touch there
              // reaches the field.
              {...sourceProps({ kind: 'folder', id: fid }, { enabled: editing !== fid, text: fid })}
              // `user-select: none` matters as much as the callout here: without
              // it a long press on the folder's name selects the text instead of
              // reaching the menu, which is what the row already guards against.
              style={{ touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' }}
              className={cn(
                'flex cursor-grab items-center gap-1 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted',
                isDraggedFolder && 'opacity-40',
                lifted?.kind === 'folder' && lifted.id === fid && 'bg-muted ring-2 ring-primary',
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

      {/* An escape hatch, and only while there is no other way out of a folder.
          A dragged chat reaches the top level two ways: here, or dropped
          before/after a loose top-level chat. So the moment one loose chat
          exists, this target is a second route to what the list already does,
          and it goes.

          With none it is the only route, which is why the test is on loose
          chats rather than on the list being empty. Folders are pinned above
          chats BY DESIGN: a folder header takes a chat into its folder, and
          the gap between two folders is not a drop position at all. So a top
          level of folders alone offers a chat nowhere to land, and without
          this target every chat would be stuck in the folder it is in. The
          pinning is deliberate -- not an asymmetry to tidy up in passing.

          The source list needs no test of its own -- a chat dragged FROM the
          top level is itself a loose chat, so the condition is already false. */}
      {drag?.kind === 'item' && state.itemOrder.length === 0 ? (
        <div
          data-top-level-zone
          className={cn(
            'mt-1 flex items-center justify-center rounded-md border border-dashed py-1.5 text-[10px]',
            over?.kind === 'top-level' ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground',
          )}
        >
          Move to top level
        </div>
      ) : null}

      {/* Lifted ghost following the finger during a touch drag.

          Deliberately translucent. The mouse path never needs this: the
          browser builds its own drag image from the dragged element and
          applies its own transparency, and none of that is ours to control.
          Touch has no drag image at all, so this is a real element we render
          -- fully opaque unless told otherwise -- and an opaque plate riding
          under the finger hides the very insert-line it is being aimed at,
          which is the whole feedback the drag depends on.

          Placed against the list's own box, not the viewport. `fixed` would be
          the obvious choice and is the wrong one: a transform, filter or
          containment anywhere above this component makes that ancestor the
          containing block instead of the viewport, and the ghost then lands
          offset by however far down the page that ancestor sits. A host is free
          to do any of those, so the ghost cannot depend on none of them being
          there. */}
      {ghost ? (() => {
        const folder = ghost.drag.kind === 'folder' ? state.folders[ghost.drag.id] : undefined
        const leaf = ghost.drag.kind === 'item' ? state.items[ghost.drag.id] : undefined
        const content = folder ? (
          <span className='flex items-center gap-1 px-1 py-1 text-xs font-medium text-muted-foreground'>
            {folder.open ? <FolderOpen className='size-3.5 shrink-0' /> : <Folder className='size-3.5 shrink-0' />}
            <span className='truncate'>{folder.name}</span>
          </span>
        ) : leaf ? (
          <ChatListItem
            id={leaf.id}
            title={leaf.title}
            breadcrumb={leaf.breadcrumb}
            description={leaf.description}
            avatarUrl={leaf.avatarUrl}
            avatarName={leaf.avatarName}
            status={leaf.status}
            context={leaf.context}
            hasDraft={leaf.hasDraft}
            disabled={leaf.disabled}
          />
        ) : null
        if (!content) return null
        return (
          <div
            className='pointer-events-none absolute z-50 opacity-60'
            style={{ left: ghost.x, top: ghost.y, transform: 'translateY(-50%)' }}
          >
            <div className='w-64 rounded-md bg-background p-1 shadow-lg ring-1 ring-border'>{content}</div>
          </div>
        )
      })() : null}
    </div>
  )
}
