'use client'

import '@/app/(approvals)/_components/builtin-views'
import { AskUser } from 'agent-chat/ask-user'
import { Check, Crosshair, type LucideIcon, MessageCircleQuestion, ShieldQuestion, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useState, useTransition } from 'react'
import { Button } from 'ui/button'
import { Input } from 'ui/input'
import { Flex } from 'ui/layout/flex'
import { ScrollArea } from 'ui/layout/scroll-area'
import { resolveApprovalView } from '@/app/(approvals)/_components/approval-views'
import { answerAskUser, approveRequest, cancelAskUser, listPendingApprovals, listPendingAskUsers, rejectRequest } from '@/app/(approvals)/_server/actions'
import { sseEventsStore, useSSEEvents } from '@/app/(sse)/_lib/sse-events-store'
import type { PendingApproval, PendingAskUser } from '@/lib/sse-events'
import { cn } from '@/lib/utils'

export interface PendingRequestEntry {
  id: string
  label: string
  hint: string
  createdAt: number
  icon: LucideIcon
  mono: boolean
  active: boolean
  select: () => void
}

/** Seed pending approval and ask-user requests from the server (e.g. on canvas mount). */
export function useSeedPendingRequests(spaceId?: string) {
  useEffect(() => {
    listPendingApprovals({ data: spaceId }).then((rows) => {
      sseEventsStore.setPendingApprovals(rows)
    })
    listPendingAskUsers({ data: spaceId }).then((rows) => {
      sseEventsStore.setPendingAskUsers(rows)
    })
  }, [spaceId])
}

/** All pending MCP requests (approvals + ask-users) as uniform display entries, oldest first. */
export function usePendingRequestEntries(): PendingRequestEntry[] {
  const { pendingApprovals, selectedApprovalId, pendingAskUsers, selectedAskUserId } = useSSEEvents()

  return [
    ...Array.from(pendingApprovals.values()).map((request) => ({
      id: request.id,
      label: request.tool,
      hint: 'approval',
      createdAt: request.createdAt,
      icon: ShieldQuestion,
      mono: true,
      // The approval detail takes precedence over the ask-user form.
      active: request.id === selectedApprovalId,
      select: () => sseEventsStore.setSelectedApproval(request.id),
    })),
    ...Array.from(pendingAskUsers.values()).map((request) => ({
      id: request.id,
      label: request.questions.map((q) => q.title).join(', '),
      hint: `${request.questions.length} question${request.questions.length === 1 ? '' : 's'}`,
      createdAt: request.createdAt,
      icon: MessageCircleQuestion,
      mono: false,
      active: !selectedApprovalId && request.id === selectedAskUserId,
      select: () => {
        sseEventsStore.setSelectedApproval(null)
        sseEventsStore.setSelectedAskUser(request.id)
      },
    })),
  ].sort((a, b) => a.createdAt - b.createdAt)
}

function ApprovalDetail({ request }: { request: PendingApproval }) {
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const view = resolveApprovalView(request.view)
  const ViewComponent = view.body
  const focusNodeId = view.getNodeId?.(request.args)

  const onApprove = useCallback(() => {
    startTransition(async () => {
      await approveRequest({ data: request.id })
      sseEventsStore.setSelectedApproval(null)
    })
  }, [request.id])

  const onReject = useCallback(
    (withReason: string) => {
      startTransition(async () => {
        await rejectRequest({ data: { id: request.id, reason: withReason } })
        sseEventsStore.setSelectedApproval(null)
      })
    },
    [request.id],
  )

  const onInputKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        onReject(reason.trim())
      }
    },
    [reason, onReject],
  )

  return (
    <div className='shrink-0 border-t'>
      <div className='flex items-center gap-2 px-3 py-2'>
        <ShieldQuestion className='h-4 w-4 shrink-0 text-primary' />
        <span className='font-mono text-sm truncate flex-1'>{request.tool}</span>
        {focusNodeId && (
          <Button variant='ghost' size='sm' className='h-7' onClick={() => sseEventsStore.dispatch({ type: 'focus_node', nodeId: focusNodeId, panToNode: true })} title={focusNodeId}>
            <Crosshair /> View node
          </Button>
        )}
      </div>
      <div className='max-h-72 overflow-y-auto border-t'>
        <ViewComponent request={request} />
      </div>
      <div className='flex flex-col gap-1.5 px-3 py-2 border-t'>
        <Button size='sm' onClick={onApprove} disabled={pending} className='justify-start w-full'>
          <Check /> Approve
        </Button>
        <Button size='sm' variant='outline' onClick={() => onReject('')} disabled={pending} className='justify-start w-full'>
          <X /> Reject
        </Button>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={onInputKeyDown} placeholder='Tell what to do different (Enter)' disabled={pending} className='h-8' />
      </div>
    </div>
  )
}

function AskUserDetail({ request }: { request: PendingAskUser }) {
  const [pending, startTransition] = useTransition()

  const onSubmit = useCallback(
    (answers: Record<string, string>) => {
      startTransition(async () => {
        await answerAskUser({ data: { id: request.id, answers } })
      })
    },
    [request.id],
  )

  const onCancel = useCallback(() => {
    startTransition(async () => {
      await cancelAskUser({ data: request.id })
    })
  }, [request.id])

  return (
    <div className='shrink-0 border-t max-h-96 overflow-y-auto'>
      <AskUser questions={request.questions} onSubmit={onSubmit} onCancel={onCancel} pending={pending} />
    </div>
  )
}

export function McpRequestList() {
  const { pendingApprovals, selectedApprovalId, pendingAskUsers, selectedAskUserId } = useSSEEvents()
  const entries = usePendingRequestEntries()

  const selectedApproval = selectedApprovalId ? pendingApprovals.get(selectedApprovalId) : undefined
  const selectedAskUser = !selectedApproval && selectedAskUserId ? pendingAskUsers.get(selectedAskUserId) : undefined

  if (entries.length === 0) {
    return (
      <Flex expanded align='center' justify='center' className='p-4'>
        <p className='text-xs text-muted-foreground italic'>No pending MCP requests.</p>
      </Flex>
    )
  }

  return (
    <Flex expanded className='w-full min-h-0'>
      <ScrollArea className='flex-1 min-h-0'>
        <ul className='py-1'>
          {entries.map((entry) => {
            const Icon = entry.icon
            return (
              <li key={entry.id}>
                <button
                  type='button'
                  onClick={entry.select}
                  className={cn('w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-accent/50 transition-colors rounded-sm', entry.active && 'bg-accent/50')}
                >
                  <Icon className='size-4 shrink-0 text-primary' />
                  <span className={cn('truncate flex-1', entry.mono && 'font-mono text-xs')}>{entry.label}</span>
                  <span className='text-[10px] text-muted-foreground shrink-0'>{entry.hint}</span>
                </button>
              </li>
            )
          })}
        </ul>
      </ScrollArea>
      {selectedApproval && <ApprovalDetail key={selectedApproval.id} request={selectedApproval} />}
      {selectedAskUser && <AskUserDetail key={selectedAskUser.id} request={selectedAskUser} />}
    </Flex>
  )
}
