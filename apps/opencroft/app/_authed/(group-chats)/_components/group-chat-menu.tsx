'use client'

// The group chat's menu -- the header control to the right of the pin toggle,
// where the avatar cluster used to stand. It opens the chat's members: who is
// in, each removable, and a search that adds -- the kit picker's two states.
// Below them, the automated senders, which are grants rather than people.
//
// This owns the requests, the pending and error state, and the candidate
// derivation -- app-side because it is a fact about this group chat rather than
// a shape decision.

import { EllipsisVertical } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { AddMemberPicker, type MemberCandidate } from 'ui/group-chat/add-member-picker'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/popover'

import { failureMessage } from '@/app/_authed/(group-chats)/_lib/failure-message'
import { useGroupChatRefresh } from '@/app/_authed/(group-chats)/_lib/group-chat-refresh'
import { memberActionRefusal } from '@/app/_authed/(group-chats)/_lib/member-action-refusal'
import type { DirectoryUser, GroupChatWriteResult, MemberRef } from '@/app/_authed/(group-chats)/_server/actions'
import {
  addGroupChatMember,
  listGroupChatMembers,
  listSystemSenders,
  removeGroupChatMember,
} from '@/app/_authed/(group-chats)/_server/actions'
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

export function GroupChatMenu({ groupChatId, members, directory, agents }: Props) {
  const refresh = useGroupChatRefresh()

  // Both principal kinds in one list, which is what the picker takes: the
  // picker reads each member's name and face from here, and searches here for
  // whoever is not in yet.
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

  // System senders — the per-chat grants that authorize automated pipelines
  // (a schedule's script, the forge webhook) to deliver into this chat's
  // threads. App-side composition rather than a third kind in the kit picker:
  // these are not people to browse for, they are a short list of reserved
  // identifiers. Fetched on open because the loader's MemberRef view carries
  // only user and agent members.
  const [systemGrants, setSystemGrants] = useState<string[]>([])
  const [systemSenders, setSystemSenders] = useState<string[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies(pending): not read in the body — a grant/revoke settling (pending true→false) is what re-fetches the list it just changed
  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    void Promise.all([listGroupChatMembers({ data: groupChatId }), listSystemSenders()])
      .then(([rows, senders]) => {
        if (!cancelled) {
          setSystemGrants(rows.flatMap((r) => (r.principalType === 'system' && r.systemId ? [r.systemId] : [])))
          setSystemSenders(senders)
        }
      })
      .catch(() => {
        if (!cancelled) {
          // A list that failed to load and a chat with no grants render
          // identically, and the difference is the whole point of the panel.
          setSystemGrants([])
          setSystemSenders([])
          setError('Could not load this chat’s automated senders.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, groupChatId, pending])

  const ungrantedSenders = useMemo(
    () => systemSenders.filter((id) => !systemGrants.includes(id)),
    [systemSenders, systemGrants],
  )

  // One pending flag for both, because the picker disables the whole list off
  // it. A refusal (the last user member, a removed principal, ...) comes back
  // as DATA — `{ ok: false, code }` — and is shown in the server's own words;
  // `catch` is for genuine faults, which still throw.
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
      // Stay open: managing several people in a row is the common case, and
      // the list re-draws once the data refreshes.
      await refresh()
    } catch (e) {
      setError(failureMessage(e, fallback))
    } finally {
      setPending(false)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setError(undefined)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='icon-sm'
          aria-label={`Chat menu — members (${members.length})`}
          title='Members'
        >
          <EllipsisVertical />
        </Button>
      </PopoverTrigger>
      {/* The same dress the space selector's and the chat selector's menus
          wear: a Command with its search on a divider and flat rows, no inset
          of this menu's own. */}
      <PopoverContent side='bottom' align='end' className='w-72 p-0'>
        <div className='flex flex-col'>
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
          {systemGrants.length > 0 || ungrantedSenders.length > 0 ? (
            <div className='space-y-2 border-t p-3'>
              <p className='text-xs text-muted-foreground'>
                Automated senders — a grant lets a scheduled pipeline or webhook deliver into this chat's threads.
              </p>
              {systemGrants.map((systemId) => (
                <div key={systemId} className='flex items-center justify-between gap-2 text-sm'>
                  <span className='font-mono text-xs'>{systemId}</span>
                  <Button
                    variant='ghost'
                    size='sm'
                    disabled={pending}
                    onClick={() =>
                      void run(
                        () => removeGroupChatMember({ data: { groupChatId, principal: { kind: 'system', systemId } } }),
                        'That grant could not be revoked.',
                      )
                    }
                  >
                    Revoke
                  </Button>
                </div>
              ))}
              {/* Offered, not typed: these identifiers are a closed set the
                  server derives from the same map that stamps them, so what
                  can be granted here is exactly what can send. */}
              {ungrantedSenders.length > 0 ? (
                <div className='flex flex-wrap items-center gap-2'>
                  {ungrantedSenders.map((systemId) => (
                    <Button
                      key={systemId}
                      variant='outline'
                      size='sm'
                      disabled={pending}
                      onClick={() =>
                        void run(
                          () => addGroupChatMember({ data: { groupChatId, principal: { kind: 'system', systemId } } }),
                          'That sender could not be granted.',
                        )
                      }
                    >
                      Grant <span className='font-mono text-xs'>{systemId}</span>
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
