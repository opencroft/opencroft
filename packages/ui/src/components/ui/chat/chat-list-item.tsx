'use client'

import type { ReactNode } from 'react'
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
  status?: ChatStatus
  hasDraft?: boolean
  onSelect?: (id: string) => void
  onRename?: (id: string) => void
  onStopProcess?: (id: string) => void
  onClose?: (id: string) => void
  onDelete?: (id: string) => void
  actions?: ChatListItemAction[]
  // Notified when the context menu opens/closes. Radix `ContextMenu` owns the
  // open state (it has no controlled/imperative open), so this
  // is a notification, not control. The surrounding list uses it to cancel an
  // in-flight touch press if a menu ever opens mid-press.
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

// A single row in a chat list: a **grip handle** shown only on touch
// (coarse-pointer) devices as the touch drag source, beside an avatar (with an
// optional status dot), a title and dimmed description, an optional unsent-draft
// pencil indicator, and an optional actions menu (Rename / Stop process / Close /
// Delete, plus any extra `actions`) built on the shadcn context-menu primitive.
//
// Touch gestures: the three list gestures each own a separate
// input and never compete. The **grip handle** (data-drag-handle,
// touch-action: none) is the only place a touch drag starts -- press it and move
// (any direction; moving a chat between folders is a vertical drag). The row
// body keeps `touch-action: pan-y` (vertical scroll) and opens the menu via
// Radix's native long-press; `-webkit-touch-callout`/`user-select` suppress the
// browser's native long-press text behaviour. The grip is a sibling OUTSIDE the
// ContextMenuTrigger so grabbing it never opens the menu. Desktop is untouched:
// right-click opens the menu, native HTML5 DnD drags the whole row.
//
// Title/description truncate; long content never grows the row. Self-contained,
// works in any list.
export function ChatListItem({ id, title, description, avatarUrl, active = false, status, hasDraft = false, onSelect, onRename, onStopProcess, onClose, onDelete, actions, onMenuOpenChange }: ChatListItemProps) {
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
      style={{ touchAction: 'pan-y', WebkitTouchCallout: 'none', userSelect: 'none' }}
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

  // The grip is the touch drag source. It is `hidden` by default and shown only
  // on coarse-pointer (touch) devices -- the `@media (pointer: coarse)` rule that
  // flips it on is emitted once in `chat-list` (the container), not per row, so
  // the densest surface is not handed one style element per chat. `touch-action:
  // none` so the browser never scrolls when the grip is grabbed, and a sibling
  // OUTSIDE the ContextMenu so a long-press on it cannot open the row menu. Drag
  // is a pointer gesture (not keyboard reachable), so the handle is hidden from
  // AT on purpose -- the action menu stays the keyboard path (see the docs).
  const grip = (
    <div
      data-drag-handle
      aria-hidden='true'
      style={{ touchAction: 'none' }}
      className='chat-list-item-grip hidden shrink-0 cursor-grab items-center justify-center self-stretch px-0.5 text-muted-foreground'
    >
      <GripVertical className='size-3.5' />
    </div>
  )

  const inner = hasMenu ? (
    <ContextMenu onOpenChange={onMenuOpenChange}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
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

  return (
    <div className='flex items-stretch'>
      {grip}
      <div className='min-w-0 flex-1'>{inner}</div>
    </div>
  )
}
