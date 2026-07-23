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

interface ChatListItemProps {
  id: string
  title: string
  description?: string
  avatarUrl?: string | null
  active?: boolean
  statusIndicator?: StatusVariant
  hasDraft?: boolean
  onSelect?: (id: string) => void
  onRename?: (id: string) => void
  onStopProcess?: (id: string) => void
  onClose?: (id: string) => void
  onDelete?: (id: string) => void
  actions?: ChatListItemAction[]
}

// The row's status indicator reflects the session's *process* state:
//   success  -> process alive (agent process running, idle)
//   primary  -> working (active turn in progress)
//   warning  -> waiting for approval (pending permission request)
//   omitted  -> no process (also what the indicator returns to after
//               "Stop process" -- the chat and its history stay).
// The concrete colours live in the shared status-indicator primitive.

// A single row in a chat list: avatar (with an optional status dot) beside a
// title and dimmed description, an optional unsent-draft pencil indicator, and
// an optional actions menu (Rename / Stop process / Close / Delete, plus any
// extra `actions`) built on the shadcn context-menu primitive. The menu opens
// via right-click or long-press -- there is no visible trigger button -- so it
// stays out of the way on both desktop and touch. Title/description truncate;
// long content never grows the row. Self-contained, so it works in any list.
export function ChatListItem({ id, title, description, avatarUrl, active = false, statusIndicator, hasDraft = false, onSelect, onRename, onStopProcess, onClose, onDelete, actions }: ChatListItemProps) {
  const hasMenu = Boolean(onRename || onStopProcess || onClose || onDelete || actions?.length)

  const row = (
    <div
      role='button'
      tabIndex={0}
      data-active={active}
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
      <AgentAvatar avatar={avatarUrl} name={title} statusIndicator={statusIndicator} />
      <span className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
        <span className='truncate text-xs font-medium text-foreground'>{title}</span>
        {description ? <span className='truncate text-xs text-muted-foreground'>{description}</span> : null}
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
    <ContextMenu>
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
