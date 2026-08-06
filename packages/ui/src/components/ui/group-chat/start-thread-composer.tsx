'use client'

import type { ReactNode } from 'react'
import { Check, ChevronDown, Send } from 'lucide-react'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

// Declared here rather than imported from the thread list: it is three
// structural fields, and a registry dependency taken on for a type alone would
// pull a whole component into an install that does not render one.
export interface AgentRef {
  nodeId: string
  name: string
  avatarUrl?: string | null
}

export interface StartThreadComposerProps {
  // MEMBER agents only. An agent that is not a member is refused, so offering
  // one would be offering a choice that cannot succeed.
  agents: AgentRef[]
  selectedAgentNodeId: string | null
  onSelectAgent: (nodeId: string) => void
  // The first message, which is also the thread's opening turn. Controlled.
  value: string
  onValueChange: (value: string) => void
  // Reports that the user asked to start the thread. Validates nothing.
  onSubmit: () => void
  submitting?: boolean
  // A failure shown under the row. Displayed, not decided.
  error?: string
  placeholder?: string
  // Shown when the group chat has no agent members yet.
  emptyState?: ReactNode
  className?: string
}

// A thread starts with a first message, so starting one is a composer pinned
// under the thread list -- where the new thread is about to land -- rather than
// a button that opens a form in a dialog. An agent and the message are one
// step: there is no empty thread to create first, the way there is no empty
// chat to open and then fill.
//
// The agent is chosen from a dropdown of member agents (avatar + name, the
// chosen one checked), the textarea grows with what is typed, and Enter starts
// the thread while Shift+Enter moves to a new line.
export function StartThreadComposer({
  agents,
  selectedAgentNodeId,
  onSelectAgent,
  value,
  onValueChange,
  onSubmit,
  submitting,
  error,
  placeholder,
  emptyState,
  className,
}: StartThreadComposerProps) {
  // A group chat with no agent members cannot have a thread started in it.
  // Saying so is the design -- a composer with an empty picker would look
  // broken rather than finished.
  if (agents.length === 0) {
    return (
      <div className={className}>
        {emptyState ?? (
          <p className='px-2 py-3 text-center text-sm text-muted-foreground'>
            Add an agent to this group chat to start a thread.
          </p>
        )}
      </div>
    )
  }

  const selected = agents.find((a) => a.nodeId === selectedAgentNodeId)
  const inert = submitting

  return (
    <form
      method='post'
      className={cn('flex flex-col gap-1.5', className)}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <div className='flex items-end gap-2'>
        {/* The agent picker. A dropdown rather than a radio column, because a
            composer is one row and the list of member agents is not the thing
            the writer's attention is on. */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type='button'
              disabled={inert}
              className='inline-flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1.5 text-sm text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
            >
              {selected ? (
                <AgentAvatar avatar={selected.avatarUrl} name={selected.name} size='sm' />
              ) : (
                <span className='size-6' aria-hidden />
              )}
              <span className='max-w-40 truncate'>
                {selected ? selected.name : <span className='text-muted-foreground'>Select agent</span>}
              </span>
              <ChevronDown className='size-3.5 shrink-0 text-muted-foreground' />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='start' className='min-w-48'>
            {agents.map((agent) => {
              const isSelected = agent.nodeId === selectedAgentNodeId
              return (
                <DropdownMenuItem key={agent.nodeId} onSelect={() => onSelectAgent(agent.nodeId)} className='gap-2'>
                  <AgentAvatar avatar={agent.avatarUrl} name={agent.name} size='sm' />
                  <span className='min-w-0 flex-1 truncate'>{agent.name}</span>
                  {isSelected ? <Check className='size-3.5 shrink-0 text-primary' /> : null}
                </DropdownMenuItem>
              )
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <Textarea
          value={value}
          disabled={inert}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              onSubmit()
            }
          }}
          placeholder={placeholder ?? 'Message…'}
          aria-invalid={error ? true : undefined}
          rows={1}
          className='min-h-9 min-w-0 flex-1 resize-none'
        />

        <Button type='submit' size='icon' disabled={inert} className='shrink-0'>
          <Send className='size-4' />
          <span className='sr-only'>Start thread</span>
        </Button>
      </div>
      {error ? <p className='px-1 text-xs text-destructive'>{error}</p> : null}
    </form>
  )
}
