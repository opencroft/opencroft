'use client'

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Pencil, Square, X } from 'lucide-react'

import { AgentAvatar } from '../media/agent-avatar'
import { ListRow } from '../utils/list-row'
import { RowContextMenu, type RowMenuEntry } from '../utils/row-context-menu'
import type { StatusVariant } from '../utils/status-indicator'

export interface ChatListItemAction {
  label: string
  onSelect: (id: string) => void
  icon?: ReactNode
  destructive?: boolean
}

// The row's process state. A single `status` drives BOTH the status word shown
// in the description line and the status dot, so they can never disagree.
export type ChatStatus = 'offline' | 'idle' | 'working' | 'waiting'

interface ChatListItemProps {
  id: string
  title: string
  description?: string
  avatarUrl?: string | null
  active?: boolean
  // Dim the row without hiding it. Used for a group-chat thread whose agent
  // has been removed: the conversation stays readable, the row just reads as
  // inactive. Selection still fires -- the content is visible, only acting on
  // it (sending) is gated elsewhere.
  disabled?: boolean
  status?: ChatStatus
  hasDraft?: boolean
  onSelect?: (id: string) => void
  onRename?: (id: string) => void
  onStopProcess?: (id: string) => void
  onClose?: (id: string) => void
  onDelete?: (id: string) => void
  actions?: ChatListItemAction[]
  // Forwarded to the shared row shell, where it lands on the row element that
  // the context-menu trigger also attaches to -- see ListRow for why that
  // placement is what lets a host take the menu's timing over, and for the tap
  // it owes the row in exchange.
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void
  // Disables the context-menu trigger, which does two things at once: the menu
  // stops opening by itself on a touch long-press, and -- the part that matters
  // -- the primitive clears any timer it had already armed, in an effect keyed
  // on this prop. A host running its own press uses that to take the menu's
  // timing over: hold this true for the gesture, then release it at the moment
  // the menu should appear and dispatch a `contextmenu` once the render has
  // landed. Being a render rather than an event, it does not depend on which
  // listener the browser reaches first.
  menuDisabled?: boolean
  // Reports the menu opening or closing. The context-menu primitive owns that
  // state -- its root takes no controlled `open`, by design: it opens from a
  // `contextmenu` event and nothing else. So this is a notification, not a
  // handle. A host that needs the menu at a moment of its own choosing
  // dispatches that event; the surrounding list also uses this to drop an
  // in-flight touch press when a menu appears.
  onMenuOpenChange?: (open: boolean) => void
}

// The description line carries the process state as text, and a status dot is
// shown only for the two *active* states. `status` derives both:
//   offline  -> no process          -> "Offline",  no dot
//   idle     -> process alive/idle  -> "Idle",     no dot
//   working  -> active turn         -> "Working",  green (success) dot
//   waiting  -> needs someone       -> "Waiting",  blue (primary) dot
//               (a permission to grant or a question to answer)
// The concrete dot colours live in the shared status-indicator primitive.
//
// Exported because this row's status line is THE vocabulary for a session's
// process state, and other surfaces (the thread framing's header) say the
// same thing about the same session -- importing these is what keeps a word
// and a dot from drifting between a list row and the header a press on it
// opens.
export const STATUS_WORD: Record<ChatStatus, string> = {
  offline: 'Offline',
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting',
}
// A dot is shown only for the active states; offline/idle rely on the text.
export const STATUS_DOT: Partial<Record<ChatStatus, StatusVariant>> = {
  working: 'success',
  waiting: 'primary',
}

