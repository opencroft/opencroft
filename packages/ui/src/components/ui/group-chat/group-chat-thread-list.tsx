'use client'

import { ChatListItem } from '@/components/ui/chat/chat-list-item'
import { cn } from '@/lib/utils'

export interface AgentRef {
  nodeId: string
  name: string
  avatarUrl?: string | null
}

export interface GroupChatThreadListItem {
  id: string
  title: string | null
  agent: AgentRef
  createdAt: Date
  // True when the thread's agent is no longer a member of the group chat. The
  // row stays (the conversation is still readable) but reads as inactive, and
  // acting on it is gated by the host. Set by the host from membership.
  disabled?: boolean
}

export interface GroupChatThreadListProps {
  threads: GroupChatThreadListItem[]
  activeId?: string
  onSelect?: (id: string) => void
  /** Per-row delete. Forwards to ChatListItem's context-menu Delete; the host
     decides whether to confirm before acting (the kit does not). */
  onDelete?: (id: string) => void
  className?: string
}

const dateFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })

// The threads inside one group chat. A thread is a session with exactly one
// agent, so a row is agent-shaped — which is why the existing ChatListItem fits
// and is reused rather than duplicated. No status, typing or unread is passed:
// that data does not exist in phase 1. `createdAt` is shown labelled "created"
// so it can never read as activity (GroupChat.updatedAt is not bumped by thread
// activity, so a bare timestamp would be quietly misleading).
export function GroupChatThreadList({ threads, activeId, onSelect, onDelete, className }: GroupChatThreadListProps) {
  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-0.5', className)}>
      {threads.map((t) => (
        <ChatListItem
          key={t.id}
          id={t.id}
          title={t.title ?? 'Untitled'}
          description={
            t.disabled
              ? `${t.agent.name} · agent removed`
              : `${t.agent.name} · created ${dateFormatter.format(t.createdAt)}`
          }
          avatarUrl={t.agent.avatarUrl}
          active={t.id === activeId}
          disabled={t.disabled}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
