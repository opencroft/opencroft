'use client'

import { type ReactNode } from 'react'
import { Hash } from 'lucide-react'

import { AgentCommandBar } from 'agent-chat/components/ui/composer/agent-command-bar'
import { AgentPicker, type AgentRef } from 'ui/components/ui/group-chat/agent-picker'
import { cn } from 'ui/lib/utils'

// The command bar comes from the agent-chat PACKAGE rather than from a
// registry dependency, because it is not a sibling in this kit: it lives in
// the agent-chat project, which installs into a different package.
//
// Declaring it as a cross-project registry dependency does resolve -- and
// writes a second copy of the bar into this package, a ~580-line fork of the
// composer every chat surface shares, which is the drift the kit exists to
// prevent. A package specifier means one bar, installed once, imported by
// whatever needs it; and the installed file then matches this source
// byte-for-byte, so nothing has to be corrected by hand after an install.

// Re-exported rather than redeclared. The shape belongs to the picker that
// renders it, and two structurally identical declarations of one contract are
// how the two drift apart. The note here used to argue the opposite -- that a
// registry dependency taken on for a type alone drags in a component nothing
// renders -- which stopped being true once the picker became what draws this
// composer's own agent row.
export type { AgentRef }

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
  // readable part of the session key ("Code review" -> code-review). An empty
  // value means an ad-hoc, unnamed thread -- the host already treats a blank
  // title as "no title" when it submits.
  title?: string
  // Reports typing in the title field. Its ABSENCE removes the naming field
  // entirely: this is delegation, not notification -- the composer holds no
  // title of its own, so with nowhere to report one the feature cannot work
  // and must not be offered.
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
  // Host content in the action row's readout cluster -- the run of controls
  // and readouts that follows the leading slot, and where a composer with a
  // session draws its context ring. Named for what a host puts there rather
  // than for the slot it lands in, so the two composers a host wires take the
  // same prop under the same name.
  attachmentControls?: ReactNode
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
//
// `attachmentControls` goes to `configExtra`, the bar's readout slot, and the
// rename is the whole of the mapping. There is no usage readout on this
// composer -- there is no session yet to have spent anything -- so a control
// described by where it sits relative to the ring has no anchor here to be
// positioned against. The bar's own slot IS that anchor's place: a host that
// draws the ring puts it in the same slot, ahead of whatever else goes there.
// So the control lands in the same relative spot on both composers without
// this one deciding a position of its own, which would be a second answer to a
// question the bar already answers.
//
// Straight through rather than merged with anything, because this composer
// passes no `configs` and no readouts -- there is nothing here for a host's
// content to be ordered against.
//
// The name field is standing, not behind a toggle: it costs one row whether or
// not it is filled in, and a person typing a name should not need to find an
// icon first. Leaving it empty is how a thread stays unnamed -- the host
// already treats a blank title as "no title" when it submits.
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
  attachmentControls,
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

  const canName = Boolean(onTitleChange)

  // One control, not a copy of one: the same AgentPicker any other surface
  // that addresses an agent renders. This markup used to live here inline,
  // which is exactly why a second surface could only match it by copying it.
  const picker = (
    <AgentPicker
      agents={agents}
      selectedAgentNodeId={selectedAgentNodeId}
      onSelectAgent={onSelectAgent}
      disabled={submitting}
    />
  )

  return (
    // The title sits ABOVE the command bar rather than inside it: the bar knows
    // nothing about threads, and it should not learn. Conditional in a fixed
    // position, so the bar below keeps its place among the children and its
    // textarea is never remounted -- the same structural rule the bar keeps for
    // its own queued strip and error line.
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1', className)}>
      {canName ? (
        <div className='flex min-w-0 items-center gap-1.5 px-2 pt-0.5'>
          <Hash className='size-3.5 shrink-0 text-muted-foreground' aria-hidden='true' />
          <input
            type='text'
            value={title ?? ''}
            onChange={(event) => onTitleChange?.(event.target.value)}
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
        leading={picker}
        configExtra={attachmentControls}
        sendError={error}
        onDismissSendError={onDismissError}
      />
    </div>
  )
}
