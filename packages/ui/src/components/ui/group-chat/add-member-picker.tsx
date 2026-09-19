'use client'

import type { ReactNode } from 'react'
import { useId, useState } from 'react'
import { Search } from 'lucide-react'

import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'
import { Button } from 'ui/components/ui/button'
import { FieldError } from 'ui/components/ui/field'
import { Input } from 'ui/components/ui/input'
import { cn } from 'ui/lib/utils'

// The same MemberRef shape the phase-2 components render, and the same one for
// both kinds: a person and an agent each arrive as {id, name, avatarUrl}, so
// there is nothing to tell them apart by except the word, and they belong in
// one list rather than two.
//
// Declared here rather than imported: a registry dependency taken on for a type
// alone would pull a whole component into an install that never renders it.
export interface MemberCandidate {
  kind: 'user' | 'agent'
  id: string
  name: string
  avatarUrl?: string | null
}

export interface AddMemberPickerProps {
  /** Everyone who could be in the chat -- members included, which is where
   * their names and faces are read from. */
  candidates: MemberCandidate[]
  /** Who is in the chat. Shown as the list while nothing is being searched
   * for; left out of the search results, which are for adding. */
  members?: Array<{ kind: 'user' | 'agent'; id: string }>
  onAdd: (principal: { kind: 'user' | 'agent'; id: string }) => void
  adding?: boolean
  /** When supplied, each member carries a Remove control. Omit for a
   * read-only member list. */
  onRemove?: (principal: { kind: 'user' | 'agent'; id: string }) => void
  removing?: boolean
  /** A whole-picker failure -- a rejected add or remove. Displayed, not decided. */
  error?: string
  /** What stands in for the member list while nobody is in. */
  emptyState?: ReactNode
  className?: string
}

const principalKey = (principal: { kind: string; id: string }) => `${principal.kind}:${principal.id}`

// Who is in a group chat, and adding to it. Any member may add another, so
// this is ordinary member UI and carries no admin framing.
//
// Two states, one field. With nothing typed it is the MEMBER LIST: who is in,
// each removable. Typing turns it into the search that adds: the people and
// agents that match and are not in yet, each addable. The two are never on
// screen together -- the previous shape listed every account and every agent
// under a filter, each with its own Add, and finding out who was actually in
// the chat meant reading the whole directory for the "Added" marks.
//
// People and agents are one list, searched together. Nothing beyond a name and
// an avatar exists for either, so a split would be two lists distinguished by a
// word -- and the reader adding "Sam" should not have to know first which half
// Sam lives in.
export function AddMemberPicker({
  candidates,
  members,
  onAdd,
  adding,
  onRemove,
  removing,
  error,
  emptyState,
  className,
}: AddMemberPickerProps) {
  const filterId = useId()
  const [query, setQuery] = useState('')

  const memberKeys = new Set((members ?? []).map(principalKey))
  const byKey = new Map(candidates.map((candidate) => [principalKey(candidate), candidate]))
  // A member the directory no longer resolves (a deleted account, an agent
  // node that is gone) is still IN the chat and still removable, so it is drawn
  // by its id rather than dropped from the list.
  const current: MemberCandidate[] = (members ?? []).map(
    (member) => byKey.get(principalKey(member)) ?? { ...member, name: member.id, avatarUrl: null },
  )
  const needle = query.trim().toLowerCase()
  const matches = needle
    ? candidates.filter(
        (candidate) => !memberKeys.has(principalKey(candidate)) && candidate.name.toLowerCase().includes(needle),
      )
    : []

  const row = (person: MemberCandidate, control: ReactNode) => (
    <li key={principalKey(person)} className='flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5'>
      {/* One avatar atom for both kinds -- a person's avatar needs nothing an
          agent's does, which is the same reason the member cluster is built
          from this one. */}
      <AgentAvatar avatar={person.avatarUrl} name={person.name} size='sm' />
      <span className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
        <span className='truncate text-sm text-foreground'>{person.name}</span>
        {/* The only thing distinguishing the two kinds. */}
        <span className='truncate text-xs text-muted-foreground'>{person.kind}</span>
      </span>
      {control}
    </li>
  )

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className='relative min-w-0'>
        <Search className='pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground' />
        <Input
          id={filterId}
          type='search'
          value={query}
          aria-label='Search people and agents to add'
          placeholder='Search to add…'
          className='pl-8'
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {needle ? (
        matches.length === 0 ? (
          <p className='px-2 py-4 text-center text-sm text-muted-foreground'>No one matches that.</p>
        ) : (
          <ul className='flex max-h-64 min-w-0 flex-col gap-0.5 overflow-y-auto'>
            {matches.map((candidate) =>
              row(
                candidate,
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='shrink-0'
                  disabled={adding}
                  onClick={() => onAdd({ kind: candidate.kind, id: candidate.id })}
                >
                  Add
                </Button>,
              ),
            )}
          </ul>
        )
      ) : current.length === 0 ? (
        (emptyState ?? <p className='px-2 py-4 text-center text-sm text-muted-foreground'>Nobody is in yet.</p>)
      ) : (
        <div className='flex min-w-0 flex-col gap-1'>
          <p className='px-2 text-xs font-medium text-muted-foreground'>
            {current.length === 1 ? '1 member' : `${current.length} members`}
          </p>
          <ul className='flex max-h-64 min-w-0 flex-col gap-0.5 overflow-y-auto'>
            {current.map((member) =>
              row(
                member,
                onRemove ? (
                  <Button
                    type='button'
                    size='sm'
                    variant='ghost'
                    className='shrink-0 text-muted-foreground'
                    disabled={removing}
                    onClick={() => onRemove({ kind: member.kind, id: member.id })}
                  >
                    Remove
                  </Button>
                ) : null,
              ),
            )}
          </ul>
        </div>
      )}

      <FieldError>{error}</FieldError>
    </div>
  )
}
