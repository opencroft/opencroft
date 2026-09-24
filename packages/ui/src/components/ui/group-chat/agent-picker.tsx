'use client'

import { Check, ChevronDown } from 'lucide-react'

import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'
import { cn } from 'ui/lib/utils'

// Three structural fields. Declared here because this is the component that
// renders them, so anything else needing the shape imports it from here rather
// than restating it.
export interface AgentRef {
  nodeId: string
  name: string
  avatarUrl?: string | null
}

export interface AgentPickerProps {
  // MEMBER agents only, wherever membership is a rule: an agent whose
  // selection would be refused should never be offered as a choice.
  agents: AgentRef[]
  // Controlled; null is nothing chosen yet.
  selectedAgentNodeId: string | null
  onSelectAgent: (nodeId: string) => void
  // Locks the choice while something is in flight -- a thread being started
  // must not be re-aimed at another agent halfway through.
  disabled?: boolean
  // Trigger copy until an agent is chosen.
  placeholder?: string
  className?: string
}

// The agent a thread is with, as a compact trigger with a menu behind it.
//
// Sized to a command bar's action row (h-7) rather than to a form field,
// because that is the row it stands in -- it sits in the bar's `leading` slot,
// under the full-width message rather than stealing width from it.
//
// Extracted from the start-thread composer, which used to carry this markup
// inline. A second surface that addresses an agent then had no way to draw the
// same control except by copying it, and a copied control is one that drifts.
export function AgentPicker({
  agents,
  selectedAgentNodeId,
  onSelectAgent,
  disabled,
  placeholder,
  className,
}: AgentPickerProps) {
  const selected = agents.find((a) => a.nodeId === selectedAgentNodeId)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={
          <button
            type='button'
            className={cn(
              'inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              className,
            )}
            title={selected ? `Thread with ${selected.name}` : 'Choose an agent'}
          />
        }
      >
        {selected ? (
          <AgentAvatar avatar={selected.avatarUrl} name={selected.name} size='sm' />
        ) : (
          <span className='size-6' aria-hidden />
        )}
        <span className='max-w-32 truncate'>
          {selected ? selected.name : <span className='text-muted-foreground'>{placeholder ?? 'Select agent'}</span>}
        </span>
        <ChevronDown className='size-3.5 shrink-0 text-muted-foreground' />
      </DropdownMenuTrigger>
      {/* side='top' because the bar this sits in is pinned to the bottom of a
          conversation -- a menu opening downward would open off-screen. */}
      <DropdownMenuContent align='start' side='top' className='min-w-48'>
        {agents.map((agent) => {
          const isSelected = agent.nodeId === selectedAgentNodeId
          return (
            <DropdownMenuItem key={agent.nodeId} onClick={() => onSelectAgent(agent.nodeId)} className='gap-2'>
              <AgentAvatar avatar={agent.avatarUrl} name={agent.name} size='sm' />
              <span className='min-w-0 flex-1 truncate'>{agent.name}</span>
              {isSelected ? <Check className='size-3.5 shrink-0 text-primary' /> : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
