'use client'

import type { QueuedPrompt } from 'agent-client/types'
import { X } from 'lucide-react'
import { Flex } from 'ui/components/ui/layout/flex'

export interface QueuedMessagesProps {
  items: QueuedPrompt[]
  onRemove: (id: string) => void
  className?: string
}

// Prompts held server-side while typed during an active turn, delivered in
// order as turns end (see agent-client's `queue` ChatEvent). Meant to sit
// directly above the composer that produced them — pass `useAgentSession`'s
// `queue`/`removeQueued` straight through.
export function QueuedMessages({ items, onRemove, className }: QueuedMessagesProps) {
  if (items.length === 0) {
    return null
  }
  return (
    <Flex className={className ?? 'gap-1'}>
      {items.map((item) => (
        <Flex
          key={item.id}
          row
          align='center'
          className='min-w-0 gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs'
        >
          <span className='shrink-0 text-muted-foreground'>Queued</span>
          <span className='min-w-0 flex-1 truncate'>{item.text}</span>
          <button
            type='button'
            onClick={() => onRemove(item.id)}
            className='shrink-0 text-muted-foreground transition-colors hover:text-foreground'
            title='Remove from queue'
          >
            <X className='size-3.5' />
          </button>
        </Flex>
      ))}
    </Flex>
  )
}
