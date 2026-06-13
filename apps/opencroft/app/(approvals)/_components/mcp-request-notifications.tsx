'use client'

import { Badge } from 'ui/badge'

import { usePendingRequestEntries } from '@/app/(approvals)/_components/mcp-request-list'
import { cn } from '@/lib/utils'

// Floating bottom-corner notifications for pending MCP requests, visible on
// every space. Clicking one selects the request and opens the MCP Requests tab.
export function McpRequestNotifications({ onOpen }: { onOpen: () => void }) {
  const entries = usePendingRequestEntries()

  if (entries.length === 0) {
    return null
  }

  return (
    <div className='pointer-events-none absolute right-0 bottom-0 z-10 p-3'>
      <div className='pointer-events-auto flex flex-col items-end gap-1.5'>
        {entries.map((entry) => {
          const Icon = entry.icon
          return (
            <button
              key={entry.id}
              type='button'
              onClick={() => {
                entry.select()
                onOpen()
              }}
              className={cn(
                'flex items-center gap-2 rounded-md border bg-background/95 backdrop-blur px-2.5 py-1.5 text-xs shadow-sm transition-colors',
                'hover:bg-accent',
                entry.active && 'border-primary ring-1 ring-primary/40',
              )}
            >
              <Icon className='h-3.5 w-3.5 text-primary shrink-0' />
              <span className={cn('truncate max-w-48', entry.mono && 'font-mono')}>{entry.label}</span>
              <Badge variant='secondary' className='text-[10px]'>
                {entry.hint}
              </Badge>
            </button>
          )
        })}
      </div>
    </div>
  )
}
