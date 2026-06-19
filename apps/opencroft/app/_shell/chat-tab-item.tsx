'use client'

import { X } from 'lucide-react'
import { AgentAvatar } from 'ui/agent-avatar'
import { SidebarMenuSubButton, SidebarMenuSubItem } from 'ui/sidebar'

import type { ChatTab } from '@/app/(agent)/_lib/chat-tabs-context'

interface ChatTabItemProps {
  tab: ChatTab
  isActive: boolean
  pending: boolean
  onSelect: (key: string) => void
  onClose: (key: string) => void
}

// A chat session row in the sidebar: agent avatar (with a pending dot) beside the
// session title and the dimmed agent name, plus a close control.
export function ChatTabItem({ tab, isActive, pending, onSelect, onClose }: ChatTabItemProps) {
  return (
    <SidebarMenuSubItem>
      <SidebarMenuSubButton
        asChild
        isActive={isActive}
        className='h-auto py-1.5'
        onClick={(e) => {
          e.preventDefault()
          onSelect(tab.key)
        }}
      >
        <button className='flex items-center gap-2 w-full min-w-0'>
          <AgentAvatar avatar={tab.agentAvatar} size='md' pending={pending} />
          <span className='flex flex-col min-w-0 flex-1 text-left leading-tight'>
            <span className='truncate text-xs font-medium text-foreground'>{tab.title ?? tab.label}</span>
            {tab.agentName ? <span className='truncate text-xs text-muted-foreground'>{tab.agentName}</span> : null}
          </span>
          <span
            role='button'
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation()
              onClose(tab.key)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation()
                onClose(tab.key)
              }
            }}
            className='ml-auto size-4 inline-flex items-center justify-center rounded-sm hover:bg-muted hover:text-destructive shrink-0'
            aria-label='Close tab'
          >
            <X className='size-3' />
          </span>
        </button>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  )
}
