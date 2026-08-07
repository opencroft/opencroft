'use client'

// Who is taking part, and managing it — from the detail screen's `membersSlot`.
//
// The header's avatar cluster IS the control: pressing it opens one dialog that
// both adds and removes, which is the kit's shape (its picker shows Remove in
// place of Added once `onRemove` is supplied) and replaces the separate "Add
// member" button the header used to carry.
//
// This owns the requests, the pending and error state, and the candidate
// derivation -- app-side because it is a fact about this group chat rather than
// a shape decision.

import { useRouter } from '@tanstack/react-router'
import { useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from 'ui/dialog'
import { AddMemberPicker, type MemberCandidate } from 'ui/group-chat/add-member-picker'
import { MemberAvatarGroup } from 'ui/group-chat/member-avatar-group'

import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { memberActionRefusal } from '@/app/_authed/(group-chats)/_lib/member-action-refusal'
import type { DirectoryUser, GroupChatWriteResult, MemberRef } from '@/app/_authed/(group-chats)/_server/actions'
import { addGroupChatMember, removeGroupChatMember } from '@/app/_authed/(group-chats)/_server/actions'
import type { AgentNodeRef } from '@/app/_authed/(space)/_server/agents'

interface Props {
  groupChatId: string
  members: MemberRef[]
  /** Every account, from the narrow directory read. */
  directory: DirectoryUser[]
  /** Every agent node in the graph. */
  agents: AgentNodeRef[]
}

function toPrincipal(principal: { kind: 'user' | 'agent'; id: string }) {
  return principal.kind === 'user'
    ? ({ kind: 'user', userId: principal.id } as const)
    : ({ kind: 'agent', agentNodeId: principal.id } as const)
}

export function GroupChatMembersDialog({ groupChatId, members, directory, agents }: Props) {
  const router = useRouter()

  // Both principal kinds in one list, which is what the picker takes -- the
  // designer's note that splitting them makes the reader work out which half
  // someone is in before they can look. Already-added principals are passed
  // through `members` so the picker marks them, rather than being filtered
  // out here: a name vanishing is a worse answer to "did I already add Sam"
  // than seeing it marked, and it is now also what the Remove control hangs
  // off, so filtering them out would remove the only way to take one away.
  const candidates = useMemo<MemberCandidate[]>(
    () => [
      ...directory.map((u) => ({ kind: 'user' as const, id: u.id, name: u.name, avatarUrl: u.avatarUrl })),
      ...agents.map((a) => ({ kind: 'agent' as const, id: a.nodeId, name: a.name, avatarUrl: a.avatar ?? null })),
    ],
    [directory, agents],
  )

  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()

  // One pending flag for both, because the picker disables the whole list off
  // it: a second request while one is in flight would race the router
  // invalidation and could act on a membership list that has already moved.
  //
  // A refusal (the last user member, a removed principal, ...) comes back as
  // DATA — `{ ok: false, code }` — not as a throw. A thrown server-function
  // error reaches the browser as `$TSR/Error` carrying only `message`, so the
  // dialog previously could never recognise which refusal it was and always
  // fell through to `fallback`. `memberActionRefusal` turns the code into the
  // same mapped copy every other refusal surface shows. `catch` below still
  // exists for genuine faults, which still throw.
  const run = async (action: () => Promise<GroupChatWriteResult>, fallback: string) => {
    setError(undefined)
    setPending(true)
    try {
      const result = await action()
      const refusal = memberActionRefusal(result)
      if (refusal) {
        setError(refusal)
        return
      }
      // Stay open: managing several people in a row is the common case, and the
      // picker re-marks each one once the loader data refreshes.
      await router.invalidate()
    } catch (e) {
      setError(failureMessage(e, fallback))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setError(undefined)
        }
      }}
    >
      <DialogTrigger asChild>
        {/* The cluster is the trigger, so it needs to be a real button: it is
            reachable by keyboard, and it says what it does rather than leaving
            a screen reader with a row of avatars and no affordance. */}
        <button
          type='button'
          aria-label={`Members (${members.length}) — add or remove`}
          className='shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring'
        >
          <MemberAvatarGroup members={members} max={6} size='md' />
        </button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Members</DialogTitle>
        </DialogHeader>
        <AddMemberPicker
          candidates={candidates}
          members={members.map((m) => ({ kind: m.kind, id: m.id }))}
          onAdd={(principal) =>
            void run(
              () => addGroupChatMember({ data: { groupChatId, principal: toPrincipal(principal) } }),
              'That member could not be added.',
            )
          }
          adding={pending}
          onRemove={(principal) =>
            void run(
              () => removeGroupChatMember({ data: { groupChatId, principal: toPrincipal(principal) } }),
              'That member could not be removed.',
            )
          }
          removing={pending}
          error={error}
        />
      </DialogContent>
    </Dialog>
  )
}
