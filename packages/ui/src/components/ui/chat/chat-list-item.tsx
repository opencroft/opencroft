'use client'

import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { Pencil, Square, Trash2, X } from 'lucide-react'

import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'
import type { StatusVariant } from 'ui/components/ui/utils/status-indicator'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from 'ui/components/ui/context-menu'
import { cn } from 'ui/lib/utils'

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
  // Lands on the row element itself, which is also the element the context-menu
  // trigger attaches to. That placement is the point: the trigger arms its own
  // touch long-press behind a `defaultPrevented` check and runs this handler
  // first, so a host that cancels the event here suppresses that long-press and
  // keeps the menu on its own schedule. Nothing else reaches the trigger in
  // time -- an ancestor does not.
  //
  // Cancelling `pointerdown` also suppresses the click the browser would
  // synthesise from a tap, so a host that uses this owes the row its tap: it
  // has to act on selection itself. That is why this is passed in rather than
  // done here -- the component that takes the click away answers for it.
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
//   waiting  -> pending approval    -> "Waiting",  blue (primary) dot
// The concrete dot colours live in the shared status-indicator primitive.
const STATUS_WORD: Record<ChatStatus, string> = {
  offline: 'Offline',
  idle: 'Idle',
  working: 'Working',
  waiting: 'Waiting',
}
// A dot is shown only for the active states; offline/idle rely on the text.
const STATUS_DOT: Partial<Record<ChatStatus, StatusVariant>> = {
  working: 'success',
  waiting: 'primary',
}

// A single row in a chat list: an avatar (with an optional status dot), a title
// and dimmed description, an optional unsent-draft pencil indicator, and an
// optional actions menu (Rename / Stop process / Close / Delete, plus any extra
// `actions`) built on the shadcn context-menu primitive.
//
// Touch gestures: the row carries NO grip -- one press serves
// scroll, drag and menu, and movement is what tells them apart. The surrounding
// `chat-list` runs the long-press pickup (a ~500ms still hold arms a drag; a
// move before that is a scroll; a still hold long enough hands the press to this
// row menu -- see below). The row body keeps
// `touch-action: pan-y` (so vertical scroll works until the pickup commits) and
// `-webkit-touch-callout`/`user-select` suppress the browser's native
// long-press text behaviour. Desktop is untouched: right-click opens the menu,
// native HTML5 DnD drags the whole row.
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
  const hasMenu = Boolean(onRename || onStopProcess || onClose || onDelete || actions?.length)

  // Derive the dot and the description's status word from the single `status`.
  const dot = status ? STATUS_DOT[status] : undefined
  const statusWord = status ? STATUS_WORD[status] : null
  // "Name · Status" when both are present; either alone otherwise; nothing when
  // neither is set (no description and no status).
  const secondary = description && statusWord ? `${description} · ${statusWord}` : description ?? statusWord

  const row = (
    <div
      role='button'
      tabIndex={0}
      data-active={active}
      aria-disabled={disabled}
      style={{ touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' }}
      onPointerDown={onPointerDown}
      onClick={() => onSelect?.(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect?.(id)
        }
      }}
      className={cn(
        'relative flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left outline-none transition-colors',
        'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:bg-muted',
        disabled && 'opacity-60',
      )}
    >
      <AgentAvatar avatar={avatarUrl} name={title} statusIndicator={dot} />
      <span className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
        <span className='truncate text-xs font-medium text-foreground'>{title}</span>
        {secondary ? <span className='truncate text-xs text-muted-foreground'>{secondary}</span> : null}
      </span>
      {hasDraft ? (
        <span title='Unsent draft' className='ml-auto inline-flex items-center text-muted-foreground'>
          <Pencil className='size-3.5' aria-hidden />
          <span className='sr-only'>Unsent draft</span>
        </span>
      ) : null}
    </div>
  )

  const inner = hasMenu ? (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild disabled={menuDisabled}>{row}</ContextMenuTrigger>
      <ContextMenuContent
        className='min-w-[8rem]'
        onClick={(e) => e.stopPropagation()}
      >
        {onRename ? (
          <ContextMenuItem onClick={() => onRename(id)}>
            <Pencil className='size-3' />
            Rename
          </ContextMenuItem>
        ) : null}
        {actions?.length
          ? actions.map((a) => (
              <ContextMenuItem
                key={a.label}
                className={a.destructive ? 'text-destructive focus:text-destructive' : undefined}
                onClick={() => a.onSelect(id)}
              >
                {a.icon}
                {a.label}
              </ContextMenuItem>
            ))
          : null}
        {onStopProcess ? (
          <ContextMenuItem onClick={() => onStopProcess(id)}>
            <Square className='size-3' />
            Stop process
          </ContextMenuItem>
        ) : null}
        {onClose ? (
          <ContextMenuItem onClick={() => onClose(id)}>
            <X className='size-3' />
            Close
          </ContextMenuItem>
        ) : null}
        {onDelete ? (
          <ContextMenuItem className='text-destructive focus:text-destructive' onClick={() => onDelete(id)}>
            <Trash2 className='size-3' />
            Delete
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  ) : (
    row
  )

  return inner
}
