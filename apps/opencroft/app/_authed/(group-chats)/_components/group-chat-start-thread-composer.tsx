'use client'

// The new-thread composer for the detail screen's footer. The kit's
// StartThreadComposer, unreshaped; this owns the request, the pending and error
// state, and the member-agent derivation (app-side because it is a fact about
// this group chat). Sending starts a thread with the first message and
// navigates into it.

import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { StartThreadComposer } from 'ui/group-chat/start-thread-composer'

import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { type MemberRef, startGroupChatThread } from '@/app/_authed/(group-chats)/_server/actions'

interface Props {
  groupChatId: string
  members: MemberRef[]
  onThreadStarted: (threadId: string) => void
}

export function GroupChatStartThreadComposer({ groupChatId, members, onThreadStarted }: Props) {
  const router = useRouter()

  // MEMBER agents only: the server refuses any other, so offering one would be
  // an invitation to a refusal.
  const memberAgents = members
    .filter((m) => m.kind === 'agent')
    .map((m) => ({ nodeId: m.id, name: m.name, avatarUrl: m.avatarUrl }))

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  const submit = async () => {
    if (!selectedAgent || !value.trim()) {
      setError('Choose an agent and write a message.')
      return
    }
    setError(undefined)
    setSubmitting(true)
    try {
      const result = await startGroupChatThread({
        data: { groupChatId, agentNodeId: selectedAgent, firstMessage: value.trim() },
      })
      setValue('')
      setSelectedAgent(null)
      await router.invalidate()
      onThreadStarted(result.thread.id)
    } catch (e) {
      setError(failureMessage(e, 'The thread could not be started.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <StartThreadComposer
      agents={memberAgents}
      selectedAgentNodeId={selectedAgent}
      onSelectAgent={setSelectedAgent}
      value={value}
      onValueChange={(next) => {
        setValue(next)
        if (error) {
          setError(undefined)
        }
      }}
      onSubmit={() => void submit()}
      submitting={submitting}
      error={error}
    />
  )
}
