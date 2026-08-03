'use client'

import type { ReactNode } from 'react'

import { MemberAvatarGroup, type MemberRef } from '@/components/ui/group-chat/member-avatar-group'
import { cn } from '@/lib/utils'

export interface GroupChatDetailProps {
  topic: string
  members: MemberRef[]
  /** The thread list (or any content) for this group chat. Omit/leave null to
   * show `emptyState` instead -- the group chat itself holds no messages, so a
   * chat with no threads yet is an empty state, not a blank. */
  threads?: ReactNode
  emptyState?: ReactNode
  /** Header affordances -- adding a member, starting a thread. Any member may
   * add another, so these are ordinary member controls, not admin ones. */
  actions?: ReactNode
  className?: string
}

// The view inside one group chat. Topic header, the participants taking part
// (users and agents together, shown as participants -- never as an access list),
// and a slot for the thread list. The group chat itself holds no messages, so
// there is nothing else on this screen; that emptiness is part of the design
// and worth seeing. No locks, no "members only" copy -- the member list is who
// is taking part, not who is permitted.
export function GroupChatDetail({
  topic,
  members,
  threads,
  emptyState,
  actions,
  className,
}: GroupChatDetailProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <header className='flex shrink-0 flex-col gap-3 border-b border-border px-3 py-3'>
        <div className='flex min-w-0 items-center gap-3'>
          <h2 className='min-w-0 flex-1 truncate text-base font-semibold text-foreground'>{topic}</h2>
          <MemberAvatarGroup members={members} max={6} size='md' className='shrink-0' />
          {/* Kept out of the scroll region and never allowed to shrink: at a
              minimal width the topic gives up its space first, because a
              truncated topic is still readable and a squeezed control is not. */}
          {actions ? <div className='flex shrink-0 items-center gap-1'>{actions}</div> : null}
        </div>
        {members.length > 0 ? (
          <ul className='flex flex-wrap gap-x-3 gap-y-1'>
            {members.map((m) => (
              <li key={m.id} className='flex min-w-0 items-center gap-1.5 text-xs'>
                <span
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    m.kind === 'agent' ? 'bg-primary' : 'bg-muted-foreground/40',
                  )}
                />
                <span className='truncate text-foreground'>{m.name}</span>
                <span className='text-muted-foreground/70'>{m.kind}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </header>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {threads ??
          emptyState ?? (
            <p className='px-3 py-10 text-center text-sm text-muted-foreground'>No threads yet.</p>
          )}
      </div>
    </div>
  )
}
