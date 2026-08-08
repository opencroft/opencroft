'use client'

import { Hand, MessageSquare } from 'lucide-react'

import type { ChatStatus } from '@/components/ui/chat/chat-list-item'
import { StatusIndicator } from '@/components/ui/utils/status-indicator'
import { cn } from '@/lib/utils'

export interface AgentActivityLineProps {
  // The SAME `ChatStatus` a chat row takes, borrowed rather than re-declared.
  // The kit already carries this union twice (`chat-list-item`, and
  // `agent-session-list` as `SessionState`), and both say the same thing: a
  // third copy is the wrong answer. Importing the type costs this component a
  // registry dependency on a chat row it never renders, which is the cost those
  // notes were weighing -- but every surface that mounts this line is a surface
  // that already installs the row, so here it is paid in name only. If that
  // stops being true, the answer is the shared status module the kit owes
  // itself, still not a third union.
  //
  //   waiting  blocked on an unresolved permission request -- needs a person
  //   working  a turn is actively running
  //   idle     the agent process is alive but not busy
  //   offline  no process
  //
  // Omitted, or `idle`, says nothing. That is what makes this safe to mount in
  // an already-shipped screen: a host with no state to give renders exactly
  // what it rendered before this existed.
  status?: ChatStatus
  // Names the agent in the sentence. Without it the line still reads, as "The
  // agent" -- a screen that knows a turn is running should say so even if the
  // name has not loaded.
  agentName?: string
  className?: string
}

// What an open conversation shows while its agent is busy, pinned between the
// transcript and the composer.
//
// **Pinned, not appended to the transcript.** That is the whole of what this
// adds: a marker at the foot of a scrolling message list is invisible to a
// reader who has scrolled up -- and a reader scrolled up is exactly the reader
// who cannot tell whether their message landed. It also sits where the message
// just went, directly above the composer, rather than in the header where
// nothing else about this turn is.
//
// **It also covers a state a typing indicator cannot.** A turn stalled on a
// permission request is not "in progress", and it is the one state where a
// person is the blocker; anything driven by a turn-is-running flag alone shows
// nothing at all for it.
//
// Only the states that want a person mark themselves, which is the rule
// `agent-session-list` settled and this follows rather than re-deciding:
//
//   working  moving pulse, success   "... is working..."       it IS in progress
//   waiting  static hand, primary    "... is waiting for you"  a person is the blocker
//   offline  static glyph, muted     "... is offline"          you are about to type to it
//   idle     nothing at all
//
// `waiting` is the heavier of the two active states and the one that does not
// move. Both halves are one decision: a pulse reads as *in progress*, and a
// turn stalled on a permission is the opposite of in progress, so motion there
// would describe it wrongly. Motion belongs to the state that is running.
//
// `offline` is stated here though a single-line list would rest it, and the
// difference is the surface: a list answers "which of these wants me", while
// this screen is one you are about to type a paragraph into. Learning the agent
// is not running after writing it is the worse order.
//
// **The wrapper is always rendered, even with nothing to say.** It is the live
// region: a `role='status'` element spliced into the DOM at the moment its text
// appears is announced unreliably or not at all, so the region has to already
// be there when the text arrives. With no content it holds no padding and no
// children, so it costs no height -- but it must not be mounted conditionally
// by the host either, or the same problem returns one level up.
export function AgentActivityLine({ status, agentName, className }: AgentActivityLineProps) {
  const who = agentName?.trim() || 'The agent'

  // A fixed-width marker column, the same one the session list scans: all three
  // appearances differ in SHAPE here before colour is considered.
  const marker =
    status === 'working' ? (
      <StatusIndicator variant='success' />
    ) : status === 'waiting' ? (
      <Hand className='size-3.5 text-primary' aria-hidden='true' />
    ) : status === 'offline' ? (
      <MessageSquare className='size-3.5 text-muted-foreground' aria-hidden='true' />
    ) : null

  // Real text, not a title attribute: it is the channel that survives when none
  // of the visual ones can be perceived, and it is what the live region reads.
  const text =
    status === 'working'
      ? `${who} is working…`
      : status === 'waiting'
        ? `${who} is waiting for you`
        : status === 'offline'
          ? `${who} is offline`
          : null

  return (
    <div
      role='status'
      aria-live='polite'
      className={cn(
        'flex min-w-0 items-center gap-1.5 px-4 text-xs',
        // Vertical padding only when there is something to say, so the resting
        // state costs no height while the element stays in the DOM.
        text ? 'py-1.5' : null,
        className,
      )}
    >
      {text ? (
        <>
          <span className='flex size-3.5 shrink-0 items-center justify-center'>{marker}</span>
          {/* Truncates rather than wraps: this strip sits between a scrolling
              transcript and a pinned composer, and a line that grew to two
              would move the composer under the reader's thumb mid-turn. */}
          <span
            className={cn(
              'min-w-0 flex-1 truncate',
              status === 'waiting' ? 'font-medium text-foreground' : 'text-muted-foreground',
            )}
          >
            {text}
          </span>
        </>
      ) : null}
    </div>
  )
}
