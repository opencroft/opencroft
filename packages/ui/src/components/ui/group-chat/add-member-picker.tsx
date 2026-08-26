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
  candidates: MemberCandidate[]
  // Who is already in the chat. Those candidates are shown as added rather
  // than dropped -- see the note in the source below.
  members?: Array<{ kind: 'user' | 'agent'; id: string }>
  onAdd: (principal: { kind: 'user' | 'agent'; id: string }) => void
  adding?: boolean
  // When supplied, current members get a Remove control instead of the passive
  // "Added" label, so the same list manages both adding and removing. Omit to
  // keep the read-only "Added" state.
  onRemove?: (principal: { kind: 'user' | 'agent'; id: string }) => void
  removing?: boolean
  // A whole-picker failure -- a rejected add. Displayed, not decided.
  error?: string
  emptyState?: ReactNode
  className?: string
}

const principalKey = (principal: { kind: string; id: string }) => `${principal.kind}:${principal.id}`

// Adds a member to a group chat. Any member may add another, so this is
// ordinary member UI and carries no admin framing.
//
// People and agents are one list, searched together. Nothing beyond a name and
// an avatar exists for either, so a split would be two lists distinguished by a
// word -- and the reader adding "Sam" should not have to know first which half
// Sam lives in.
//
// The filter is owned here rather than lifted to the host: it is pure view
// state with no meaning outside this list, and keeping it inside leaves the
// host's prop surface exactly the data it actually has.
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

  const alreadyMembers = new Set((members ?? []).map(principalKey))
  const needle = query.trim().toLowerCase()
  const matches = needle
    ? candidates.filter((candidate) => candidate.name.toLowerCase().includes(needle))
    : candidates

  return (
    <div className={cn('flex min-w-0 flex-col gap-3', className)}>
      <div className='relative min-w-0'>
        <Search className='pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground' />
        <Input
          id={filterId}
          type='search'
          value={query}
          aria-label='Filter people and agents'
          placeholder='Search by name'
          className='pl-8'
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>

      {candidates.length === 0 ? (
        emptyState ?? (
          <p className='px-2 py-6 text-center text-sm text-muted-foreground'>No one left to add.</p>
        )
      ) : matches.length === 0 ? (
        <p className='px-2 py-6 text-center text-sm text-muted-foreground'>No one matches that.</p>
      ) : (
        <ul className='flex min-w-0 flex-col gap-1'>
          {matches.map((candidate) => {
            // Shown as added, not filtered out. A list that silently omits
            // someone leaves the reader unable to tell "already in" from
            // "missing", and they would go looking for the difference.
            const added = alreadyMembers.has(principalKey(candidate))
            return (
              <li
                key={principalKey(candidate)}
                className='flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5'
              >
                {/* One avatar atom for both kinds -- a person's avatar needs
                    nothing an agent's does, which is the same reason the member
                    cluster is built from this one. */}
                <AgentAvatar avatar={candidate.avatarUrl} name={candidate.name} size='sm' />
                <span className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
                  <span className='truncate text-sm text-foreground'>{candidate.name}</span>
                  {/* The only thing distinguishing the two kinds, and the same
                      word the detail header uses beside each member's name. */}
                  <span className='truncate text-xs text-muted-foreground'>{candidate.kind}</span>
                </span>
                {added ? (
                  onRemove ? (
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='shrink-0'
                      disabled={removing}
                      onClick={() => onRemove({ kind: candidate.kind, id: candidate.id })}
                    >
                      Remove
                    </Button>
                  ) : (
                    <span className='shrink-0 text-xs text-muted-foreground'>Added</span>
                  )
                ) : (
                  <Button
                    type='button'
                    size='sm'
                    variant='outline'
                    className='shrink-0'
                    disabled={adding}
                    onClick={() => onAdd({ kind: candidate.kind, id: candidate.id })}
                  >
                    Add
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <FieldError>{error}</FieldError>
    </div>
  )
}
