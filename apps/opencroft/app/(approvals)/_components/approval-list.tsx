'use client'

import { ShieldQuestion } from 'lucide-react'
import { useEffect } from 'react'

import { listPendingApprovals } from '@/app/(approvals)/_server/actions'
import { sseEventsStore, useSSEEvents } from '@/app/(sse)/_lib/sse-events-store'
import { Badge } from '@opencroft/ui-kit/badge'
import { cn } from '@/lib/utils'

export function ApprovalList({ spaceId }: { spaceId?: string }) {
  const { pendingApprovals, selectedApprovalId } = useSSEEvents()

  useEffect(() => {
    listPendingApprovals({ data: spaceId }).then((rows) => {
      sseEventsStore.setPendingApprovals(rows)
    })
  }, [spaceId])

  const requests = Array.from(pendingApprovals.values())
  if (!requests.length) {
    return null
  }

  return (
    <div className='pointer-events-none absolute right-0 bottom-0 z-10 p-3'>
      <div className='pointer-events-auto flex flex-col items-end gap-1.5'>
        {requests.map((request) => {
          const active = request.id === selectedApprovalId
          return (
            <button
              key={request.id}
              type='button'
              onClick={() => sseEventsStore.setSelectedApproval(request.id)}
              className={cn(
                'flex items-center gap-2 rounded-md border bg-background/95 backdrop-blur px-2.5 py-1.5 text-xs shadow-sm transition-colors',
                'hover:bg-accent',
                active && 'border-primary ring-1 ring-primary/40',
              )}
            >
              <ShieldQuestion className='h-3.5 w-3.5 text-primary shrink-0' />
              <span className='font-mono truncate max-w-48'>{request.tool}</span>
              <Badge variant='secondary' className='text-[10px]'>
                approve
              </Badge>
            </button>
          )
        })}
      </div>
    </div>
  )
}
