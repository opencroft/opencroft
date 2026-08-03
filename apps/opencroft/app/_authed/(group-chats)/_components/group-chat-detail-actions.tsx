'use client'

// Add-member and start-thread, from the detail screen's `actions` slot.
//
// Both are the kit's forms, unreshaped. This owns the requests, the pending
// and error state, and the candidate derivation — which is app-side because it
// is a fact about this group chat rather than a shape decision.

import { useRouter } from '@tanstack/react-router'
import { MessageSquarePlus, UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from 'ui/dialog'
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from 'ui/empty'
import { AddMemberPicker, type MemberCandidate } from 'ui/group-chat/add-member-picker'
import { StartThreadForm } from 'ui/group-chat/start-thread-form'

import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import type { DirectoryUser, MemberRef } from '@/app/_authed/(group-chats)/_server/actions'
import { addGroupChatMember, startGroupChatThread } from '@/app/_authed/(group-chats)/_server/actions'
import type { AgentNodeRef } from '@/app/_authed/(space)/_server/agents'

interface Props {
  groupChatId: string
  members: MemberRef[]
  /** Every account, from the narrow directory read. */
  directory: DirectoryUser[]
  /** Every agent node in the graph. */
  agents: AgentNodeRef[]
  onThreadStarted: (threadId: string) => void
}

export function GroupChatDetailActions({ groupChatId, members, directory, agents, onThreadStarted }: Props) {
  const router = useRouter()

  // Both principal kinds in one list, which is what the picker takes — the
  // designer's note that splitting them makes the reader work out which half
  // someone is in before they can look. Already-added principals are passed
  // through `members` so the picker marks them, rather than being filtered
  // out here: a name vanishing is a worse answer to "did I already add Sam"
  // than seeing it marked Added.
  const candidates = useMemo<MemberCandidate[]>(
    () => [
      ...directory.map((u) => ({ kind: 'user' as const, id: u.id, name: u.name, avatarUrl: u.avatarUrl })),
      ...agents.map((a) => ({ kind: 'agent' as const, id: a.nodeId, name: a.name, avatarUrl: a.avatar ?? null })),
    ],
    [directory, agents],
  )

  // Starting a thread offers ONLY member agents: the server refuses any other,
  // so offering one would be an invitation to a refusal.
  const memberAgents = useMemo(
    () =>
      members.filter((m) => m.kind === 'agent').map((m) => ({ nodeId: m.id, name: m.name, avatarUrl: m.avatarUrl })),
    [members],
  )

  const [addOpen, setAddOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string>()

  const add = async (principal: { kind: 'user' | 'agent'; id: string }) => {
    setAddError(undefined)
    setAdding(true)
    try {
      await addGroupChatMember({
        data: {
          groupChatId,
          principal:
            principal.kind === 'user'
              ? { kind: 'user', userId: principal.id }
              : { kind: 'agent', agentNodeId: principal.id },
        },
      })
      // Stay open: adding several people in a row is the common case, and the
      // picker marks each as Added once the loader data refreshes.
      await router.invalidate()
    } catch (e) {
      setAddError(failureMessage(e, 'That member could not be added.'))
    } finally {
      setAdding(false)
    }
  }

  const [threadOpen, setThreadOpen] = useState(false)
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [firstMessage, setFirstMessage] = useState('')
  const [starting, setStarting] = useState(false)
  const [threadError, setThreadError] = useState<string>()

  const startThread = async () => {
    if (!selectedAgent || !firstMessage.trim()) {
      setThreadError('Choose an agent and write a first message.')
      return
    }
    setThreadError(undefined)
    setStarting(true)
    try {
      const result = await startGroupChatThread({
        data: { groupChatId, agentNodeId: selectedAgent, firstMessage: firstMessage.trim() },
      })
      setThreadOpen(false)
      setFirstMessage('')
      setSelectedAgent(null)
      await router.invalidate()
      onThreadStarted(result.thread.id)
    } catch (e) {
      setThreadError(failureMessage(e, 'The thread could not be started.'))
    } finally {
      setStarting(false)
    }
  }

  return (
    <>
      <Dialog
        open={addOpen}
        onOpenChange={(next) => {
          setAddOpen(next)
          if (!next) {
            setAddError(undefined)
          }
        }}
      >
        <DialogTrigger asChild>
          <Button size='sm' variant='outline'>
            <UserPlus className='size-3.5' />
            Add member
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a member</DialogTitle>
          </DialogHeader>
          <AddMemberPicker
            candidates={candidates}
            members={members.map((m) => ({ kind: m.kind, id: m.id }))}
            onAdd={(principal) => void add(principal)}
            adding={adding}
            error={addError}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={threadOpen}
        onOpenChange={(next) => {
          setThreadOpen(next)
          if (!next) {
            setThreadError(undefined)
          }
        }}
      >
        <DialogTrigger asChild>
          <Button size='sm'>
            <MessageSquarePlus className='size-3.5' />
            Start thread
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Start a thread</DialogTitle>
          </DialogHeader>
          <StartThreadForm
            agents={memberAgents}
            selectedAgentNodeId={selectedAgent}
            onSelectAgent={setSelectedAgent}
            firstMessage={firstMessage}
            onFirstMessageChange={(value) => {
              setFirstMessage(value)
              if (threadError) {
                setThreadError(undefined)
              }
            }}
            onSubmit={() => void startThread()}
            submitting={starting}
            error={threadError}
            emptyState={
              <Empty className='py-6'>
                <EmptyHeader>
                  <EmptyTitle>No agents in this group chat yet</EmptyTitle>
                  <EmptyDescription>Add an agent as a member first — a thread is a session with one.</EmptyDescription>
                </EmptyHeader>
              </Empty>
            }
          />
        </DialogContent>
      </Dialog>
    </>
  )
}
