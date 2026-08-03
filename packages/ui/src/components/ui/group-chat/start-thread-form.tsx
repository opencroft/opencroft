'use client'

import type { ReactNode } from 'react'
import { useId } from 'react'
import { Check } from 'lucide-react'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import { Button } from '@/components/ui/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
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

export interface StartThreadFormProps {
  // MEMBER agents only. An agent that is not a member is refused, so offering
  // one would be offering a choice that cannot succeed.
  agents: AgentRef[]
  selectedAgentNodeId: string | null
  onSelectAgent: (nodeId: string) => void
  firstMessage: string
  onFirstMessageChange: (value: string) => void
  // Reports that the user asked to start the thread. Validates nothing.
  onSubmit: () => void
  submitting?: boolean
  // A whole-form failure. Displayed, not decided.
  error?: string
  // Shown when the group chat has no agent members yet.
  emptyState?: ReactNode
  className?: string
}

// Starting a thread is one step, not two: an agent and the first message
// together. There is no empty thread to create and fill in afterwards, so a
// two-step flow would describe something that cannot exist.
//
// The agent is chosen from real radio inputs inside their labels, so keyboard
// and assistive technology get the grouping for free rather than through
// hand-rolled key handling.
export function StartThreadForm({
  agents,
  selectedAgentNodeId,
  onSelectAgent,
  firstMessage,
  onFirstMessageChange,
  onSubmit,
  submitting,
  error,
  emptyState,
  className,
}: StartThreadFormProps) {
  // Generated rather than fixed: a docs page renders this form several times
  // over, and a shared radio name would make every copy one group.
  const groupName = useId()
  const messageId = useId()

  // A group chat with no agent members cannot have a thread started in it.
  // Saying so is the design -- a form with an empty picker would look broken.
  if (agents.length === 0) {
    return (
      <div className={className}>
        {emptyState ?? (
          <p className='px-2 py-6 text-center text-sm text-muted-foreground'>
            No agent members yet. Add an agent to this group chat to start a thread.
          </p>
        )}
      </div>
    )
  }

  return (
    <form
      className={className}
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <FieldGroup>
        <fieldset className='min-w-0' disabled={submitting}>
          <legend className='mb-2 text-sm font-medium text-foreground'>Agent</legend>
          <div className='flex min-w-0 flex-col gap-1'>
            {agents.map((agent) => {
              const selected = agent.nodeId === selectedAgentNodeId
              return (
                <label
                  key={agent.nodeId}
                  className={cn(
                    'flex min-w-0 cursor-pointer items-center gap-2 rounded-md border px-2 py-2 text-sm transition-colors',
                    selected ? 'border-primary bg-muted' : 'border-border hover:bg-muted',
                  )}
                >
                  <input
                    type='radio'
                    name={groupName}
                    value={agent.nodeId}
                    checked={selected}
                    onChange={() => onSelectAgent(agent.nodeId)}
                    className='sr-only'
                  />
                  <AgentAvatar avatar={agent.avatarUrl} name={agent.name} size='sm' />
                  <span className='min-w-0 flex-1 truncate text-foreground'>{agent.name}</span>
                  {selected ? <Check className='size-4 shrink-0 text-primary' /> : null}
                </label>
              )
            })}
          </div>
        </fieldset>

        <Field>
          <FieldLabel htmlFor={messageId}>First message</FieldLabel>
          <Textarea
            id={messageId}
            name='firstMessage'
            rows={3}
            value={firstMessage}
            disabled={submitting}
            placeholder='What should this thread be about?'
            aria-invalid={error ? true : undefined}
            onChange={(event) => onFirstMessageChange(event.target.value)}
          />
        </Field>

        {/* Renders nothing at all when there is no message, so it can stay
            mounted rather than being conditionally spliced into the group. */}
        <FieldError>{error}</FieldError>

        <Field>
          {/* Inert only while a start is in flight. Whether an agent must be
              chosen, or the message be non-empty, is the host's rule, reported
              back through `error`. */}
          <Button type='submit' disabled={submitting}>
            {submitting ? 'Starting…' : 'Start thread'}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}
