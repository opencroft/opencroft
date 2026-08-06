'use client'

// Add-member, from the detail screen's `actions` slot.
//
// The kit's form, unreshaped. This owns the request, the pending and error
// state, and the candidate derivation -- which is app-side because it is a fact
// about this group chat rather than a shape decision. Starting a thread moved
// to the footer composer (group-chat-start-thread-composer.tsx).

import { useRouter } from '@tanstack/react-router'
import { UserPlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from 'ui/dialog'
import { AddMemberPicker, type MemberCandidate } from 'ui/group-chat/add-member-picker'

import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import type { DirectoryUser, MemberRef } from '@/app/_authed/(group-chats)/_server/actions'
import { addGroupChatMember } from '@/app/_authed/(group-chats)/_server/actions'
import type { AgentNodeRef } from '@/app/_authed/(space)/_server/agents'

interface Props {
  groupChatId: string
  members: MemberRef[]
  /** Every account, from the narrow directory read. */
  directory: DirectoryUser[]
  /** Every agent node in the graph. */
  agents: AgentNodeRef[]
}

export function GroupChatDetailActions({ groupChatId, members, directory, agents }: Props) {
  const router = useRouter()

  // Both principal kinds in one list, which is what the picker takes -- the
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

  return (
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
  )
}
