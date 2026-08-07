'use client'

import { useState, useRef, useEffect, type DragEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, GripVertical, Pencil, Trash2 } from 'lucide-react'

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

// How far the finger must travel on the grip before the row is actually
// picked up. Not a delay: the grip owns its gesture from touch-down (it is
// `touch-action: none`), so there is nothing to arbitrate against and nothing
// to wait for. The threshold only separates a deliberate drag from the jitter
// of a finger landing on a small target.
const DRAG_THRESHOLD_PX = 4

// The grip is touch-only, and this is why it is a real media rule rather than
// Tailwind's `pointer-coarse:` variant: these sources are stored and rendered
// at runtime, so nothing scans them to generate that variant's class. Emitted
// ONCE per list rather than per row -- 200 rows would otherwise mean 200
// identical <style> elements.
//
// `(pointer: coarse)` describes the PRIMARY input. That is the right question
// here and the wrong one elsewhere in this file: showing a grip is a layout
// decision made once at render, so it follows the device's main input; deciding
// whether THIS press is a touch is a per-event question, and that one is
// answered from `pointerType` (see `noteInputType`).
const GRIP_STYLE = '@media (pointer: coarse) { .chat-row-grip { display: inline-flex } }'

// A single short pulse, fired identically at each stage the gesture reaches --
// armed, then menu-open -- so the two read as one escalation rather than two
// different effects. Feature-detected only: iOS Safari has no Vibration API at
// all and silently gets nothing from this, independent of whatever native
// haptic a platform's own long-press/context-menu handling may already give.
const HAPTIC_PULSE_MS = 15
function vibrate() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(HAPTIC_PULSE_MS)
}

