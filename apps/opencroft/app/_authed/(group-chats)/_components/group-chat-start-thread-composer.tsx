'use client'

// The new-thread composer for the detail screen's footer. The kit's
// StartThreadComposer, unreshaped; this owns the request, the pending and error
// state, and the member-agent derivation (app-side because it is a fact about
// this group chat). Sending starts a thread with the first message and
// navigates into it.

import { useRouter } from '@tanstack/react-router'
import { useRef, useState } from 'react'
import { StartThreadComposer } from 'ui/group-chat/start-thread-composer'

import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { type MemberRef, startGroupChatThread } from '@/app/_authed/(group-chats)/_server/actions'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'

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

  // Remembered per group chat -- who you usually address in one chat says
  // nothing about another. Falls back to the first member whenever the
  // remembered id is unset, or names an agent that isn't (or is no longer) a
  // member here.
  const [rememberedAgent, setRememberedAgent] = useLocalStorage<string | null>(
    `opencroft.groupChat.${groupChatId}.lastAgent`,
    null,
  )
  const selectedAgent =
    rememberedAgent && memberAgents.some((a) => a.nodeId === rememberedAgent)
      ? rememberedAgent
      : (memberAgents[0]?.nodeId ?? null)

  const [value, setValue] = useState('')
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()

  // The composer clears itself (onValueChange('')) BEFORE onSubmit fires --
  // the command bar's clear-on-send contract. `onSubmit` takes no text, so by
  // the time it runs `value` may already read '' -- this mirrors it in a ref,
  // skipping the clear itself, so submit always has the text that was actually
  // typed to send and, on failure, to put back.
  const lastTypedRef = useRef('')

  const submit = async () => {
    const text = lastTypedRef.current
    if (!selectedAgent || !text.trim()) {
      setError('Choose an agent and write a message.')
      return
    }
    setError(undefined)
    setSubmitting(true)
    try {
      const result = await startGroupChatThread({
        data: {
          groupChatId,
          agentNodeId: selectedAgent,
          firstMessage: text.trim(),
          title: title.trim() || undefined,
        },
      })
      if (!result.ok) {
        // Reachable for a named thread whose slug is already taken or
        // unusable. The message field was cleared before submit ran
        // (clear-on-send), so keeping what was typed means putting it back
        // explicitly — same as the thrown-failure path below. The title field
        // is untouched by clear-on-send, so it's already still there to
        // retitle; this just leaves it alone rather than clearing it.
        setValue(text)
        setError(groupChatAccessMessageForCode(result.code))
        return
      }
      setTitle('')
      await router.invalidate()
      onThreadStarted(result.started.thread.id)
    } catch (e) {
      setValue(text)
      setError(failureMessage(e, 'The thread could not be started.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <StartThreadComposer
      agents={memberAgents}
      selectedAgentNodeId={selectedAgent}
      onSelectAgent={setRememberedAgent}
      value={value}
      onValueChange={(next) => {
        if (next !== '') {
          lastTypedRef.current = next
        }
        setValue(next)
        if (error) {
          setError(undefined)
        }
      }}
      title={title}
      onTitleChange={setTitle}
      onSubmit={() => void submit()}
      submitting={submitting}
      error={error}
      onDismissError={() => setError(undefined)}
    />
  )
}
