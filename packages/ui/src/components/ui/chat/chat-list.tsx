'use client'

import { useState, useRef, useEffect, type DragEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Pencil } from 'lucide-react'

import { type ChatContextUsage, ChatListItem, type ChatListItemAction, type ChatStatus } from './chat-list-item'
import { RowContextMenu } from '../utils/row-context-menu'
import { cn } from 'cn'

export interface ChatListLeaf {
  id: string
  title: string
  description?: string
  avatarUrl?: string | null
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
  onClose?: (id: string) => void
  // Forwarded straight to every row -- see ChatListItem for why the two are
  // mutually exclusive per row and why they sit right before Delete.
  onArchive?: (id: string) => void
  onUnarchive?: (id: string) => void
  onDelete?: (id: string) => void
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

// Long-press pickup activation constraint (the dnd-kit pattern):
// a press held still this long arms a drag; moving past the tolerance before it
// fires is not a hold. The delay sits well under a natural long press so a drag
// commits before the user expects a menu.
//
// The tolerance is how far a finger may wander and still count as held still.
// Movement is read from pointer events, which report every pixel, and a finger
// held still drifts a few of them, so this is pinned to what the platforms'
// own long press allows: 10 pt on iOS (UILongPressGestureRecognizer's
// allowable movement), 8 dp on Android (the system touch slop). Tighter, and an
// ordinary wobble aborts the hold or turns it into a drag. It also stays below
// the browser's own touch slop -- the distance before it starts a scroll --
// so a still hold never scrolls.
const PICKUP_DELAY_MS = 500
const PICKUP_TOLERANCE_PX = 10
// A release before this many ms since the press started reads as an ordinary
// slow tap -- 200-350ms between touch-down and release is normal -- so the
// menu needs its own, longer bar rather than sharing the pickup delay. Below
// it we leave the gesture alone and the row's own tap selects the chat.
const MENU_DELAY_MS = 1000
// The menu opens only on a finger at rest: one that has not moved more than
// REST_PX for REST_MS. That is measured from the spot the finger last stopped
// on, not from where the press started, so a finger that wobbled and stopped
// is at rest again REST_MS later wherever it stopped inside the tolerance.
// Where the finger is when the menu is due cannot tell a hold that wobbled
// from a drag that started slowly -- both can still be inside the tolerance
// then, and only the drag is still going. So a moving finger puts the menu
// off until it either comes to rest (a hold: the menu opens) or passes the
// tolerance (a drag); lifting it counts as coming to rest. REST_PX sits above
// the pixel or two of jitter a resting finger reports; a drag slower than
// REST_PX per REST_MS (6 px/s) reads as resting, which leaves a deliberately
// slow drag -- 15 px over a second -- well clear of it. The price is that a
// hold which wobbled gets its menu up to REST_MS after the last wobble.
const REST_PX = 3
const REST_MS = 500

// A single short pulse, fired identically at each stage the gesture reaches --
// armed, then menu-open -- so the two read as one escalation rather than two
// different effects. Feature-detected only: iOS Safari has no Vibration API at
// all and silently gets nothing from this, independent of whatever native
// haptic a platform's own long-press/context-menu handling may already give.
const HAPTIC_PULSE_MS = 15
function vibrate() {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) navigator.vibrate(HAPTIC_PULSE_MS)
}

// An in-flight touch press on a row. Held in a ref (no re-render) until it drags,
// scrolls, or the finger lifts -- also after its own menu timer has opened the
// row menu mid-hold. `pointerMove`/`move`/`end` are the window listeners bound
// for this one press.
interface Press {
  // Rows and folder headers run the SAME gesture -- this is what the press is
  // carrying, so the drag payload, the hit-test and the menu all resolve
  // against the right kind of target.
  kind: 'item' | 'folder'
  id: string
  // The dragged item's own list. Unused for a folder press (folders only ever
  // reorder within the single folder list).
  list: string
  startX: number
  startY: number
  // Where the finger last came to rest, and whether it has stayed within
  // REST_PX of there for REST_MS (see REST_PX). Timed by `restTimer` rather
  // than by reading a clock: timers run on a monotonic one, and the wall clock
  // can jump.
  restX: number
  restY: number
  atRest: boolean
  // The menu timer has fired; the menu opens as soon as the finger is at rest.
  menuDue: boolean
  committed: boolean
  aborted: boolean
  moved: boolean
  // Set the moment the menu timer opens it mid-hold -- release afterward is
  // just the finger lifting off an already-open menu, not a new decision.
  menuOpened: boolean
  pickupTimer: ReturnType<typeof setTimeout> | null
  menuTimer: ReturnType<typeof setTimeout> | null
  restTimer: ReturnType<typeof setTimeout> | null
  pointerMove?: (e: PointerEvent) => void
  move?: (e: TouchEvent) => void
  end?: (e: TouchEvent) => void
}

