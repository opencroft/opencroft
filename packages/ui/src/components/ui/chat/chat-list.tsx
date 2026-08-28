'use client'

import { useState, useRef, useEffect, type DragEvent, type PointerEvent as ReactPointerEvent, type TouchEvent as ReactTouchEvent } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Pencil } from 'lucide-react'

import { ChatListItem, type ChatListItemAction, type ChatStatus } from 'ui/components/ui/chat/chat-list-item'
import { RowContextMenu } from 'ui/components/ui/utils/row-context-menu'
import { cn } from 'ui/lib/utils'

export interface ChatListLeaf {
  id: string
  title: string
  description?: string
  avatarUrl?: string | null
  status?: ChatStatus
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

// Long-press pickup activation constraint (the dnd-kit pattern):
// a press held still this long arms a drag; moving past the tolerance before it
// fires is a scroll. The tolerance sits below the browser's touch-slop so a
// still hold never accidentally scrolls, and the delay sits well under a natural
// long press so a drag commits before the user expects a menu.
const PICKUP_DELAY_MS = 500
const PICKUP_TOLERANCE_PX = 5
// A release before this many ms since the press started reads as an ordinary
// slow tap -- 200-350ms between touch-down and release is normal -- so the
// menu needs its own, longer bar rather than sharing the pickup delay. Below
// it we leave the gesture alone and the row's own tap selects the chat.
const MENU_DELAY_MS = 1000

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
// scrolls, its own menu timer opens the row menu mid-hold, or it's dropped when
// a menu opens some other way (see `handleMenuOpen`). `move`/`end` are the
// non-passive window listeners bound for this one press.
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
  startTime: number
  committed: boolean
  aborted: boolean
  moved: boolean
  // Set the moment the menu timer opens it mid-hold -- release afterward is
  // just the finger lifting off an already-open menu, not a new decision.
  menuOpened: boolean
  pickupTimer: ReturnType<typeof setTimeout> | null
  menuTimer: ReturnType<typeof setTimeout> | null
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
  return [l.id, l.title, l.description ?? '', l.avatarUrl ?? '', l.status ?? '', l.hasDraft ? 1 : 0, l.disabled ? 1 : 0]
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
// Touch gesture arbitration (long-press pickup, no grip): the row
// carries NO grip -- one press serves scroll, drag and menu, and movement tells
// them apart (the dnd-kit `activationConstraint { delay, tolerance }` pattern).
// Finger down starts a ~500ms timer; move past ~5px before it fires is a scroll
// (handed to the browser); still within tolerance when it fires arms the row (a
// brief lift). From there movement past the threshold drags it in ANY direction
// (vertical included: filing a chat into a folder is a vertical drag). A real
// drag has to take the gesture off the browser, and with no touch-action:none
// element to start from that means a NON-PASSIVE touchmove listener (bound on the
// press) calling preventDefault -- but ONLY once movement passes the drag
// threshold; sub-threshold drift while holding stays uncancelled, or the browser
// has no gesture left (pointer events can't be cancelled, which is why the
// earlier handle-less attempt failed). We own the whole press, so we own the
// menu too: a second, independent timer -- MENU_DELAY_MS (kept separate from
// the 500ms pickup delay -- an ordinary slow tap can easily run 200-350ms) --
// opens the row menu mid-hold, the moment it fires, by dispatching a real
// contextmenu event at the press's start point; it does not wait for release.
// The context-menu trigger stays enabled on every pointer type, because the
// primitive captures the point it anchors the menu to while handling that
// event -- disabling it (tried once) took the anchor away with the timing and
// the menu opened at the viewport origin. What it does NOT get to keep is its
// own touch long-press, which runs on a fixed ~700ms of its own, ahead of
// ours: while the row is being driven by touch its trigger is `disabled`,
// which both stops that long-press and clears any timer already armed, in an
// effect the primitive keys on that prop. At our delay the trigger is enabled
// again and the `contextmenu` is dispatched from an effect, once that render
// has been committed and it is listening. (Left alone it is unreliable rather than harmful -- the
// primitive clears it on ANY pointermove, with no tolerance, so a finger's
// jitter usually destroys it. Usually is not a guarantee.) Cancelling
// `pointerdown` also suppresses the click the browser would synthesise from a
// tap, so the press owns selection: a release that never dragged and never
// reached the menu timer selects the chat, or toggles the folder, from `end`.
// Both timers are cleared if the press aborts as a scroll, and the menu timer
// is also cleared the moment a real drag starts, so it can't pop the menu open
// mid-drag. `handleMenuOpen` is a notification -- the primitive owns the open
// state, there is no controlled `open` -- and drops an in-flight press when a
// menu appears. `draggable` is mouse-only -- off as soon as a touch drives the
// row -- so the browser never starts its own drag from a long press; desktop
// keeps native HTML5 DnD + right-click untouched. Two identical short
// vibration pulses mark the same two moments -- armed, then menu-open -- where
// the Vibration API exists.
export function ChatList({ nodes, activeId, defaultFolderOpen = true, allowFolders = true, onSelect, onRename, onStopProcess, onClose, onDelete, onChange, onRenameFolder, onCreateFolder, onDeleteFolder, className }: ChatListProps) {
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
  // Set only for the duration of our own dispatch, so a menu opening can be
  // told apart from one the primitive raised by itself. See `handleMenuOpen`.
  const ownMenuDispatchRef = useRef(false)
  // True once the row is being driven by touch or pen. While it is, the menu
  // trigger is disabled, which both stops its own long-press and clears any
  // timer it had already armed.
  const [touchInput, setTouchInput] = useState(false)
  // The row whose menu should open, and where. Setting it re-enables that row's
  // trigger; the effect below dispatches the `contextmenu` once that render has
  // landed, so the trigger is listening by the time the event arrives.
  const [menuArmed, setMenuArmed] = useState<{ id: string; x: number; y: number } | null>(null)
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

  // Tear down an in-flight touch press (timer + non-passive window listeners)
  // and clear its visual state. Used when the row menu opens mid-press and on
  // unmount.
  const cancelPress = () => {
    const p = pressRef.current
    if (!p) return
    if (p.pickupTimer) { clearTimeout(p.pickupTimer); p.pickupTimer = null }
    if (p.menuTimer) { clearTimeout(p.menuTimer); p.menuTimer = null }
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

  // --- Touch gesture arbitration (long-press pickup, no grip) ---

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

  // Open a row's context menu at a point by dispatching a real contextmenu
  // event there. The trigger has to actually handle an event to capture the
  // point it anchors the menu to -- disabling the trigger (tried once) removed
  // that capture along with the timing, and the menu opened at the viewport
  // origin instead of the row. Dispatching keeps the capture and leaves us the
  // timing, since the trigger's own long-press is suppressed at `pointerdown`.
  const openRowMenuAt = (x: number, y: number) => {
    if (typeof document === 'undefined') return
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
  }

  // The menu opened or closed. The primitive owns that state -- there is no
  // controlled `open` to drive -- so this is a notification.
  //
  // Only OUR menu ends the press. If the primitive's own long-press fires on a
  // gesture we are already running, the finger may still be about to drag, and
  // tearing the press down here would leave the row undraggable for the rest of
  // that gesture -- the menu appears and nothing can be moved afterwards. We
  // cannot stop that menu from opening (its root takes no controlled `open`),
  // but we can decline to let it cancel a drag the user is in the middle of.
  const handleMenuOpen = (open: boolean) => {
    if (open) {
      if (ownMenuDispatchRef.current) cancelPress()
      return
    }
    // Closed: disarm, which disables the trigger again for the next touch press.
    setMenuArmed(null)
  }

  // One press serves scroll, drag and menu; movement tells them apart. On finger
  // down we start a PICKUP_DELAY_MS timer and watch for movement. Move past the
  // tolerance before it fires -> scroll (never preventDefault'd, the browser
  // keeps it). Still within tolerance when it fires -> arm the row (lift). After
  // that, movement past the threshold drags it (preventDefault only then -- drift
  // while holding stays uncancelled, or the browser has no gesture left). A
  // second, independent timer opens the row's menu mid-hold, at MENU_DELAY_MS,
  // without waiting for release -- release afterward only has to swallow the
  // browser's synthesised click.
  const startPress = (kind: 'item' | 'folder', id: string, list: string, e: ReactTouchEvent<HTMLDivElement>) => {
    if (pressRef.current) return
    // The gesture owns the tree from here until `end`, including the armed
    // window before any movement. A resync arriving in it is parked, never
    // applied underneath the finger.
    setGestureActive(true)
    const t0 = e.touches[0]
    const p: Press = { kind, id, list, startX: t0.clientX, startY: t0.clientY, startTime: Date.now(), committed: false, aborted: false, moved: false, menuOpened: false, pickupTimer: null, menuTimer: null }
    pressRef.current = p

    const move = (ev: TouchEvent) => {
      if (pressRef.current !== p || p.menuOpened) return
      const t = ev.touches[0]
      const dx = t.clientX - p.startX
      const dy = t.clientY - p.startY
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      if (p.aborted) return
      if (!p.committed) {
        if (dist > PICKUP_TOLERANCE_PX) {
          // Moved before the pickup delay -> a scroll. Hand the gesture back; we
          // never preventDefault'd, so the browser scrolls.
          p.aborted = true
          if (p.pickupTimer) { clearTimeout(p.pickupTimer); p.pickupTimer = null }
          if (p.menuTimer) { clearTimeout(p.menuTimer); p.menuTimer = null }
          setLifted(null)
        }
        return
      }
      // Armed. A held finger drifts a pixel or two; that sub-threshold drift
      // must NOT be cancelled -- the browser needs an uncancelled press, and we
      // only take the gesture once this is a real drag. So preventDefault (and
      // the drag itself) start only past the threshold; drift below it leaves
      // the press live so the menu timer can still open the menu.
      if (!p.moved) {
        if (dist <= PICKUP_TOLERANCE_PX) return
        p.moved = true
        if (p.menuTimer) { clearTimeout(p.menuTimer); p.menuTimer = null }
        setLifted(null)
        setDrag(dragPayload(p))
      }
      // Real drag: cancel the browser's scroll and follow the finger. The point
      // is stored relative to the list, since that is what the ghost is placed
      // against; hit-testing below keeps using the raw viewport coordinates.
      ev.preventDefault()
      const box = rootElRef.current?.getBoundingClientRect()
      setTouchDrag({ kind: p.kind, id: p.id, x: t.clientX - (box?.left ?? 0), y: t.clientY - (box?.top ?? 0) })
      setOver(overAtPoint(t.clientX, t.clientY, p.kind))
    }

    const end = (ev: TouchEvent) => {
      if (pressRef.current !== p) return
      if (p.pickupTimer) { clearTimeout(p.pickupTimer); p.pickupTimer = null }
      if (p.menuTimer) { clearTimeout(p.menuTimer); p.menuTimer = null }
      const t = ev.changedTouches[0]
      if (p.committed && p.moved) {
        const target = overAtPoint(t.clientX, t.clientY, p.kind)
        if (target) {
          const next = applyDropWithPending(stateRef.current, dragPayload(p), target)
          if (next !== stateRef.current) commit(next)
        }
      }
      // Anything else is a tap or a scroll, and needs nothing from us: we never
      // cancel the press, so the browser still raises the click that selects the
      // chat or toggles the folder.
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

    p.pickupTimer = setTimeout(() => {
      if (pressRef.current !== p || p.aborted) return
      // Held still within tolerance for the delay -> pick the row up.
      p.committed = true
      setLifted({ kind: p.kind, id: p.id })
      vibrate()
    }, PICKUP_DELAY_MS)

    p.menuTimer = setTimeout(() => {
      if (pressRef.current !== p || p.aborted || p.moved) return
      // Still held, still armed, never dragged -> open the menu right now,
      // without waiting for release. Dispatch a real contextmenu at the
      // (still-current, since we haven't moved) start point so the primitive
      // captures a correct anchor; the ref flag marks this open as ours.
      p.menuOpened = true
      setLifted(null)
      vibrate()
      setMenuArmed({ id: p.id, x: p.startX, y: p.startY })
    }, MENU_DELAY_MS)

    window.addEventListener('touchmove', move, { passive: false })
    window.addEventListener('touchend', end)
    window.addEventListener('touchcancel', end)
  }

  // The armed row's trigger has just been re-enabled by the render, so it is
  // listening again -- dispatch the event it opens on. Doing this from an
  // effect rather than from the timer is the whole point: by the time it runs,
  // the change of `disabled` has been committed.
  useEffect(() => {
    if (!menuArmed) return
    ownMenuDispatchRef.current = true
    openRowMenuAt(menuArmed.x, menuArmed.y)
    ownMenuDispatchRef.current = false
  }, [menuArmed])

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
          onTouchStart={(e) => startPress('item', id, list, e)}
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
            disabled={leaf.disabled}
            active={leaf.id === activeId}
            onSelect={onSelect}
            onRename={onRename}
            onStopProcess={onStopProcess}
            onClose={onClose}
            onDelete={onDelete}
            actions={itemActions}
            onPointerDown={noteInputType}
            menuDisabled={touchInput && menuArmed?.id !== id}
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
            disabled={touchInput && menuArmed?.id !== fid}
            onOpenChange={handleMenuOpen}
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
              onTouchStart={(e) => { if (editing !== fid) startPress('folder', fid, 'folders', e) }}
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
