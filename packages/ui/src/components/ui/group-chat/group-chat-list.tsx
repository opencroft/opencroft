'use client'

import type { ReactNode } from 'react'

import { MemberAvatarGroup, type MemberRef } from '@/components/ui/group-chat/member-avatar-group'
import { cn } from '@/lib/utils'

export interface GroupChatListItem {
  id: string
  topic: string
  members: MemberRef[]
  threadCount: number
}

export interface GroupChatListRowProps {
  id: string
  topic: string
  members: MemberRef[]
  threadCount: number
  active?: boolean
  onSelect?: (id: string) => void
}

function threadLabel(n: number) {
  return `${n} ${n === 1 ? 'thread' : 'threads'}`
}

// A group-chat row. Same geometry and feel as the existing chat-list-item, with
// the one difference that matters: a group chat is a *container* with several
// members, so the leading element is a cluster of participant avatars rather
// than a single one, and there is deliberately NO process status — offline /
// idle / working describe an agent process and mean nothing for a container.
// Topic is the title; threadCount is the secondary line.
export function GroupChatListRow({
  id,
  topic,
  members,
  threadCount,
  active = false,
  onSelect,
}: GroupChatListRowProps) {
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
      <MemberAvatarGroup members={members} max={3} size='sm' />
      <span className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
        <span className='truncate text-xs font-medium text-foreground'>{topic}</span>
        <span className='truncate text-xs text-muted-foreground'>{threadLabel(threadCount)}</span>
      </span>
    </div>
  )
}

export interface GroupChatListProps {
  chats: GroupChatListItem[]
  activeId?: string
  onSelect?: (id: string) => void
  emptyState?: ReactNode
  className?: string
}

// The section index: every group chat the signed-in user is a member of. A flat
// list of containers — no folders, no drag handle (those belong to the existing
// chat list); group chats are their own navigation section, separate from
// Chats, and reordering is additive later if it is wanted.
export function GroupChatList({ chats, activeId, onSelect, emptyState, className }: GroupChatListProps) {
  if (chats.length === 0) {
    return (
      <div className={cn('flex min-w-0 flex-col', className)}>
        {emptyState ?? (
          <p className='px-2 py-6 text-center text-xs text-muted-foreground'>No group chats yet.</p>
        )}
      </div>
    )
  }
  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-0.5', className)}>
      {chats.map((chat) => (
        <GroupChatListRow
          key={chat.id}
          id={chat.id}
          topic={chat.topic}
          members={chat.members}
          threadCount={chat.threadCount}
          active={chat.id === activeId}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}
