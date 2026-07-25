'use client'

import type { ReactNode } from 'react'
import { Pencil, Square, Trash2, X } from 'lucide-react'

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
  // is a notification, not control: the surrounding list uses it to cancel an
  // in-flight touch press the moment the menu opens, so a long-press that opened
  // the menu can't also start a drag.
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

// A single row in a chat list: avatar (with an optional status dot) beside a
// title and dimmed description, an optional unsent-draft pencil indicator, and
// an optional actions menu (Rename / Stop process / Close / Delete, plus any
// extra `actions`) built on the shadcn context-menu primitive. The menu opens
// via right-click on desktop or long-press on touch -- both through Radix's
// native contextmenu handling -- so there is no visible trigger button and it
// stays out of the way on both. The row suppresses the browser's native
// long-press behavior (iOS callout + text selection) and sets `touch-action:
// pan-y` so vertical list scrolling keeps working; the list arbitrates the
// long-press-vs-drag via `onMenuOpenChange`. Title/description
// truncate; long content never grows the row. Self-contained, works in any list.
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

  // No actions -> nothing to put in a menu; render the plain row so the browser
  // context menu is left untouched.
  if (!hasMenu) return row

  return (
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
  )
}
