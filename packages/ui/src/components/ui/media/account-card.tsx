'use client'

import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'
import { cn } from 'cn'

export interface AccountCardProps {
  /** What the account is called. */
  name: string
  /** The handle that names it in text, without the at-sign: the card shows it plain. */
  username: string
  /** The account's own avatar; a person fallback when it has none. */
  avatarUrl?: string | null
  /** An agent is marked as one by the word "Agent" beside its name; a person carries no mark. */
  kind: 'user' | 'agent'
  className?: string
}

// Who an account is, at a glance: avatar, name, username. One card for a
// person and an agent alike -- they are both accounts someone can mention --
// and an agent is told apart inside it, by the word "Agent" beside the name,
// not by another shape.
//
// The name and the username truncate rather than wrap, so a long one keeps
// the card one avatar high wherever it is shown.
export function AccountCard({ name, username, avatarUrl, kind, className }: AccountCardProps) {
  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      <AgentAvatar avatar={avatarUrl} name={name} size='lg' />
      <div className='flex min-w-0 flex-col gap-0.5'>
        <div className='flex min-w-0 items-center gap-1.5'>
          <span className='truncate font-medium'>{name}</span>
          {kind === 'agent' ? (
            <span className='shrink-0 text-xs text-muted-foreground'>Agent</span>
          ) : null}
        </div>
        <span className='truncate text-sm text-muted-foreground'>{username}</span>
      </div>
    </div>
  )
}
