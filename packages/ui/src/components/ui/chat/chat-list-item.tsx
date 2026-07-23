'use client'

import type { ReactNode } from 'react'
import { MoreVertical, Pencil, Trash2, X } from 'lucide-react'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import type { StatusVariant } from '@/components/ui/utils/status-indicator'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  onClose?: (id: string) => void
  onDelete?: (id: string) => void
  actions?: ChatListItemAction[]
}

// A single row in a chat list: avatar (with an optional pending dot) beside a
// title and dimmed description, an optional unsent-draft pencil indicator, and
// an optional actions menu (Rename / Close / Delete, plus any extra `actions`)
// built on the shadcn dropdown-menu primitive. Self-contained, so it works in
// any list — not only a sidebar. Title/description truncate; long content never
// grows the row.
export function ChatListItem({ id, title, description, avatarUrl, active = false, statusIndicator, hasDraft = false, onSelect, onRename, onClose, onDelete, actions }: ChatListItemProps) {
  const hasMenu = Boolean(onRename || onClose || onDelete || actions?.length)

  return (
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
      {hasDraft || hasMenu ? (
        <span className='ml-auto flex shrink-0 items-center gap-1'>
          {hasDraft ? (
            <span title='Unsent draft' className='inline-flex items-center text-muted-foreground'>
              <Pencil className='size-3.5' aria-hidden />
              <span className='sr-only'>Unsent draft</span>
            </span>
          ) : null}
          {hasMenu ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type='button'
                  aria-label='Open actions menu'
                  onClick={(e) => e.stopPropagation()}
                  className='inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                >
                  <MoreVertical className='size-4' />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='end'
                className='min-w-[8rem]'
                onClick={(e) => e.stopPropagation()}
              >
                {onRename ? (
                  <DropdownMenuItem onClick={() => onRename(id)}>
                    <Pencil className='size-3' />
                    Rename
                  </DropdownMenuItem>
                ) : null}
                {actions?.length
                  ? actions.map((a) => (
                      <DropdownMenuItem
                        key={a.label}
                        className={a.destructive ? 'text-destructive focus:text-destructive' : undefined}
                        onClick={() => a.onSelect(id)}
                      >
                        {a.icon}
                        {a.label}
                      </DropdownMenuItem>
                    ))
                  : null}
                {onClose ? (
                  <DropdownMenuItem onClick={() => onClose(id)}>
                    <X className='size-3' />
                    Close
                  </DropdownMenuItem>
                ) : null}
                {onDelete ? (
                  <DropdownMenuItem className='text-destructive focus:text-destructive' onClick={() => onDelete(id)}>
                    <Trash2 className='size-3' />
                    Delete
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
