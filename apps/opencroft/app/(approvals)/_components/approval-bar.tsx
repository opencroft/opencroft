'use client'

import { Check, Crosshair, ShieldQuestion, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useMemo, useState, useTransition } from 'react'

import '@/app/(approvals)/_components/builtin-views'
import { Button } from 'ui/button'
import { Input } from 'ui/input'
import { resolveApprovalView } from '@/app/(approvals)/_components/approval-views'
import { approveRequest, rejectRequest } from '@/app/(approvals)/_server/actions'
import { useOverlayBar, useOverlayMenu } from '@/app/(dashboard)/_canvas/overlay-context'
import { sseEventsStore } from '@/app/(sse)/_lib/sse-events-store'
import type { PendingApproval } from '@/lib/sse-events'

export function ApprovalBar({ request }: { request: PendingApproval }) {
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const view = resolveApprovalView(request.view)
  const ViewComponent = view.body
  const focusNodeId = view.getNodeId?.(request.args)

  const close = useCallback(() => sseEventsStore.setSelectedApproval(null), [])

  const onApprove = useCallback(() => {
    startTransition(async () => {
      await approveRequest({ data: request.id })
      close()
    })
  }, [request.id, close])

  const onReject = useCallback(
    (withReason: string) => {
      startTransition(async () => {
        await rejectRequest({ data: { id: request.id, reason: withReason } })
        close()
      })
    },
    [request.id, close],
  )

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        onReject(reason.trim())
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    },
    [reason, onReject, close],
  )

  const menuNode = useMemo(
    () => (
      <>
        <div className='flex items-center gap-2 px-3 py-2 border-b'>
          <ShieldQuestion className='h-4 w-4 shrink-0 text-primary' />
          <span className='font-mono text-sm truncate flex-1'>{request.tool}</span>
          {focusNodeId && (
            <Button variant='ghost' size='sm' className='h-7' onClick={() => sseEventsStore.dispatch({ type: 'focus_node', nodeId: focusNodeId, panToNode: true })} title={focusNodeId}>
              <Crosshair /> View node
            </Button>
          )}
        </div>
        <ViewComponent request={request} />
      </>
    ),
    [ViewComponent, request, focusNodeId],
  )

  const barNode = useMemo(
    () => (
      <div className='flex flex-col gap-1.5 w-full'>
        <Button size='sm' onClick={onApprove} disabled={pending} className='justify-start w-full'>
          <Check /> Approve
        </Button>
        <Button size='sm' variant='outline' onClick={() => onReject('')} disabled={pending} className='justify-start w-full'>
          <X /> Reject
        </Button>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={onInputKeyDown} placeholder='Tell what to do different (Enter)' disabled={pending} className='h-8' />
      </div>
    ),
    [reason, pending, onApprove, onReject, onInputKeyDown],
  )

  useOverlayMenu(menuNode)
  useOverlayBar(barNode)

  return null
}
