'use client'

// The new-thread composer: the kit's StartThreadComposer, unreshaped; this
// owns the request, the pending and error state, and the member-agent
// derivation (app-side because it is a fact about the group chat).
//
// ONE COMPOSER FOR BOTH START SURFACES. The group-chat screen's footer and
// the embedded chat's "new chat" state differ only in configuration, so they
// share this component rather than each keeping a copy of the submit flow:
// the embed fixes the thread's title (its threads are named by id, so the
// title field disappears) and shares its agent selection with the live
// thread's own picker through the controlled props.

import { useRef, useState } from 'react'
import { StartThreadComposer } from 'ui/group-chat/start-thread-composer'

import { wrapUserSelection } from '@/app/_authed/(agent)/_shared/message-envelope'
import { SelectionBadge } from '@/app/_authed/(extension-runtime)/_client/selection-badge'
import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { type MemberRef, startGroupChatThread } from '@/app/_authed/(group-chats)/_server/actions'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'
import { cn } from '@/lib/utils'

interface Props {
  groupChatId: string
  members: MemberRef[]
  /** The thread exists now — the host decides what follows (navigate, reload). */
  onThreadStarted: (threadId: string) => void
  /**
   * Fix the new thread's title and hide the title field. The embedded surface
   * names threads by its id, so there is nothing for a person to type.
   */
  fixedTitle?: string
  /**
   * Controlled agent selection, for a host that shares it with another
   * control (the embed's live-thread picker switches the SAME selection).
   * Omit both to let the composer remember the agent per group chat itself.
   */
  selectedAgentNodeId?: string | null
  onSelectAgent?: (nodeId: string) => void
  /** Shown as the initial error — e.g. the thread lookup that led here failed. */
  loadError?: string
  placeholder?: string
  className?: string
}

export function GroupChatStartThreadComposer({
  groupChatId,
  members,
  onThreadStarted,
  fixedTitle,
  selectedAgentNodeId,
  onSelectAgent,
  loadError,
  placeholder,
  className,
}: Props) {
  // MEMBER agents only: the server refuses any other, so offering one would be
  // an invitation to a refusal.
  const memberAgents = members
    .filter((m) => m.kind === 'agent')
    .map((m) => ({ nodeId: m.id, name: m.name, avatarUrl: m.avatarUrl }))

  // Remembered per group chat -- who you usually address in one chat says
  // nothing about another. Falls back to the first member whenever the
  // remembered id is unset, or names an agent that isn't (or is no longer) a
  // member here. A host passing the controlled props overrides this whole
  // derivation (the hook still runs — hook order cannot depend on props).
  const [rememberedAgent, setRememberedAgent] = useLocalStorage<string | null>(
    `opencroft.groupChat.${groupChatId}.lastAgent`,
    null,
  )
  const derivedAgent =
    rememberedAgent && memberAgents.some((a) => a.nodeId === rememberedAgent)
      ? rememberedAgent
      : (memberAgents[0]?.nodeId ?? null)
  const selectedAgent = selectedAgentNodeId !== undefined ? selectedAgentNodeId : derivedAgent

  const [value, setValue] = useState('')
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>(loadError)

  // The selection rides on the FIRST message too — it is a send like any
  // other, only routed through startThread. Null outside a selection scope
  // (the group-chat screen has none), which makes this a no-op there.
  const selectionScope = useOptionalSelection()

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
      const firstMessage =
        selectionScope?.selection && selectionScope.passEnabled
          ? wrapUserSelection(text.trim(), selectionScope.selection.content)
          : text.trim()
      const result = await startGroupChatThread({
        data: {
          groupChatId,
          agentNodeId: selectedAgent,
          firstMessage,
          title: fixedTitle ?? (title.trim() || undefined),
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
      onThreadStarted(result.started.thread.id)
    } catch (e) {
      setValue(text)
      setError(failureMessage(e, 'The thread could not be started.'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    // The wrapper mirrors the kit composer's own root (min-w-0 flex-1 column)
    // so it takes the composer's place inside a CommandBarFrame without
    // changing the width the composer would have had on its own.
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}>
      {/* Inside the frame, above the bar — the same place the live composer
          shows its selection through the command bar's attachments slot, and
          the same condition: a badge only when something is selected. Null
          outside a selection scope (the group-chat screen). */}
      {selectionScope?.selection ? <SelectionBadge /> : null}
      <StartThreadComposer
        agents={memberAgents}
        selectedAgentNodeId={selectedAgent}
        onSelectAgent={onSelectAgent ?? setRememberedAgent}
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
        // No onTitleChange, no title field — see fixedTitle above.
        title={fixedTitle === undefined ? title : undefined}
        onTitleChange={fixedTitle === undefined ? setTitle : undefined}
        onSubmit={() => void submit()}
        submitting={submitting}
        error={error}
        onDismissError={() => setError(undefined)}
        placeholder={placeholder}
      />
    </div>
  )
}