// An in-flight touch drag started from a row's (or folder header's) grip. Held
// in a ref so following the finger does not re-render on every move.
// `move`/`end` are the non-passive window listeners bound for this one drag.
interface Press {
  // Rows and folder headers use the SAME grip gesture -- this is what is being
  // dragged, so the payload and the hit-test resolve against the right kind of
  // target.
  kind: 'item' | 'folder'
  id: string
  // The dragged item's own list. Unused for a folder (folders only ever reorder
  // within the single folder list).
  list: string
  startX: number
  startY: number
  // Past DRAG_THRESHOLD_PX: this is a real drag, not the finger settling.
  moved: boolean
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

// A content fingerprint of the host's tree. The resync below keys on this
// rather than on the `nodes` array's identity, because a host that builds the
// array inline -- the common case -- hands over a new one on every render, and
// reconciling on identity would then set state on every render and never
// settle. Folder `open` is deliberately excluded: it is view state this
// component owns, so a change to it is not an upstream change.
function leafSignature(l: ChatListLeaf) {
  return [l.id, l.title, l.description ?? '', l.avatarUrl ?? '', l.status ?? '', l.hasDraft ? 1 : 0]
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

// The drag payload a touch press stands for. A folder press carries no source
// list -- folders only ever reorder within the folder list.
function dragPayload(p: Press): Drag {
  return p.kind === 'folder' ? { kind: 'folder', id: p.id } : { kind: 'item', id: p.id, from: p.list }
}

// A container for chat-list-items. **Folders always sit above loose items.**
// Items drag freely: between folders, into a folder (drop on its header), out to
// the top level (drop on the 'Move to top level' zone), or before/after another
// item. Folders reorder among themselves. File an item into a brand-new folder
// via **Move to new folder** in its row menu. Folder headers carry no
// always-visible buttons: rename + delete are reached through the same context
// menu the chat rows use (right-click / long-press). All three folder actions
// are gated on `allowFolders` -- a capability the host states -- and never on
// which notification callbacks it passed. Self-contained; keeps a working copy
// of the tree, resyncs it when the host's `nodes` change (folder open/closed
// state and any in-flight drag survive), and calls onChange on every
// structural change.
//
// **Touch gesture ownership: the grip drags, the row body does everything
// else.** Each gesture belongs to an element, decided before the finger lands,
// rather than being told apart afterwards:
//
//   grip + move          -> drag the row (any direction, vertical included --
//                           filing a chat into a folder IS a vertical drag)
//   row body, swipe      -> scroll the list (the browser's, untouched)
//   row body, long press -> the actions menu (the primitive's own, untouched)
//   row body, tap        -> select the chat / toggle the folder
//
// This is why the grip exists rather than a timing rule. A vertical drag cannot
// start from a surface that has promised vertical scrolling to the browser, so
// the grip is `touch-action: none` and owns its touch from the first event --
// no delay, no tolerance window, nothing to arbitrate. The row body keeps
// `touch-action: pan-y` and never starts a drag, so nothing competes for its
// press and the menu needs no interception: it opens on the primitive's own
// long press, at the primitive's own timing.
//
// The one trap, and it is what removed the previous grip: the row's
// context-menu trigger sits ABOVE the grip in the tree, so a press held still
// on the grip would reach it and open the menu -- a drag handle that opens a
// menu when you pause on it. The grip cancels `pointerdown`, which stops the
// trigger arming its long press without disabling the trigger anywhere else.
//
// The grip is touch-only, shown by a real `@media (pointer: coarse)` rule
// emitted once per list (see GRIP_STYLE). Desktop is untouched: native HTML5
// DnD from the row body, right-click for the menu, no grip rendered. A single
// short vibration marks the pickup where the Vibration API exists.
export function ChatList({ nodes, activeId, defaultFolderOpen = true, allowFolders = true, onSelect, onRename, onStopProcess, onClose, onDelete, onChange, onRenameFolder, onCreateFolder, onDeleteFolder, className }: ChatListProps) {
  const [state, setState] = useState<ListState>(() => initState(nodes, defaultFolderOpen))
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Live position of the pointer-dragged row, to render the lifted ghost.
  const [touchDrag, setTouchDrag] = useState<{ kind: 'item' | 'folder'; id: string; x: number; y: number } | null>(null)
  // The row or folder header currently held by the grip: rendered with a lift
  // style from touch-down, cleared on drop or release. Carries its kind because
  // a folder id and a chat id both come from the host and can collide.
  const [lifted, setLifted] = useState<{ kind: 'item' | 'folder'; id: string } | null>(null)

  // True once the row is being driven by touch or pen. Its only job now is to
  // keep `draggable` off for touch, so the browser never starts a native drag
  // from a long press on the row body -- that would fight the menu, which on
  // touch is the body's own gesture.
  const [touchInput, setTouchInput] = useState(false)

  const idCounter = useRef(0)
  // The list's own box, used to place the drag ghost. See the ghost's comment:
  // it is positioned against this element rather than the viewport. Named for
  // the element rather than the list, so it cannot shadow `listRef` above --
  // which it did, silently breaking every call to that helper from in here.
  const rootElRef = useRef<HTMLDivElement | null>(null)
  const pressRef = useRef<Press | null>(null)
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
  // A gesture that could mutate the tree is in flight. Set synchronously when a
  // press or a mouse drag starts, cleared when it ends.
  //
  // Deliberately NOT derived from `drag`/`touchDrag`: a touch press that has
  // been picked up but not yet moved past the threshold has neither of those
  // set, and that window is exactly where a resync used to land, rebuild the
  // tree under a finger still holding a row, and leave the drop with an id it
  // could no longer find.
  const [gestureActive, setGestureActive] = useState(false)

  const reset = () => {
    setDrag(null)
    setOver(null)
    setGestureActive(false)
  }

  // Tear down an in-flight grip drag (its non-passive window listeners) and
  // clear its visual state. Used on unmount, so a list torn down mid-drag
  // leaves no listeners behind.
  const cancelPress = () => {
    const p = pressRef.current
    if (!p) return
    if (p.move) window.removeEventListener('touchmove', p.move)
    if (p.end) {
      window.removeEventListener('touchend', p.end)
      window.removeEventListener('touchcancel', p.end)
    }
    pressRef.current = null
    setLifted(null)
    setGestureActive(false)
  }

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

  const performDrop = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!drag || !over) {
      reset()
      return
    }
    const next = applyDropWithPending(state, drag, over)
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

  // Stops the context-menu trigger arming its own touch long-press, so the menu
  // stays on our schedule instead of the primitive's fixed one.
  //
  // This has to be handed to the element the trigger is attached to -- the row
  // itself, and the folder header's toggle -- not to an ancestor. The trigger
  // composes its own handler behind a `defaultPrevented` check and runs the
  // element's handler first, so cancelling here lands before that check on the
  // same event; anything further up is a separate listener and does not.
  //
  // Which input the row is being used with right now, taken from the event
  // rather than from a `(pointer: coarse)` media query -- that query describes
  // the primary input device, so it reads false on a machine driven by a mouse
  // that also has a touchscreen, while touch still works there and the menu
  // trigger still arms its long-press. The trigger tests exactly this instead,
  // so we do too.
  const noteInputType = (e: ReactPointerEvent<Element>) => {
    setTouchInput(e.pointerType !== 'mouse')
  }

  const toggleFolder = (fid: string) => {
    setState((s) => ({ ...s, folders: { ...s.folders, [fid]: { ...s.folders[fid], open: !s.folders[fid].open } } }))
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

  // Gated on the declared capability, not on `onCreateFolder` or `onChange`.
  // Creating a folder is something this component does itself; those callbacks
  // only report it afterwards, so their presence says nothing about whether
  // the action should exist at all. See `allowFolders`.
  const itemActions: ChatListItemAction[] = allowFolders
    ? [{ label: 'Move to new folder', icon: <FolderPlus className='size-3' />, onSelect: moveToNewFolder }]
    : []

  // --- Touch drag (from the grip; see the component comment) ---

  // What a screen point is hovering during a touch drag -- mirrors the
  // combined effect of the mouse path's per-element `onDragOver` handlers,
  // since touch has no native dragover to hit-test with and has to do it by
  // hand via `elementFromPoint`. What counts as a target depends on WHAT is
  // being dragged, exactly as it does for the mouse: a dragged folder only
  // reorders among folders, so only a folder header matches; a dragged item
  // files into a folder (its header), moves out to the top level (the zone
  // that only exists mid-drag-from-a-folder), or inserts before/after any
  // row. Indices come from the DOM (`data-*-index`) so they always reflect
  // the current render rather than a value captured at press-start.
  const overAtPoint = (x: number, y: number, dragKind: 'item' | 'folder'): Over | null => {
    if (typeof document === 'undefined') return null
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return null
    const folderHeader = el.closest('[data-folder-header]') as HTMLElement | null
    if (dragKind === 'folder') {
      if (!folderHeader) return null
      const r = folderHeader.getBoundingClientRect()
      return { kind: 'item-slot', list: 'folders', index: Number(folderHeader.dataset.folderIndex), pos: y < r.top + r.height / 2 ? 'before' : 'after' }
    }
    if (folderHeader) return { kind: 'folder', folderId: folderHeader.dataset.folderId! }
    if (el.closest('[data-top-level-zone]')) return { kind: 'top-level' }
    const row = el.closest('[data-row-id]') as HTMLElement | null
    if (row) {
      const r = row.getBoundingClientRect()
      return { kind: 'item-slot', list: row.dataset.rowList!, index: Number(row.dataset.rowIndex), pos: y < r.top + r.height / 2 ? 'before' : 'after' }
    }
    return null
  }

  // The menu opened or closed. The primitive owns that state -- its root takes
  // no controlled `open` -- so this is a notification, and with the grip owning
  // the drag there is nothing to arbitrate: the menu's long press lives on the
  // row body, the drag lives on the grip, and the two never touch the same
  // element. Kept because the row still reports it and a host may care.
  const handleMenuOpen = (_open: boolean) => {}

  // A drag started from the grip. The grip is `touch-action: none`, so the
  // browser hands the gesture over at touch-down and there is no timer, no
  // tolerance window and nothing to arbitrate against -- the row body keeps its
  // own scroll, long-press menu and tap, because this gesture never begins
  // there. Movement past DRAG_THRESHOLD_PX turns the press into a real drag.
  const startGripDrag = (kind: 'item' | 'folder', id: string, list: string, e: ReactTouchEvent<Element>) => {
    if (pressRef.current) return
    // The gesture owns the tree from here until `end`, including the settling
    // window before the threshold is crossed. A resync arriving in it is
    // parked, never applied underneath the finger.
    setGestureActive(true)
    const t0 = e.touches[0]
    const p: Press = { kind, id, list, startX: t0.clientX, startY: t0.clientY, moved: false }
    pressRef.current = p
    // Lifted from touch-down: the finger is on the grip, so there is nothing
    // else this press could become and no reason to make the user wait to see
    // that the row is theirs.
    setLifted({ kind, id })
    vibrate()

    const move = (ev: TouchEvent) => {
      if (pressRef.current !== p) return
      const t = ev.touches[0]
      const dist = Math.max(Math.abs(t.clientX - p.startX), Math.abs(t.clientY - p.startY))
      if (!p.moved) {
        if (dist <= DRAG_THRESHOLD_PX) return
        p.moved = true
        setDrag(dragPayload(p))
      }
      // The grip is `touch-action: none`, so the browser has already given us
      // this gesture -- preventDefault here is belt-and-braces against a UA
      // that honours the property late, and costs nothing since nothing else
      // wants this touch.
      ev.preventDefault()
      const box = rootElRef.current?.getBoundingClientRect()
      setTouchDrag({ kind: p.kind, id: p.id, x: t.clientX - (box?.left ?? 0), y: t.clientY - (box?.top ?? 0) })
      setOver(overAtPoint(t.clientX, t.clientY, p.kind))
    }

    const end = (ev: TouchEvent) => {
      if (pressRef.current !== p) return
      const t = ev.changedTouches[0]
      if (p.moved) {
        const target = overAtPoint(t.clientX, t.clientY, p.kind)
        if (target) {
          const next = applyDropWithPending(stateRef.current, dragPayload(p), target)
          if (next !== stateRef.current) commit(next)
        }
      }
      // A press on the grip that never moved is nothing at all -- not a tap on
      // the row (the grip is not the row) and not a menu. It just ends.
      setTouchDrag(null)
      setLifted(null)
      setDrag(null)
      setOver(null)
      setGestureActive(false)
      pressRef.current = null
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
    }

    p.move = move
    p.end = end

    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', end)
    window.addEventListener('touchcancel', end)
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

  // Drop any in-flight press if the list unmounts mid-gesture (no listener leak).
  useEffect(() => () => { cancelPress() }, [])

  const renderItem = (id: string, list: string, index: number) => {
    const leaf = state.items[id]
    if (!leaf) return null
    const isDragged = (drag?.kind === 'item' && drag.id === id) || (touchDrag?.kind === 'item' && touchDrag.id === id)
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
          draggable={!touchInput}
          onDragStart={(e) => {
            setGestureActive(true)
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
          className={cn(isDragged && 'opacity-40', lifted?.kind === 'item' && lifted.id === id && 'rounded-md bg-muted ring-2 ring-primary')}
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
            onPointerDown={noteInputType}
            onMenuOpenChange={handleMenuOpen}
            onGripTouchStart={(e) => startGripDrag('item', id, list, e)}
          />
        </div>
        {slotOver && slotOver.pos === 'after' ? (
          <div className='absolute -bottom-0.5 left-1 right-1 z-10 h-0.5 rounded-full bg-primary' />
        ) : null}
      </div>
    )
  }

  return (
    <div ref={rootElRef} className={cn('relative flex w-full min-w-0 flex-col gap-0.5', className)} onDragEnd={reset}>
      {/* One rule for the whole list, not one per row. */}
      <style>{GRIP_STYLE}</style>
      {state.folderOrder.map((fid, i) => {
        const f = state.folders[fid]
        const isDraggedFolder = (drag?.kind === 'folder' && drag.id === fid) || (touchDrag?.kind === 'folder' && touchDrag.id === fid)
        const folderSlotOver = over?.kind === 'item-slot' && over.list === 'folders' && over.index === i ? over : null
        const intoThis = over?.kind === 'folder' && over.folderId === fid
        // The folder header label is the context-menu trigger (right-click on
        // desktop, long-press on touch -- the same mechanism the chat rows use)
        // when the host passed any folder action. No always-visible buttons on
        // the header; each entry shows only for the callback it needs. Rename
        // keeps its inline editing; delete returns the chats to the loose list.
        // The draggable header div around it stays the native HTML5 DnD source
        // and drop target for folder reorder / file-item-into-folder on mouse;
        // on touch the header carries its own grip, so a folder reorders by
        // dragging that. Menu and drag never compete on either pointer:
        // right-click cannot start a drag, and on touch they are different
        // elements -- the header's label opens the menu, its grip drags.
        const toggle = (
          <button
            type='button'
            onPointerDown={noteInputType}
            onClick={() => toggleFolder(fid)}
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
        ) : allowFolders ? (
          <ContextMenu onOpenChange={handleMenuOpen}>
            <ContextMenuTrigger asChild>{toggle}</ContextMenuTrigger>
            <ContextMenuContent className='min-w-[8rem]' onClick={(e) => e.stopPropagation()}>
              <ContextMenuItem onClick={() => startRename(fid, f.name)}>
                <Pencil className='size-3' />
                Rename
              </ContextMenuItem>
              <ContextMenuItem className='text-destructive focus:text-destructive' onClick={() => deleteFolder(fid)}>
                <Trash2 className='size-3' />
                Delete
              </ContextMenuItem>
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
              data-folder-index={i}
              draggable={!touchInput && editing !== fid}
              // `user-select: none` matters as much as the callout here: without
              // it a long press on the folder's name selects the text instead of
              // reaching the menu, which is what the row already guards against.
              style={{ touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' }}
              onDragStart={(e) => {
                setGestureActive(true)
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
                lifted?.kind === 'folder' && lifted.id === fid && 'bg-muted ring-2 ring-primary',
                intoThis && 'ring-2 ring-primary bg-primary/10',
              )}
            >
              {headerLabel}
              {/* The folder's own grip -- same gesture, same touch-only rule.
                  Suppressed while the inline rename input is up, so a touch
                  there reaches the field rather than starting a drag. */}
              {editing !== fid ? (
                <span
                  data-drag-handle
                  className='chat-row-grip mr-1 hidden shrink-0 items-center justify-center p-2 -m-1 text-muted-foreground'
                  style={{ touchAction: 'none', WebkitTouchCallout: 'none', userSelect: 'none' }}
                  onTouchStart={(e) => startGripDrag('folder', fid, 'folders', e)}
                  onPointerDown={(e) => e.preventDefault()}
                  aria-hidden='true'
                >
                  <GripVertical className='size-4' />
                </span>
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
          data-top-level-zone
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
      {touchDrag ? (() => {
        const folder = touchDrag.kind === 'folder' ? state.folders[touchDrag.id] : undefined
        const leaf = touchDrag.kind === 'item' ? state.items[touchDrag.id] : undefined
        const content = folder ? (
          <span className='flex items-center gap-1 px-1 py-1 text-xs font-medium text-muted-foreground'>
            {folder.open ? <FolderOpen className='size-3.5 shrink-0' /> : <Folder className='size-3.5 shrink-0' />}
            <span className='truncate'>{folder.name}</span>
          </span>
        ) : leaf ? (
          <ChatListItem
            id={leaf.id}
            title={leaf.title}
            description={leaf.description}
            avatarUrl={leaf.avatarUrl}
            status={leaf.status}
            hasDraft={leaf.hasDraft}
          />
        ) : null
        if (!content) return null
        return (
          <div
            className='pointer-events-none absolute z-50 opacity-60'
            style={{ left: touchDrag.x, top: touchDrag.y, transform: 'translateY(-50%)' }}
          >
            <div className='w-64 rounded-md bg-background p-1 shadow-lg ring-1 ring-border'>{content}</div>
          </div>
        )
      })() : null}
    </div>
  )
}