function clearPressTimers(p: Press) {
  if (p.pickupTimer) { clearTimeout(p.pickupTimer); p.pickupTimer = null }
  if (p.menuTimer) { clearTimeout(p.menuTimer); p.menuTimer = null }
  if (p.restTimer) { clearTimeout(p.restTimer); p.restTimer = null }
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
// settle. Folder `open` is deliberately excluded: it is view state, so a change
// to it is not an upstream change -- a host's `open` is followed on its own,
// see `hostOpenSignature`.
function leafSignature(l: ChatListLeaf) {
  return [
    l.id,
    l.title,
    l.description ?? '',
    l.avatarUrl ?? '',
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
// Touch gesture arbitration (long-press pickup, no grip): the row
// carries NO grip -- one press serves scroll, drag and menu, and movement tells
// them apart (the dnd-kit `activationConstraint { delay, tolerance }` pattern).
// Finger down starts a ~500ms timer; move past ~10px before it fires is not a
// hold (left to the browser); still within tolerance when it fires arms the row (a
// brief lift). From there movement past the threshold drags it in ANY direction
// (vertical included: filing a chat into a folder is a vertical drag). A real
// drag has to take the gesture off the browser, and with no touch-action:none
// element to start from that means a NON-PASSIVE touchmove listener (bound on the
// press) calling preventDefault -- but ONLY once movement passes the drag
// threshold; sub-threshold drift while holding stays uncancelled, or the browser
// has no gesture left (pointer events can't be cancelled, which is why the
// earlier handle-less attempt failed). Movement itself is read from
// `pointermove` as well, because the browser withholds `touchmove` until the
// finger leaves its touch slop, and a drag shorter than that would otherwise be
// invisible and read as a still hold. We own the whole press, so we own the
// menu too: a second, independent timer -- MENU_DELAY_MS (kept separate from
// the 500ms pickup delay -- an ordinary slow tap can easily run 200-350ms) --
// opens the row menu mid-hold -- once it has fired and the finger is at rest,
// see REST_PX -- by dispatching a real contextmenu event at the press's start
// point; it does not wait for release.
// The context-menu trigger stays enabled throughout, because the primitive
// captures the point it anchors the menu to while handling that event, and a
// disabled trigger ignores it. What it does NOT get to keep is its own touch
// long-press, which runs on a fixed 500ms of its own, armed on `touchstart`:
// the element a press starts on takes `touchstart` in the capture phase and
// stops it there, so the trigger inside never arms it. For the length of the
// press the same element also stops any `contextmenu` the list did not send
// itself -- a browser raises one of its own on a touch long-press -- so the
// menu opens on our timer and on nothing else.
// Both timers are cleared if the press aborts as a scroll, and the menu timer
// is also cleared the moment a real drag starts, so it can't pop the menu open
// mid-drag. A press that dragged or opened the menu cancels its own release, so
// the browser does not follow it with a click that would select the chat or
// toggle the folder under the finger, or close the menu it just opened.
// `draggable` is mouse-only -- off as soon as a touch drives the
// row -- so the browser never starts its own drag from a long press; desktop
// keeps native HTML5 DnD + right-click untouched. Two identical short
// vibration pulses mark the same two moments -- armed, then menu-open -- where
// the Vibration API exists.
export function ChatList({ nodes, activeId, defaultFolderOpen = true, allowFolders = true, onSelect, onRename, onStopProcess, onClose, onArchive, onUnarchive, onDelete, onChange, onRenameFolder, onCreateFolder, onDeleteFolder, onFolderOpenChange, className }: ChatListProps) {
  const [state, setState] = useState<ListState>(() => initState(nodes, defaultFolderOpen))
  const [drag, setDrag] = useState<Drag | null>(null)
  const [over, setOver] = useState<Over | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  // Live position of the pointer-dragged row, to render the lifted ghost.
  const [touchDrag, setTouchDrag] = useState<{ kind: 'item' | 'folder'; id: string; x: number; y: number } | null>(null)
  // The row or folder header armed by a still long-press (picked up, not yet
  // dragged): rendered with a lift style; cleared on drag, drop, release or
  // menu-open. Carries its kind because a folder id and a chat id both come
  // from the host and can collide.
  const [lifted, setLifted] = useState<{ kind: 'item' | 'folder'; id: string } | null>(null)
  // Set only for the duration of our own dispatch, so the `contextmenu` the
  // menu timer sends can be told apart from one the browser raised by itself.
  // See `keepForeignMenuOut`.
  const ownMenuDispatchRef = useRef(false)
  // True once the row is being driven by touch or pen. While it is, the row is
  // not `draggable`, so the browser never starts its own drag from a long press.
  const [touchInput, setTouchInput] = useState(false)
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

  // Tear down an in-flight touch press (timers + window listeners) and clear
  // its visual state, for a list that unmounts mid-gesture.
  const cancelPress = () => {
    const p = pressRef.current
    if (!p) return
    clearPressTimers(p)
    if (p.pointerMove) window.removeEventListener('pointermove', p.pointerMove)
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

  // Which input the row is being used with right now, taken from the event
  // rather than from a `(pointer: coarse)` media query -- that query describes
  // the primary input device, so it reads false on a machine driven by a mouse
  // that also has a touchscreen, while touch still works there.
  const noteInputType = (e: ReactPointerEvent<Element>) => {
    setTouchInput(e.pointerType !== 'mouse')
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

  // --- Touch gesture arbitration (long-press pickup, no grip) ---

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

  // What a screen point is hovering during a touch drag -- mirrors the
  // combined effect of the mouse path's per-element `onDragOver` handlers,
  // since touch has no native dragover to hit-test with and has to do it by
  // hand via `elementFromPoint`. What counts as a target depends on WHAT is
  // being dragged: a dragged folder only reorders among folders, and resolves
  // by height alone (`folderSlotAt`), ignoring the horizontal position -- more
  // forgiving than the mouse, which needs a header under the pointer; a dragged
  // item, as with the mouse, files into a folder (its header), moves out to the
  // top level (the zone, on the drags where it renders at all), or inserts
  // before/after any row.
  // Indices come from the DOM (`data-*-index`) so they always reflect the
  // current render rather than a value captured at press-start.
  const overAtPoint = (x: number, y: number, dragKind: 'item' | 'folder'): Over | null => {
    if (dragKind === 'folder') return folderSlotAt(y)
    if (typeof document === 'undefined') return null
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return null
    const folderHeader = el.closest('[data-folder-header]') as HTMLElement | null
    if (folderHeader) return { kind: 'folder', folderId: folderHeader.dataset.folderId! }
    if (el.closest('[data-top-level-zone]')) return { kind: 'top-level' }
    const row = el.closest('[data-row-id]') as HTMLElement | null
    if (row) {
      const r = row.getBoundingClientRect()
      return { kind: 'item-slot', list: row.dataset.rowList!, index: Number(row.dataset.rowIndex), pos: y < r.top + r.height / 2 ? 'before' : 'after' }
    }
    return null
  }

  // Open a row's context menu at a point by dispatching a real contextmenu
  // event there. The trigger has to actually handle an event to capture the
  // point it anchors the menu to, so the menu is opened the way a right-click
  // opens it rather than by any state of ours. The trigger is listening the
  // whole time -- nothing disables it -- so the event opens the menu in the
  // same task it is sent in.
  const openRowMenuAt = (x: number, y: number) => {
    if (typeof document === 'undefined') return
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return
    ownMenuDispatchRef.current = true
    try {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
    } finally {
      ownMenuDispatchRef.current = false
    }
  }

  // Capture-phase `touchstart` on the element a press starts on (a row's
  // wrapper, a folder header). Stopping it here, before it reaches the
  // context-menu trigger inside, keeps the trigger's own fixed-delay touch
  // long-press out of a press this list runs itself. Only `touchstart` is
  // stopped: that is the one the trigger arms on, and the press's own
  // `touchmove`/`touchend` listeners are on the window.
  const startOwnedPress = (kind: 'item' | 'folder', id: string, list: string, e: ReactTouchEvent<HTMLDivElement>) => {
    e.stopPropagation()
    startPress(kind, id, list, e)
  }

  // Capture-phase `contextmenu` on the same elements. While a touch press is
  // in flight the menu is the press's to open, at MENU_DELAY_MS: a browser
  // raises a `contextmenu` of its own on a touch long-press, and letting it
  // through would open the menu at the pickup stage and end the drag before it
  // began. Outside a press -- a right-click -- it passes untouched.
  const keepForeignMenuOut = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!pressRef.current || ownMenuDispatchRef.current) return
    e.preventDefault()
    e.stopPropagation()
  }

  // One press serves scroll, drag and menu; movement tells them apart. On finger
  // down we start a PICKUP_DELAY_MS timer and watch for movement. Move past the
  // tolerance before it fires -> not a hold, and the gesture is left to the
  // browser (nothing was cancelled). Still within tolerance when it fires -> arm
  // the row (lift). After that, movement past the tolerance drags it
  // (preventDefault only then -- drift while holding stays uncancelled, or the
  // browser has no gesture left). A second, independent timer opens the row's
  // menu mid-hold, at MENU_DELAY_MS or later once the finger is at rest,
  // without waiting for release -- release afterward is cancelled so the
  // browser raises no click.
  const startPress = (kind: 'item' | 'folder', id: string, list: string, e: ReactTouchEvent<HTMLDivElement>) => {
    if (pressRef.current) return
    // The gesture owns the tree from here until `end`, including the armed
    // window before any movement. A resync arriving in it is parked, never
    // applied underneath the finger.
    setGestureActive(true)
    const t0 = e.touches[0]
    const p: Press = { kind, id, list, startX: t0.clientX, startY: t0.clientY, restX: t0.clientX, restY: t0.clientY, atRest: true, menuDue: false, committed: false, aborted: false, moved: false, menuOpened: false, pickupTimer: null, menuTimer: null, restTimer: null }
    pressRef.current = p

    // Opens the menu once both have happened: the menu timer has fired, and
    // the finger is at rest. Called from either side, whichever comes second.
    const openMenuIfDue = () => {
      if (pressRef.current !== p || p.aborted || p.moved || p.menuOpened) return
      if (!p.menuDue || !p.atRest) return
      // Held, armed, at rest and never dragged -> open the menu right now,
      // without waiting for release. Dispatch a real contextmenu at the start
      // point -- within the tolerance of the finger, so still on the row -- so
      // the primitive captures a correct anchor.
      p.menuOpened = true
      setLifted(null)
      vibrate()
      openRowMenuAt(p.startX, p.startY)
    }

    // The finger left the spot it rested on: it is moving until it has stayed
    // within REST_PX of a new spot for REST_MS.
    const noteRestlessness = (x: number, y: number) => {
      if (Math.max(Math.abs(x - p.restX), Math.abs(y - p.restY)) <= REST_PX) return
      p.restX = x
      p.restY = y
      p.atRest = false
      if (p.restTimer) clearTimeout(p.restTimer)
      p.restTimer = setTimeout(() => {
        p.restTimer = null
        p.atRest = true
        openMenuIfDue()
      }, REST_MS)
    }

    // The finger moved to (x, y). Fed from two streams, because neither sees the
    // whole gesture on its own: the browser holds `touchmove` back until the
    // finger leaves its touch slop (tens of pixels on a phone), so the start of
    // a drag -- and a short one, such as a folder onto its neighbour -- reaches
    // `pointermove` only; and `pointermove` ends with a `pointercancel` if the
    // browser takes the gesture anyway, which `touchmove` outlives.
    const follow = (x: number, y: number) => {
      if (pressRef.current !== p || p.menuOpened || p.aborted) return
      noteRestlessness(x, y)
      const dx = x - p.startX
      const dy = y - p.startY
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      if (!p.committed) {
        if (dist > PICKUP_TOLERANCE_PX) {
          // Moved past the tolerance before the pickup delay -> not a hold. The
          // press stops acting and cancels nothing, so the browser does what it
          // would have done without us: it scrolls once the finger passes its
          // own touch slop, and treats a release short of that as a tap.
          p.aborted = true
          clearPressTimers(p)
          setLifted(null)
        }
        return
      }
      // Armed. A held finger drifts a few pixels; that sub-tolerance drift
      // must NOT be cancelled -- the browser needs an uncancelled press, and we
      // only take the gesture once this is a real drag. So preventDefault (and
      // the drag itself) start only past the tolerance; drift below it leaves
      // the press live so the menu timer can still open the menu.
      if (!p.moved) {
        if (dist <= PICKUP_TOLERANCE_PX) return
        p.moved = true
        clearPressTimers(p)
        setLifted(null)
        setDrag(dragPayload(p))
      }
      // Real drag: follow the finger. The point is stored relative to the list,
      // since that is what the ghost is placed against; hit-testing below keeps
      // using the raw viewport coordinates.
      const box = rootElRef.current?.getBoundingClientRect()
      setTouchDrag({ kind: p.kind, id: p.id, x: x - (box?.left ?? 0), y: y - (box?.top ?? 0) })
      setOver(overAtPoint(x, y, p.kind))
    }

    // Observes only: a pointer event cannot be cancelled, so it cannot keep
    // the browser from scrolling. The first finger only -- a second one is not
    // this press.
    const pointerMove = (ev: PointerEvent) => {
      if (ev.pointerType === 'mouse' || !ev.isPrimary) return
      follow(ev.clientX, ev.clientY)
    }

    // Takes the gesture off the browser once this is a real drag: cancelling
    // the first `touchmove` past the slop is what stops the browser from
    // panning the list under a dragged row.
    const move = (ev: TouchEvent) => {
      const t = ev.touches[0]
      follow(t.clientX, t.clientY)
      if (pressRef.current === p && p.moved && ev.cancelable) ev.preventDefault()
    }

    const end = (ev: TouchEvent) => {
      if (pressRef.current !== p) return
      clearPressTimers(p)
      // Held past the menu's moment but still moving a little -- inside the
      // tolerance, so not a drag -- when the finger lifts. A finger often rolls a
      // few pixels as it comes off the glass, and a hold that long was asking
      // for the menu, not a tap. Lifting ends the movement, so it counts as
      // coming to rest: the menu opens now, and the release is cancelled below
      // like any other that opened the menu.
      if (p.menuDue) {
        p.atRest = true
        openMenuIfDue()
      }
      const t = ev.changedTouches[0]
      if (p.committed && p.moved) {
        const target = overAtPoint(t.clientX, t.clientY, p.kind)
        if (target) {
          const next = applyDropWithPending(stateRef.current, dragPayload(p), target)
          if (next !== stateRef.current) commit(next)
        }
      }
      // A drag, or a hold that opened the menu, is not a tap -- but a drag
      // shorter than the browser's touch slop looks like one to the browser,
      // which follows the release with mouse events and a click: on the row or
      // folder under the finger, or on the open menu's trigger, closing it.
      // Cancelling the release suppresses all of them. Anything else is a tap
      // or a scroll and keeps its click, which selects the chat or toggles the
      // folder.
      if ((p.moved || p.menuOpened) && ev.cancelable) ev.preventDefault()
      setTouchDrag(null)
      setLifted(null)
      setDrag(null)
      setOver(null)
      setGestureActive(false)
      pressRef.current = null
      window.removeEventListener('pointermove', pointerMove)
      window.removeEventListener('touchmove', move)
      window.removeEventListener('touchend', end)
      window.removeEventListener('touchcancel', end)
    }

    p.pointerMove = pointerMove
    p.move = move
    p.end = end

    p.pickupTimer = setTimeout(() => {
      if (pressRef.current !== p || p.aborted) return
      // Held still within tolerance for the delay -> pick the row up.
      p.committed = true
      setLifted({ kind: p.kind, id: p.id })
      vibrate()
    }, PICKUP_DELAY_MS)

    p.menuTimer = setTimeout(() => {
      p.menuTimer = null
      p.menuDue = true
      openMenuIfDue()
    }, MENU_DELAY_MS)

    window.addEventListener('pointermove', pointerMove)
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
          onTouchStartCapture={(e) => startOwnedPress('item', id, list, e)}
          onContextMenuCapture={keepForeignMenuOut}
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
            context={leaf.context}
            hasDraft={leaf.hasDraft}
            disabled={leaf.disabled}
            active={leaf.id === activeId}
            onSelect={onSelect}
            onRename={onRename}
            onStopProcess={onStopProcess}
            onClose={onClose}
            onArchive={onArchive}
            onUnarchive={onUnarchive}
            onDelete={onDelete}
            actions={itemActions}
            onPointerDown={noteInputType}
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
        // on touch it runs the same long-press gesture a row does, so a folder
        // reorders by hold-and-drag there too. Menu and drag never compete on
        // either pointer: right-click can't start a drag, and on touch the
        // pickup commits first while the menu needs a longer still hold.
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
              draggable={!touchInput && editing !== fid}
              // `user-select: none` matters as much as the callout here: without
              // it a long press on the folder's name selects the text instead of
              // reaching the menu, which is what the row already guards against.
              style={{ touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' }}
              // Same press as a row: hold to lift and reorder among folders,
              // hold longer for the rename/delete menu, tap to toggle open.
              // Suppressed while the inline rename input is up, so a touch there
              // reaches the field.
              onTouchStartCapture={(e) => { if (editing !== fid) startOwnedPress('folder', fid, 'folders', e) }}
              onContextMenuCapture={keepForeignMenuOut}
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
            context={leaf.context}
            hasDraft={leaf.hasDraft}
            disabled={leaf.disabled}
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
