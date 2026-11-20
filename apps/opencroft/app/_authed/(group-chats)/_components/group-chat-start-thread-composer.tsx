'use client'

// The new-thread composer: the kit's StartThreadComposer, unreshaped; this
// owns the request, the pending state, the refusal toasts and the member-agent
// derivation (app-side because it is a fact about the group chat).
//
// ONE COMPOSER FOR BOTH START SURFACES. The group-chat screen's footer and
// the embedded chat's "new chat" state differ only in configuration, so they
// share this component rather than each keeping a copy of the submit flow:
// the embed fixes the thread's title (its threads are named by id, so the
// title field disappears) and shares its agent selection with the live
// thread's own picker through the controlled props.

import { COMPOSER_PLACEHOLDER, useChatComposer } from 'agent-chat/chat-composer'
import { cn } from 'cn'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { StartThreadComposer } from 'ui/group-chat/start-thread-composer'

import { oversizedTextNotice } from '@/app/_authed/(agent)/_shared/message-size'
import { SelectionBadge } from '@/app/_authed/(extension-runtime)/_client/selection-badge'
import { useOptionalSelection } from '@/app/_authed/(extension-runtime)/_client/selection-context'
import { SelectionToggle } from '@/app/_authed/(extension-runtime)/_client/selection-toggle'
import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { groupChatAccessMessageForCode } from '@/app/_authed/(group-chats)/_lib/group-chat-error'
import { mentionCandidates } from '@/app/_authed/(group-chats)/_lib/mention-candidates'
import { holdOpeningMessage } from '@/app/_authed/(group-chats)/_lib/opening-messages'
import { type MemberRef, startGroupChatThread } from '@/app/_authed/(group-chats)/_server/actions'
import { useLocalStorage } from '@/hooks/utils/use-local-storage'

// Hoisted so the element identity is stable across renders: it takes no props
// -- it reads the selection scope itself -- so a fresh element every render
// would say the subtree changed on every keystroke in the composer above it,
// when nothing about it has. The same element lets React leave it alone.
const SELECTION_TOGGLE = <SelectionToggle />

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
  const mentions = useMemo(() => mentionCandidates(members), [members])

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

  // The text to put back, and a revision bumped on every put-back: the
  // composer loads text only on a new revision, so what was typed stays where
  // it is while the reader types.
  const [value, setValue] = useState('')
  const [valueRevision, setValueRevision] = useState(0)
  const putBack = (text: string) => {
    setValue(text)
    setValueRevision((revision) => revision + 1)
  }
  const [title, setTitle] = useState('')
  const [submitting, setSubmitting] = useState(false)
  // A start refused before any thread exists has no conversation to be told
  // in, and the composer carries no error text: it is a toast. Once the
  // thread exists, its own conversation tells whatever goes wrong next.
  useEffect(() => {
    if (loadError) {
      toast.error(loadError)
    }
  }, [loadError])

  // The selection rides on the FIRST message too. It is handed to the thread's
  // chat beside the text (opening-messages.ts) and attached there by the
  // thread's own send, the one place a message gets its selection block. Null
  // outside a selection scope (the screen of a chat that is no space's has
  // none), which makes this a no-op there.
  const selectionScope = useOptionalSelection()

  // The text comes from the composer's send, trimmed, and EMPTY when the
  // thread is being started without a message at all. The composer has
  // already cleared itself by the time this runs (clear-on-send).
  const submit = async (text: string) => {
    if (!selectedAgent) {
      putBack(text)
      toast.error('Choose an agent to start a thread with.')
      return
    }
    // Checked here as the thread's own composer checks it, so the refusal
    // names the size before anything goes to the server.
    const oversized = oversizedTextNotice(text)
    if (oversized) {
      putBack(text)
      toast.error(oversized)
      return
    }
    setSubmitting(true)
    try {
      // The selection quoted at this press, when passing is on. An empty start
      // carries none: there is no message for it to ride on.
      const selection =
        text && selectionScope?.selection && selectionScope.passEnabled ? selectionScope.selection.content : undefined
      const result = await startGroupChatThread({
        data: {
          groupChatId,
          agentNodeId: selectedAgent,
          firstMessage: text,
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
        putBack(text)
        toast.error(groupChatAccessMessageForCode(result.code))
        return
      }
      setTitle('')
      // The thread's own chat sends it once its session is up, and shows the
      // start while it happens.
      holdOpeningMessage(result.thread.id, { text, ...(selection ? { selection } : {}) })
      onThreadStarted(result.thread.id)
    } catch (e) {
      putBack(text)
      toast.error(failureMessage(e, 'The thread could not be created.'))
    } finally {
      setSubmitting(false)
    }
  }

  const composer = useChatComposer({
    value,
    valueRevision,
    // The words live in the composer between put-backs; nothing here reads
    // them as they are typed.
    onValueChange: () => {},
    onSend: (text) => void submit(text),
    placeholder: placeholder ?? COMPOSER_PLACEHOLDER,
    sending: submitting,
    mentions,
  })

  return (
    // The wrapper mirrors the kit composer's own root (min-w-0 flex-1 column)
    // so it takes the composer's place inside a CommandBarFrame without
    // changing the width the composer would have had on its own.
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}>
      {/* Inside the frame, above the bar — the same place the live composer
          shows its selection through the command bar's attachments slot. Null
          outside a selection scope (the group-chat screen).

          The condition here is only half of it, and deliberately so: the
          quotation is also held back while the toggle below is off, and that
          half belongs to the quotation rather than to this line. Repeating it
          here would put the rule in two places and let them disagree. */}
      {selectionScope?.selection ? <SelectionBadge /> : null}
      <StartThreadComposer
        agents={memberAgents}
        selectedAgentNodeId={selectedAgent}
        onSelectAgent={onSelectAgent ?? setRememberedAgent}
        composer={composer}
        // No onTitleChange, no title field — see fixedTitle above.
        title={fixedTitle === undefined ? title : undefined}
        onTitleChange={fixedTitle === undefined ? setTitle : undefined}
        // Offered on BOTH start surfaces, and not behind a prop: each of them
        // is a screen for starting a new chat, and the reason to start one
        // empty -- reaching the agent's settings, which only exist once its
        // session does -- is the same on either. A switch no caller would ever
        // turn off is a choice nobody makes.
        allowEmptyStart
        submitting={submitting}
        // Offered wherever there is a scope to keep the answer in, selected or
        // not: it is the only way back from held-back, and the reader may
        // settle it before selecting anything. Tying it to the quotation's own
        // condition would hide the control that undoes the hiding. Absent
        // outside a selection scope, where there would be nowhere to put it.
        attachmentControls={selectionScope ? SELECTION_TOGGLE : undefined}
      />
    </div>
  )
}
