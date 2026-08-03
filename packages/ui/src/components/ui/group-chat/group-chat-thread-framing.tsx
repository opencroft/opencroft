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
  /** Back out of the conversation -- to the thread list / group chat. */
  onBack?: () => void
  /** The conversation itself -- agent-chat/chat-conversation, reused not redrawn. */
  children: ReactNode
  /** The composer, pinned beneath the conversation. Reused from the agent-chat
   * composer family, never redrawn here -- a group-chat thread is an ordinary
   * agent session, so it gets the same composer a 1:1 chat uses. */
  composer?: ReactNode
  className?: string
}

// The framing for a thread's conversation inside a group chat. The conversation
// surface itself is reused unchanged (a group-chat thread is an ordinary agent
// session -- see agent-chat/chat-conversation); what is worth designing is the
// context above it: the group chat a thread belongs to and its topic, with the
// thread's own title, and a back affordance that matters most on minimal widths
// where the conversation is a leaf view. No status, no locks -- this only
// states where the reader is.
//
// The composer is a slot here rather than the host's business because this
// component already owns the vertical arrangement: header pinned, conversation
// scrolling, and now composer pinned. A composer placed inside `children` would
// scroll away with the conversation, and a host rebuilding the arrangement
// around this one would have to re-derive it -- which is exactly the layout
// this already exists to keep right at a phone width.
export function GroupChatThreadFraming({
  groupChatTopic,
  threadTitle,
  members,
  onBack,
  children,
  composer,
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
      {composer ? (
        <div className='shrink-0 border-t border-border px-2 py-2'>{composer}</div>
      ) : null}
    </div>
  )
}
