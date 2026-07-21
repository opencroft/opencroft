'use client'

import { useState } from 'react'
import { MoreVertical, Pencil, Trash2, X } from 'lucide-react'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import { cn } from '@/lib/utils'

interface ChatListItemProps {
  id: string
  title: string
  description?: string
  avatarUrl?: string | null
  active?: boolean
  pending?: boolean
  onSelect?: (id: string) => void
  onRename?: (id: string) => void
  onClose?: (id: string) => void
  onDelete?: (id: string) => void
}

// A single row in a chat list: avatar (with an optional pending dot) beside a
// title and dimmed description, plus an optional actions menu (Rename / Close /
// Delete). Self-contained, so it works in any list — not only a sidebar.
// Title/description truncate; long content never grows the row.
export function ChatListItem({ id, title, description, avatarUrl, active = false, pending = false, onSelect, onRename, onClose, onDelete }: ChatListItemProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const hasMenu = Boolean(onRename || onClose || onDelete)

  const run = (fn?: (id: string) => void) => {
    setMenuOpen(false)
    fn?.(id)
  }

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
      <AgentAvatar avatar={avatarUrl} name={title} statusIndicator={pending ? 'primary' : undefined} />
      <span className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
        <span className='truncate text-xs font-medium text-foreground'>{title}</span>
        {description ? <span className='truncate text-xs text-muted-foreground'>{description}</span> : null}
      </span>
      {hasMenu ? (
        <div className='relative ml-auto shrink-0'>
          <button
            type='button'
            aria-label='Open actions menu'
            aria-haspopup='menu'
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((o) => !o)
            }}
            className='inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground'
          >
            <MoreVertical className='size-4' />
          </button>
          {menuOpen ? (
            <>
              <div
                className='fixed inset-0 z-40'
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuOpen(false)
                }}
              />
              <div
                role='menu'
                className='absolute right-0 top-full z-50 mt-1 min-w-[7rem] overflow-hidden rounded-md border border-border bg-popover p-0.5 text-xs shadow-md'
              >
                {onRename ? (
                  <button
                    type='button'
                    role='menuitem'
                    onClick={(e) => {
                      e.stopPropagation()
                      run(onRename)
                    }}
                    className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-foreground hover:bg-muted'
                  >
                    <Pencil className='size-3' />
                    Rename
                  </button>
                ) : null}
                {onClose ? (
                  <button
                    type='button'
                    role='menuitem'
                    onClick={(e) => {
                      e.stopPropagation()
                      run(onClose)
                    }}
                    className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-foreground hover:bg-muted'
                  >
                    <X className='size-3' />
                    Close
                  </button>
                ) : null}
                {onDelete ? (
                  <button
                    type='button'
                    role='menuitem'
                    onClick={(e) => {
                      e.stopPropagation()
                      run(onDelete)
                    }}
                    className='flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-destructive hover:bg-destructive/10'
                  >
                    <Trash2 className='size-3' />
                    Delete
                  </button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
