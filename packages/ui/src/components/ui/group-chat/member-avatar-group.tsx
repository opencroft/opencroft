'use client'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import { cn } from '@/lib/utils'

export interface MemberRef {
  kind: 'user' | 'agent'
  id: string
  name: string
  avatarUrl?: string | null
}

export interface MemberAvatarGroupProps {
  members: MemberRef[]
  /** How many avatars show before the rest fold into a +N pill. */
  max?: number
  size?: 'sm' | 'md'
  className?: string
}

// A cluster of participant avatars — users and agents mixed — for the
// group-chat surface. It is built from the single AgentAvatar the kit already
// ships: a person's avatar needs nothing an agent's does, so there is one
// avatar atom, and the new piece here is the composition, not a second atom.
// Overflow folds into a +N pill, and the whole cluster carries the names as a
// tooltip so who is taking part is always one hover away.
//
// There is no status dot and no per-kind badge. A group chat is a container of
// participants, and who can see what is a server-side rule — not something this
// cluster is in a position to claim, so it does not.
export function MemberAvatarGroup({ members, max = 4, size = 'sm', className }: MemberAvatarGroupProps) {
  const count = members.length
  if (count === 0) return null

  const shown = members.slice(0, Math.max(1, max))
  const overflow = Math.max(0, count - shown.length)
  const overlap = size === 'md' ? '-ml-2.5' : '-ml-2'
  const pill = size === 'md' ? 'size-8' : 'size-6'
  const title =
    shown.map((m) => m.name).join(', ') + (overflow > 0 ? ` +${overflow} more` : '')

  return (
    <span className={cn('flex items-center', className)} title={title}>
      {shown.map((m, i) => (
        <span key={m.id} className={cn('rounded-full ring-2 ring-background', i > 0 && overlap)}>
          <AgentAvatar avatar={m.avatarUrl} name={m.name} size={size} />
        </span>
      ))}
      {overflow > 0 ? (
        <span
          aria-label={`${overflow} more participant${overflow === 1 ? '' : 's'}`}
          className={cn(
            'inline-flex items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground ring-2 ring-background',
            pill,
            overlap,
          )}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  )
}
