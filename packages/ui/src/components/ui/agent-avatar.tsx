'use client'

import { User } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from 'ui/avatar'
import { StatusIndicator } from 'ui/utils/status-indicator'

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
  pending?: boolean
  className?: string
}

// Agent avatar built on the shared Avatar: shows the agent's image when set,
// falling back to a person icon. When `pending`, a primary status dot is
// overlaid (e.g. a session awaiting a permission request).
export function AgentAvatar({ avatar, name, size = 'md', pending, className }: AgentAvatarProps) {
  const dims = SIZES[size]
  return (
    <span className='relative flex w-fit shrink-0'>
      <Avatar className={cn(dims.box, className)}>
        {avatar ? <AvatarImage src={avatar} alt={name ?? ''} /> : null}
        <AvatarFallback>
          <User className={dims.icon} />
        </AvatarFallback>
      </Avatar>
      {pending && <StatusIndicator variant='primary' className='absolute -bottom-0.5 -right-0.5' />}
    </span>
  )
}
