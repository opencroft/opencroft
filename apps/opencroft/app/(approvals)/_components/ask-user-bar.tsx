'use client'

import { AskUser } from 'agent-chat/ask-user'
import { MessageCircleQuestion } from 'lucide-react'
import { useCallback, useMemo, useState, useTransition } from 'react'
import { answerAskUser, cancelAskUser } from '@/app/(approvals)/_server/actions'
import { useOverlayBar, useOverlayMenu } from '@/app/(dashboard)/_canvas/overlay-context'
import type { PendingAskUser } from '@/lib/sse-events'

export function AskUserBar({ request }: { request: PendingAskUser }) {
  const [pending, startTransition] = useTransition()
  const [current, setCurrent] = useState(0)

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

  const menuNode = useMemo(
    () => <AskUser questions={request.questions} onSubmit={onSubmit} onCancel={onCancel} pending={pending} onCurrentChange={setCurrent} />,
    [request.questions, onSubmit, onCancel, pending],
  )

  const barNode = useMemo(
    () => (
      <div className='flex items-center gap-2 w-full text-xs text-muted-foreground'>
        <MessageCircleQuestion className='h-4 w-4 shrink-0 text-primary' />
        <span>
          Question {current + 1} of {request.questions.length}
        </span>
      </div>
    ),
    [current, request.questions.length],
  )

  useOverlayMenu(menuNode)
  useOverlayBar(barNode)

  return null
}
