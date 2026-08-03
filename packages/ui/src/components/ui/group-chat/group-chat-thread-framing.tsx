'use client'

import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

import { MemberAvatarGroup, type MemberRef } from '@/components/ui/group-chat/member-avatar-group'
import { cn } from '@/lib/utils'

export interface GroupChatThreadFramingProps {
  /** The topic of the group chat this thread belongs to (phase-1). */
  groupChatTopic: string
  /** The thread's own title; null until something names it. */
  threadTitle?: string | null
  /** Optional participants, shown compactly on the trailing side. */
  members?: MemberRef[]
  /** Back out of the conversation — to the thread list / group chat. */
  onBack?: () => void
  /** The conversation itself — agent-chat/chat-conversation, reused not redrawn. */
  children: ReactNode
  className?: string
}

// The framing for a thread's conversation inside a group chat. The conversation
// surface itself is reused unchanged (a group-chat thread is an ordinary agent
// session — see agent-chat/chat-conversation); what is worth designing is the
// context above it: the group chat a thread belongs to and its topic, with the
// thread's own title, and a back affordance that matters most on minimal widths
// where the conversation is a leaf view. No status, no locks — this only
// states where the reader is.
export function GroupChatThreadFraming({
  groupChatTopic,
  threadTitle,
  members,
  onBack,
  children,
  className,
}: GroupChatThreadFramingProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <header className='flex shrink-0 items-center gap-2 border-b border-border px-2 py-2'>
        {onBack ? (
          <button
            type='button'
            onClick={onBack}
            aria-label='Back'
            className='inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
          >
            <ChevronLeft className='size-4' />
          </button>
        ) : null}
        <div className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
          <span className='truncate text-xs text-muted-foreground'>{groupChatTopic}</span>
          <span className='truncate text-sm font-medium text-foreground'>
            {threadTitle || 'Thread'}
          </span>
        </div>
        {members && members.length > 0 ? (
          <MemberAvatarGroup members={members} max={4} size='sm' className='shrink-0' />
        ) : null}
      </header>
      <div className='min-h-0 flex-1 overflow-hidden'>{children}</div>
    </div>
  )
}
