'use client'

import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, Hash } from 'lucide-react'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import { AgentCommandBar, commandBarControlClass } from '@/components/ui/agent-chat/agent-command-bar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
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
  //
  // NOTE the clear-on-send contract inherited from the command bar:
  // `onValueChange('')` fires BEFORE `onSubmit`, so the composer is empty the
  // instant the message is handed over, and a host whose start can fail is the
  // one that puts the text back. See agent-command-bar for why that trade is
  // made that way round.
  value: string
  onValueChange: (value: string) => void
  // An optional NAME for the thread, which the server slugifies into the
  // readable part of the session key ("Code review" -> code-review). Most
  // threads are ad-hoc and want none, so the field is revealed rather than
  // standing -- see the affordance below.
  title?: string
  // Reports typing in the title field. Its ABSENCE removes the naming
  // affordance entirely: this is delegation, not notification -- the composer
  // holds no title of its own, so with nowhere to report one the feature
  // cannot work and must not be offered.
  onTitleChange?: (value: string) => void
  // Reports that the user asked to start the thread. Validates nothing.
  onSubmit: () => void
  submitting?: boolean
  // A failure shown above the composer. Displayed, not decided -- including a
  // refused title (one already taken, or one that slugifies to nothing).
  error?: string
  // Clears `error`. Without it no dismiss control is offered -- the composer
  // does not own the message, so it cannot clear what it did not set.
  onDismissError?: () => void
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
// **It IS the agent command bar, not something that resembles one.** This used
// to be its own row -- bordered textarea, filled send button, picker beside it
// -- and it looked nothing like the composer directly below it in a 1:1 chat,
// which made the mismatch obvious. Rebuilding it on the command bar
// rather than restyling it to match means there is no second definition of what
// a composer looks like, so the two cannot drift again.
//
// Two of the command bar's own switches carry the difference:
//   startIcon={false}  -- the sparkles open a session picker, and there is no
//                         session yet to pick.
//   approval={false}   -- nothing has been asked for approval; a shield here
//                         would describe a setting this press cannot be about.
// The agent picker goes in `leading`, the command bar's slot at the start of
// the action row, so it sits under the full-width message rather than stealing
// width from it.
export function StartThreadComposer({
  agents,
  selectedAgentNodeId,
  onSelectAgent,
  value,
  onValueChange,
  title,
  onTitleChange,
  onSubmit,
  submitting,
  error,
  onDismissError,
  placeholder,
  emptyState,
  className,
}: StartThreadComposerProps) {
  // Whether the naming field has been ASKED for. Purely local: it is never
  // published anywhere, so there is no callback echo to recognise. The field is
  // also shown whenever a title already exists, so a host that arrives with one
  // does not hide it behind a press.
  const [naming, setNaming] = useState(false)

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
  const canName = Boolean(onTitleChange)
  const showTitle = canName && (naming || Boolean(title))

  // Closing the field CLEARS the title, and that is deliberate rather than
  // tidy-minded: a name that still shapes the session key while its field is
  // hidden is a thread named by something the person can no longer see. The
  // only safe way to put the field away is to mean it.
  const toggleNaming = () => {
    if (showTitle) {
      setNaming(false)
      if (title) onTitleChange?.('')
      return
    }
    setNaming(true)
  }

  // Sized to the action row's own controls (h-7) rather than to a form field,
  // because that is the row it is standing in.
  const picker = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type='button'
          disabled={submitting}
          className='inline-flex h-7 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50'
          title={selected ? `Thread with ${selected.name}` : 'Choose an agent'}
        >
          {selected ? (
            <AgentAvatar avatar={selected.avatarUrl} name={selected.name} size='sm' />
          ) : (
            <span className='size-6' aria-hidden />
          )}
          <span className='max-w-32 truncate'>
            {selected ? selected.name : <span className='text-muted-foreground'>Select agent</span>}
          </span>
          <ChevronDown className='size-3.5 shrink-0 text-muted-foreground' />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' side='top' className='min-w-48'>
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
  )

  // An icon in the action row, not a standing field. A field always on the
  // screen makes naming look expected, and people then invent titles for
  // threads that did not want one -- which is the opposite of "most threads are
  // ad-hoc". As an affordance it costs one icon and the one-step flow survives.
  //
  // A real button rather than a hover-reveal, and it carries the row's own
  // control metric, so it lines up with the send and the settings rather than
  // being sized by hand.
  const nameToggle = canName ? (
    <button
      type='button'
      onMouseDown={(e) => e.preventDefault()}
      onClick={toggleNaming}
      aria-pressed={showTitle}
      title={showTitle ? 'Remove the thread name' : 'Name this thread (optional)'}
      aria-label={showTitle ? 'Remove the thread name' : 'Name this thread (optional)'}
      className={cn(
        commandBarControlClass,
        'inline-flex items-center justify-center rounded-md outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        showTitle ? 'text-primary' : 'text-muted-foreground',
      )}
    >
      <Hash className='size-4' />
    </button>
  ) : null

  return (
    // The title sits ABOVE the command bar rather than inside it: the bar knows
    // nothing about threads, and it should not learn. Conditional in a fixed
    // position, so the bar below keeps its place among the children and its
    // textarea is never remounted -- the same structural rule the bar keeps for
    // its own queued strip and error line.
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}>
      {showTitle ? (
        <div className='flex min-w-0 items-center gap-1.5 px-2 pt-0.5'>
          <Hash className='size-3.5 shrink-0 text-muted-foreground' aria-hidden='true' />
          <input
            type='text'
            value={title ?? ''}
            onChange={(event) => onTitleChange?.(event.target.value)}
            // Focused only when the field was just asked for. A host that
            // arrives with a title already set shows the field, and stealing
            // focus into it on page load would be the field interrupting rather
            // than answering.
            autoFocus={naming}
            placeholder='Name this thread (optional)'
            aria-label='Thread name (optional)'
            className='min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground'
          />
        </div>
      ) : null}

      <AgentCommandBar
        value={value}
        onValueChange={onValueChange}
        // The command bar hands over the trimmed text; this component's contract
        // is a bare report, and the host already holds the value it published.
        onSend={() => onSubmit()}
        placeholder={placeholder ?? 'Message…'}
        sending={submitting}
        startIcon={false}
        approval={false}
        leading={
          <>
            {picker}
            {nameToggle}
          </>
        }
        sendError={error}
        onDismissSendError={onDismissError}
      />
    </div>
  )
}