// A single row in a chat list: an avatar (with an optional status dot), a title
// and dimmed description, an optional unsent-draft pencil indicator, and an
// optional actions menu (Rename / Stop process / Close / Delete, plus any extra
// `actions`) built on the shadcn context-menu primitive.
//
// The row body itself is ListRow, the shared shell a group-chat row also draws.
// That means the geometry, the active and hover treatment, the keyboard
// activation and the touch handling are not this component's to state -- which
// is the point, because this row and the group-chat row used to agree on the
// first three and differ on the fourth.
//
// Touch gestures: the row carries NO grip -- one press serves scroll, drag and
// menu, and movement is what tells them apart. The surrounding `chat-list` runs
// the long-press pickup (a ~500ms still hold arms a drag; a move before that is
// a scroll; a still hold long enough hands the press to this row menu -- see
// below). The shell keeps `touch-action: pan-y` so vertical scroll works until
// the pickup commits, and suppresses the browser's native long-press text
// behaviour. Desktop is untouched: right-click opens the menu, native HTML5 DnD
// drags the whole row.
//
// The menu's own trigger stays enabled on every pointer type, including touch:
// the primitive anchors the menu to the point it captures while handling the
// event, so disabling it leaves nothing to anchor to and the menu lands at the
// viewport origin instead of the row. Its built-in touch long-press rides along
// with that and cannot be switched off separately -- a host that wants the menu
// on a schedule of its own suppresses the long-press by cancelling the
// `pointerdown` before the trigger sees it, which is what `chat-list` does.
//
// Title/description truncate; long content never grows the row. Self-contained,
// works in any list.
export function ChatListItem({ id, title, description, avatarUrl, active = false, disabled = false, status, hasDraft = false, onSelect, onRename, onStopProcess, onClose, onDelete, actions, onPointerDown, menuDisabled = false, onMenuOpenChange }: ChatListItemProps) {
  // Derive the dot and the description's status word from the single `status`.
  const dot = status ? STATUS_DOT[status] : undefined
  const statusWord = status ? STATUS_WORD[status] : null
  // "Name · Status" when both are present; either alone otherwise; nothing when
  // neither is set (no description and no status).
  const secondary = description && statusWord ? `${description} · ${statusWord}` : description ?? statusWord

  const row = (
    <ListRow
      leading={<AgentAvatar avatar={avatarUrl} name={title} statusIndicator={dot} />}
      title={title}
      secondary={secondary}
      active={active}
      disabled={disabled}
      onSelect={() => onSelect?.(id)}
      onPointerDown={onPointerDown}
      trailing={
        hasDraft ? (
          <span title='Unsent draft' className='ml-auto inline-flex items-center text-muted-foreground'>
            <Pencil className='size-3.5' aria-hidden />
            <span className='sr-only'>Unsent draft</span>
          </span>
        ) : null
      }
    />
  )

  // The menu itself is row-context-menu: the width, the click guard and what
  // Delete looks like are its business, not this row's. What stays here is the
  // order the entries appear in and the wording of the three this row owns.
  //
  // Delete goes through `onDelete` rather than as an entry, so it is the same
  // Delete every other list in the kit draws. With no handlers at all the menu
  // component returns the row untouched, which is what the old `hasMenu` check
  // did by hand.
  const entries: RowMenuEntry[] = []

  if (onRename) {
    entries.push({ label: 'Rename', icon: <Pencil className='size-3' />, onSelect: () => onRename(id) })
  }

  // Host actions keep their position between Rename and Stop process, and keep
  // taking the row id -- that is this row's public contract, not the menu's.
  for (const action of actions ?? []) {
    entries.push({
      label: action.label,
      icon: action.icon,
      destructive: action.destructive,
      onSelect: () => action.onSelect(id),
    })
  }

  if (onStopProcess) {
    entries.push({ label: 'Stop process', icon: <Square className='size-3' />, onSelect: () => onStopProcess(id) })
  }

  if (onClose) {
    entries.push({ label: 'Close', icon: <X className='size-3' />, onSelect: () => onClose(id) })
  }

  return (
    <RowContextMenu
      entries={entries}
      onDelete={onDelete ? () => onDelete(id) : undefined}
      disabled={menuDisabled}
      onOpenChange={onMenuOpenChange}
    >
      {row}
    </RowContextMenu>
  )
}
