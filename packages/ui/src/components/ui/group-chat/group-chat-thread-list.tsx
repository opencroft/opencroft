'use client'

import { type ChatContextUsage, ChatListItem, type ChatStatus } from 'ui/components/ui/chat/chat-list-item'
import { cn } from 'cn'

export interface AgentRef {
  nodeId: string
  name: string
  avatarUrl?: string | null
}

export interface GroupChatThreadListItem {
  id: string
  title: string | null
  agent: AgentRef
  // No longer displayed -- the second line carries the agent's live state
  // instead. Kept on the contract because every host already supplies it and it
  // is the list's natural ordering key; removing it would be churn with nothing
  // on the other side of it.
  createdAt: Date
  // True when the thread's agent is no longer a member of the group chat. The
  // row stays (the conversation is still readable) but reads as inactive, and
  // acting on it is gated by the host. Set by the host from membership.
  disabled?: boolean
  // What the thread's agent is doing right now. Same values, same meanings and
  // the same type as an ordinary chat row -- a thread IS a session, so it gets
  // the session vocabulary rather than one of its own:
  //
  //   waiting  blocked on a person -- a permission to grant or a question to
  //            answer
  //   working  a turn is actively running
  //   queued   no turn, but messages are held for one
  //   idle     the agent process is alive and has nothing to do
  //   offline  no process
  //
  // Domain truth: this list has nothing to derive it from and never guesses.
  // Where several could apply the host resolves it, waiting > working > queued
  // > idle > offline. `offline` is a real state that is shown, not the absence
  // of one -- absence is `undefined`, which shows nothing.
  status?: ChatStatus
  // How much context the thread's session holds, forwarded to ChatListItem's
  // own reading unchanged.
  context?: ChatContextUsage
  // Unsent composer text exists for this thread. Forwarded to ChatListItem's
  // own pencil indicator unchanged -- this list has no draft storage of its
  // own, the host does.
  hasDraft?: boolean
}

export interface GroupChatThreadListProps {
  threads: GroupChatThreadListItem[]
  activeId?: string
  onSelect?: (id: string) => void
  /** Per-row rename. Forwards to ChatListItem's context-menu Rename -- same
     icon, same wording, same position as an ordinary chat row's.

     The kit does not edit the title in place: it reports which row was asked
     for, and the host opens whatever it uses to collect a new one. Renaming may
     be refused (a name already in use, a name a host cannot build an id from),
     and a row that edited itself would have to unwind an edit the reader had
     already seen take effect. */
  onRename?: (id: string) => void
  /** Per-row "stop the agent process". Forwards to ChatListItem's own
     context-menu item -- same icon, same wording, same position as an ordinary
     chat row's; the host decides what stopping means.

     Called with the THREAD id, which is not the session key the host acts on.
     That is deliberate: the kit does not know session keys, and the host
     already holds the thread -> session mapping. Map before acting. */
  onStopProcess?: (id: string) => void
  /** Per-row archive, forwarded to ChatListItem's context-menu Archive, right
     before Delete. Offered on a removed-agent row too, the same reasoning
     onStopProcess above gives: archiving is a property of the thread, not of
     the membership. */
  onArchive?: (id: string) => void
  /** Per-row unarchive, forwarded the same way. A host offers this or
     `onArchive`, never both -- see ChatListItem. */
  onUnarchive?: (id: string) => void
  /** Per-row delete. Forwards to ChatListItem's context-menu Delete; the host
     decides whether to confirm before acting (the kit does not). */
  onDelete?: (id: string) => void
  className?: string
}

// The threads inside one group chat. A thread is a session with exactly one
// agent, so a row is agent-shaped — which is why the existing ChatListItem fits
// and is reused rather than duplicated.
//
// **The second line is the agent and what it is doing.** ChatListItem already
// owns that composition: give it a `description` and a `status` and it renders
// "Carol · Working", with the matching dot on the avatar. So this forwards the
// state and passes the bare agent name, and the row reads exactly like the
// sidebar's row for the same session -- which is the point. A thread list and a
// chat list answer the same question about the same kind of thing, and the two
// surfaces agreeing is worth more than either one being separately clever.
//
// **The creation date is gone.** It was only ever there because no activity
// existed to show: a bare timestamp would have read as activity (GroupChat's
// own updatedAt is not bumped by thread activity), so it was labelled "created"
// to stop it lying. Now that the real thing is available the label has nothing
// to do, and there is no room to keep both -- ChatListItem composes exactly
// `description · statusWord`, with no third segment, and the line truncates.
export function GroupChatThreadList({
  threads,
  activeId,
  onSelect,
  onRename,
  onStopProcess,
  onArchive,
  onUnarchive,
  onDelete,
  className,
}: GroupChatThreadListProps) {
  return (
    <div className={cn('flex w-full min-w-0 flex-col gap-0.5', className)}>
      {threads.map((t) => (
        <ChatListItem
          key={t.id}
          id={t.id}
          title={t.title ?? 'Untitled'}
          description={t.disabled ? `${t.agent.name} · agent removed` : t.agent.name}
          // A removed agent's thread is never given a state, whatever its
          // session is doing. The row is dimmed already, sending is blocked
          // regardless of what a dot would say, and "agent removed" is the fact
          // that governs what the reader can do next -- a second state beside
          // it would only make the row argue with itself.
          status={t.disabled ? undefined : t.status}
          context={t.disabled ? undefined : t.context}
          hasDraft={t.hasDraft}
          avatarUrl={t.agent.avatarUrl}
          active={t.id === activeId}
          disabled={t.disabled}
          onSelect={onSelect}
          // Offered on a removed-agent row for the same reason Stop is: the
          // thread stays readable after its agent leaves, and what it is called
          // is a property of the thread rather than of the membership.
          onRename={onRename}
          // Offered on a removed-agent row too, unlike `status` just above --
          // the two are not the same kind of thing. A state describes the
          // thread, and a dimmed row already carries the one fact worth
          // reading; stopping acts on the *process*, which can still be running
          // after its agent left the chat. Withholding it here would make the
          // one row where a stray process is most likely the only row that
          // cannot stop one. A host for which stopping is meaningless withholds
          // the handler and the item never appears.
          onStopProcess={onStopProcess}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
