'use client'

import type { ReactNode } from 'react'
import { useState } from 'react'
import { Plus, X } from 'lucide-react'

import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'
import { Button } from 'ui/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from 'ui/components/ui/command'
import { FieldError } from 'ui/components/ui/field'
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

// Who is in a group chat, and adding to it. Any member may add another, so
// this is ordinary member UI and carries no admin framing.
//
// The kit's Command, as the space selector and the chat selector wear it: the
// search on a divider, flat rows beneath. Two states, one field. With nothing
// typed the rows are the MEMBER LIST: who is in, each with an X when the host
// allows removing. Typing turns the rows into the search that adds: the people
// and agents that match and are not in yet, chosen by press or Enter. The two
// are never on screen together -- the previous shape listed every account and
// every agent under a filter, each with its own Add, and finding out who was
// actually in the chat meant reading the whole directory for the marks.
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
  const [query, setQuery] = useState('')
  const principalKey = (principal: { kind: string; id: string }) => `${principal.kind}:${principal.id}`

  const memberKeys = (members ?? []).map(principalKey)
  // A member the directory no longer resolves (a deleted account, an agent
  // node that is gone) is still IN the chat and still removable, so it is drawn
  // by its id rather than dropped from the list.
  const current: MemberCandidate[] = (members ?? []).map(
    (member) =>
      candidates.find((candidate) => principalKey(candidate) === principalKey(member)) ?? {
        ...member,
        name: member.id,
        avatarUrl: null,
      },
  )
  const needle = query.trim().toLowerCase()
  const matches = needle
    ? candidates.filter(
        (candidate) =>
          !memberKeys.includes(principalKey(candidate)) && candidate.name.toLowerCase().includes(needle),
      )
    : []

  const person = (entry: MemberCandidate) => (
    <>
      {/* One avatar atom for both kinds -- a person's avatar needs nothing an
          agent's does, which is the same reason the member cluster is built
          from this one. */}
      <AgentAvatar avatar={entry.avatarUrl} name={entry.name} size='sm' />
      <span className='min-w-0 flex-1 truncate'>{entry.name}</span>
      {/* The only thing distinguishing the two kinds. */}
      <span className='text-xs text-muted-foreground'>{entry.kind}</span>
    </>
  )

  return (
    // Filtering stays this component's own (the query decides which of the
    // two lists is drawn, and against whom), hence shouldFilter off.
    <Command shouldFilter={false} className={cn('bg-transparent', className)}>
      <CommandInput value={query} onValueChange={setQuery} placeholder='Search to add…' />
      <CommandList>
        {needle ? (
          matches.length === 0 ? (
            <CommandEmpty>No one matches that.</CommandEmpty>
          ) : (
            <CommandGroup heading='Add'>
              {matches.map((candidate) => (
                <CommandItem
                  key={principalKey(candidate)}
                  value={principalKey(candidate)}
                  disabled={adding}
                  onSelect={() => onAdd({ kind: candidate.kind, id: candidate.id })}
                >
                  {person(candidate)}
                  <Plus className='text-muted-foreground' />
                </CommandItem>
              ))}
            </CommandGroup>
          )
        ) : current.length === 0 ? (
          <CommandEmpty>{emptyState ?? 'Nobody is in yet.'}</CommandEmpty>
        ) : (
          <CommandGroup heading={current.length === 1 ? '1 member' : `${current.length} members`}>
            {current.map((member) => (
              <CommandItem key={principalKey(member)} value={principalKey(member)} onSelect={() => {}}>
                {person(member)}
                {onRemove ? (
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon-xs'
                    aria-label={`Remove ${member.name}`}
                    disabled={removing}
                    onClick={(event) => {
                      event.stopPropagation()
                      onRemove({ kind: member.kind, id: member.id })
                    }}
                  >
                    <X />
                  </Button>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
      {error ? <FieldError className='px-3 pb-2'>{error}</FieldError> : null}
    </Command>
  )
}
