'use client'

import type { ReactNode } from 'react'

import { MemberAvatarGroup, type MemberRef } from '@/components/ui/group-chat/member-avatar-group'
import { cn } from '@/lib/utils'
import { NodeCard } from '@/components/ui/nodes/node-card'

export interface GroupChatDetailProps {
  topic: string
  members: MemberRef[]
  /** Replaces the read-only avatar cluster with a host-supplied control --
   * typically the cluster made interactive, so tapping it opens member
   * management (add / remove). Omit to render the cluster read-only. */
  membersSlot?: ReactNode
  /** The thread list (or any content) for this group chat. Omit/leave null to
   * show `emptyState` instead -- the group chat itself holds no messages, so a
   * chat with no threads yet is an empty state, not a blank. */
  threads?: ReactNode
  emptyState?: ReactNode
  /** Header affordances -- adding a member. Any member may add another, so
   * these are ordinary member controls, not admin ones. Starting a thread is
   * the composer below, not a header button: a thread begins with a first
   * message, and a form opened in a dialog would put that message somewhere
   * other than where the thread is about to land. */
  actions?: ReactNode
  /** Pinned beneath the threads -- the new-thread composer. It stays put while
   * the thread list scrolls above it, the way a chat composer stays put while
   * the conversation scrolls. */
  composer?: ReactNode
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
  membersSlot,
  threads,
  emptyState,
  actions,
  composer,
  className,
}: GroupChatDetailProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <header className='flex shrink-0 flex-col gap-3 border-b border-border px-3 py-3'>
        <div className='flex min-w-0 items-center gap-3'>
          <h2 className='min-w-0 flex-1 truncate text-base font-semibold text-foreground'>{topic}</h2>
          {/* The avatar cluster is the single handle for who is taking part:
              the participants at a glance, and -- when the host makes it
              interactive -- the entry point for adding and removing members.
              The host owns that interaction (it needs the directory and the
              add/remove actions), so it can replace this with a clickable
              cluster through `membersSlot`; left plain it is read-only. The
              full member list lives behind it rather than as a row of names, so
              the header is one line at any width. */}
          {membersSlot ?? <MemberAvatarGroup members={members} max={6} size='md' />}
          {/* Kept out of the scroll region and never allowed to shrink: past
              the cluster, the topic gives up its space first, because a
              truncated topic is still readable and a squeezed control is not. */}
          {actions ? <div className='flex shrink-0 items-center gap-1'>{actions}</div> : null}
        </div>
      </header>
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {threads ??
          emptyState ?? (
            <p className='px-3 py-10 text-center text-sm text-muted-foreground'>No threads yet.</p>
          )}
      </div>
      {composer ? (
        <NodeCard accent='var(--primary)' selected className='shrink-0'>
          <div className='px-3 py-2'>{composer}</div>
        </NodeCard>
      ) : null}
    </div>
  )
}
