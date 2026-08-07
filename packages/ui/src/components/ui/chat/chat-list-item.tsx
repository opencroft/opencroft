'use client'

import type { PointerEvent as ReactPointerEvent, ReactNode, TouchEvent as ReactTouchEvent } from 'react'
import { GripVertical, Pencil, Square, Trash2, X } from 'lucide-react'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import type { StatusVariant } from '@/components/ui/utils/status-indicator'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'

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
  // Renders the touch drag handle and starts a drag from it. Given by the
  // surrounding list; a row used on its own shows no grip.
  //
  // The grip is the ONLY place a touch drag starts, which is what lets the row
  // body keep all three of its own gestures: vertical swipe scrolls, long press
  // opens the menu, tap selects. It is `touch-action: none` so the browser
  // hands us the gesture immediately -- on a vertical list a vertical drag from
  // a `pan-y` surface is not unreliable, it is impossible.
  onGripTouchStart?: (event: ReactTouchEvent<HTMLSpanElement>) => void
  // Reports the menu opening or closing. The context-menu primitive owns that
  // state -- its root takes no controlled `open`, by design: it opens from a
  // `contextmenu` event and nothing else. So this is a notification, not a
  // handle. A host that needs the menu at a moment of its own choosing
  // dispatches that event; the surrounding list also uses this to drop an
  // in-flight touch press when a menu appears mid-gesture.
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
// Touch gestures: each one belongs to an element. The **grip** (rendered only
// when the surrounding list passes `onGripTouchStart`, and only on a coarse
// pointer) is where a drag starts -- it is `touch-action: none`, so the browser
// hands it the gesture immediately, which is the only way a VERTICAL drag can
// start from inside a vertically scrolling list. The **row body** keeps
// everything else: `touch-action: pan-y` so a swipe scrolls, the primitive's
// own long press for the menu, and a tap to select. Nothing competes, so
// nothing has to be told apart after the fact.
//
// `-webkit-touch-callout`/`user-select` suppress the browser's native
// long-press text behaviour on the body. Desktop is untouched: right-click
// opens the menu, native HTML5 DnD drags the whole row, and no grip renders.
//
// The menu's trigger stays enabled on every pointer type: the primitive anchors
// the menu to the point it captures while handling the event, so disabling it
// leaves nothing to anchor to and the menu lands at the viewport origin. The
// grip cancels its own `pointerdown` so a press held still THERE cannot reach
// the trigger -- a drag handle that opens a menu when you pause on it is the
// defect that removed an earlier version of this grip.
//
// Title/description truncate; long content never grows the row. Self-contained,
// works in any list.
export function ChatListItem({ id, title, description, avatarUrl, active = false, disabled = false, status, hasDraft = false, onSelect, onRename, onStopProcess, onClose, onDelete, actions, onPointerDown, menuDisabled = false, onMenuOpenChange, onGripTouchStart }: ChatListItemProps) {
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
      {onGripTouchStart ? (
        <span
          data-drag-handle
          // Hidden on a fine pointer by the media rule the list emits -- the
          // class is inert until that rule exists, so a row rendered outside
          // `chat-list` shows no grip at all.
          className='chat-row-grip ml-1 hidden shrink-0 items-center justify-center p-2 -m-1 text-muted-foreground'
          // `none`, not `pan-y`: this element owns the whole gesture, in every
          // direction. Filing a chat into a folder is a VERTICAL drag, and a
          // vertical drag cannot start from a surface that has promised
          // vertical scrolling to the browser.
          style={{ touchAction: 'none', WebkitTouchCallout: 'none', userSelect: 'none' }}
          onTouchStart={onGripTouchStart}
          // The row's context-menu trigger sits above this element. A press
          // held still on the grip would otherwise reach it and open the menu
          // -- the exact defect that got the previous grip removed. Cancelling
          // `pointerdown` here stops the trigger arming its long-press, so a
          // still hold on the grip does nothing until it moves.
          onPointerDown={(e) => e.preventDefault()}
          // Decorative: the drag it starts is pointer-only and has no keyboard
          // equivalent, so announcing a control that AT cannot operate would
          // promise something untrue. The accessible route to moving a chat is
          // the row menu (context-menu key / Shift+F10).
          aria-hidden='true'
        >
          <GripVertical className='size-4' />
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
