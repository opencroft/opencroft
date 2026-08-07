'use client'

import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

import { MemberAvatarGroup, type MemberRef } from '@/components/ui/group-chat/member-avatar-group'
import { cn } from '@/lib/utils'

import { CommandBarFrame } from '@/components/ui/agent-chat/command-bar-frame'
import { ScrollArea } from '@/components/ui/layout/scroll-area'

export interface GroupChatThreadFramingProps {
  /** The NAME of the group chat this thread belongs to -- not its topic. This
   * line is a breadcrumb: it says where the reader is, and what a place is
   * called is what locates it. The topic is a statement of purpose written for
   * the chat's agents and can run to a sentence, which is not what a one-line
   * breadcrumb above a conversation is for. */
  groupChatName: string
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
   * agent session, so it gets the same composer a 1:1 chat uses, in the same
   * CommandBarFrame. That the composer was already shared and the FRAME was not
   * is exactly how this footer came to look unlike the 1:1 one. */
  composer?: ReactNode
  className?: string
}

// The framing for a thread's conversation inside a group chat. The conversation
// surface itself is reused unchanged (a group-chat thread is an ordinary agent
// session -- see agent-chat/chat-conversation); what is worth designing is the
// context above it: the group chat a thread belongs to, by name, with the
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
  groupChatName,
  threadTitle,
  members,
  onBack,
  children,
  composer,
  className,
}: GroupChatThreadFramingProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* px-4, the same horizontal rhythm as the group-chat detail screen and
          the 1:1 conversation beneath -- the back arrow, the chat name and the
          first message all start on one left edge. The scroll area itself gets
          no padding: the conversation inside it carries its own px-4 py-4, and
          adding more here would double it. */}
      <header className='flex shrink-0 items-center gap-2 border-b border-border px-4 py-2'>
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
          <span className='truncate text-xs text-muted-foreground'>{groupChatName}</span>
          <span className='truncate text-sm font-medium text-foreground'>
            {threadTitle || 'Thread'}
          </span>
        </div>
        {members && members.length > 0 ? (
          <MemberAvatarGroup members={members} max={4} size='sm' className='shrink-0' />
        ) : null}
      </header>
      <ScrollArea className='min-h-0 flex-1'>{children}</ScrollArea>
      {composer ? <CommandBarFrame className='shrink-0'>{composer}</CommandBarFrame> : null}
    </div>
  )
}
