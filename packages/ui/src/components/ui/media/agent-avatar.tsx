'use client'

import { User } from 'lucide-react'

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { StatusIndicator, type StatusVariant } from '@/components/ui/utils/status-indicator'
import { cn } from '@/lib/utils'

export type AgentAvatarSize = 'sm' | 'md' | 'lg'

// sm → sidebar, md → chat + agent list, lg → agent node avatar setting.
const SIZES: Record<AgentAvatarSize, { box: string; icon: string }> = {
  sm: { box: 'size-6', icon: 'size-3.5' },
  md: { box: 'size-8', icon: 'size-4' },
  lg: { box: 'size-12', icon: 'size-6' },
}

interface AgentAvatarProps {
  avatar?: string | null
  name?: string
  size?: AgentAvatarSize
  /** Status dot variant; omit for no indicator. */
  statusIndicator?: StatusVariant
  className?: string
}

// Agent avatar built on the shared Avatar: shows the agent's image when set,
// falling back to a person icon. When `statusIndicator` is set, a status dot of
// that variant is overlaid (e.g. 'primary' for a session awaiting a permission).
export function AgentAvatar({ avatar, name, size = 'md', statusIndicator, className }: AgentAvatarProps) {
  const dims = SIZES[size]
  return (
    <span className='relative flex w-fit shrink-0'>
      <Avatar className={cn(dims.box, className)}>
        {avatar ? <AvatarImage src={avatar} alt={name ?? ''} /> : null}
        <AvatarFallback>
          <User className={dims.icon} />
        </AvatarFallback>
      </Avatar>
      {statusIndicator ? <StatusIndicator variant={statusIndicator} className='absolute -bottom-0.5 -right-0.5' /> : null}
    </span>
  )
}
