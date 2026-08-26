'use client'

import type { ReactNode } from 'react'
import { ChevronLeft, Pencil } from 'lucide-react'

import { CommandBarFrame } from 'ui/components/ui/agent-chat/command-bar-frame'
import { MemberAvatarGroup, type MemberRef } from 'ui/components/ui/group-chat/member-avatar-group'
import { StickySection } from 'ui/components/ui/layouts/sticky-section'
import { cn } from 'ui/lib/utils'

export interface GroupChatDetailProps {
  /** Back out of this group chat -- to the group-chat list. Omit on a surface
   * that has no "out" (there is none today, but the header should not assume
   * one exists). Same affordance as GroupChatThreadFraming's, one level up. */
  onBack?: () => void
  /** What this chat is called. The title, and what every other surface shows.
   * Renaming is pure presentation -- it reaches no agent. */
  name: string
  /** What this chat is for. A secondary muted line beneath the name, and the
   * statement of purpose agents are given as context -- which is why it is
   * editable separately from the name and why the two are not the same field.
   * Empty, or identical to the name, and the line is not printed; see below. */
  topic: string
  /** When given, the name carries an edit affordance. The host owns whatever it
   * opens -- same split as the members dialog and the delete confirm, and what
   * lets this match the 1:1 chat's rename dialog without the kit knowing that
   * dialog exists. */
  onEditName?: () => void
  /** The same for the topic. Note that this is also the ONLY way the topic can
   * be reached while it still echoes the name, since that line is not printed
   * -- see the comment on the topic line below. */
  onEditTopic?: () => void
  members: MemberRef[]
  /** Replaces the read-only avatar cluster with a host-supplied control --
   * typically the cluster made interactive, so tapping it opens member
   * management (add / remove). Omit to render the cluster read-only. */
  membersSlot?: ReactNode
  /** Standing notes pinned to this chat, rendered between the header and the
   * threads. A slot rather than data, because what is pinned is its own
   * component with its own affordances -- see group-chat-pins. */
  pins?: ReactNode
  /** The thread list (or any content) for this group chat. Omit/leave null to
   * show `emptyState` instead -- the group chat itself holds no messages, so a
   * chat with no threads yet is an empty state, not a blank. */
  threads?: ReactNode
  emptyState?: ReactNode
  /** Header affordances -- adding a member. Any member may add another, so
   * these are ordinary member controls, not admin ones. Starting a thread is
   * the composer below, not a header button: a thread begins with a first
   * message, and a form opened in a dialog would put that message somewhere
   * other than where the thread is about to land. */
  actions?: ReactNode
  /** Pinned beneath the threads -- the new-thread composer. It stays put while
   * the thread list scrolls above it, the way a chat composer stays put while
   * the conversation scrolls.
   *
   * Framed in the SAME CommandBarFrame the 1:1 chat's command bar sits in --
   * not a card of this screen's own. This screen used to draw its own, with a
   * panel's inset, and it read as a different kind of surface from the composer
   * one screen away. */
  composer?: ReactNode
  className?: string
}

// One line of the header, in its two forms: a button when the host can edit it,
// plain text when it cannot. Both carry the same padding so the text lands on
// the same left edge either way -- the -ml pulls that padding back out, so the
// press target is wider than the text without the text moving.
function HeaderLine({
  onEdit,
  label,
  className,
  iconClassName,
  children,
}: {
  onEdit?: () => void
  label: string
  className?: string
  iconClassName?: string
  children: ReactNode
}) {
  const box = '-ml-1.5 flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 py-0.5'

  if (!onEdit) {
    return <span className={cn(box, className)}>
      <span className='min-w-0 truncate'>{children}</span>
    </span>
  }

  return (
    // A real, always-visible pencil rather than a hover-reveal: a reveal that
    // needs a cursor does not exist on a touch device, where this header is at
    // its most cramped. The whole line is the press target, so the pencil marks
    // the affordance without being the thing you have to hit.
    <button
      type='button'
      onClick={onEdit}
      aria-label={label}
      className={cn(
        box,
        'text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      <span className='min-w-0 truncate'>{children}</span>
      <Pencil className={cn('size-3.5 shrink-0 text-muted-foreground', iconClassName)} aria-hidden='true' />
    </button>
  )
}

// The view inside one group chat. Name and topic header, the participants
// taking part (users and agents together, shown as participants -- never as an
// access list), and a slot for the thread list. The group chat itself holds no
// messages, so there is nothing else on this screen; that emptiness is part of
// the design and worth seeing. No locks, no "members only" copy -- the member
// list is who is taking part, not who is permitted.
export function GroupChatDetail({
  onBack,
  name,
  topic,
  onEditName,
  onEditTopic,
  members,
  membersSlot,
  pins,
  threads,
  emptyState,
  actions,
  composer,
  className,
}: GroupChatDetailProps) {
  // Every chat starts with its topic seeded from its name, so on this screen
  // the honest default is two identical strings -- and printing a string twice
  // reads as a rendering fault, not as a chat whose purpose is its name. So the
  // echo is not printed. What replaces it is a prompt rather than nothing,
  // because the topic is the one field here that is invisible to the person
  // setting it and visible to every agent in the chat: hiding the line without
  // leaving a way in would make the topic unreachable exactly while it is still
  // untouched, which is when it most needs saying.
  const trimmedTopic = topic.trim()
  const topicEchoesName = trimmedTopic.length === 0 || trimmedTopic === name.trim()

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* px-4 is the chat surface's horizontal rhythm, shared by the header,
          the thread area and the composer below -- the 1:1 conversation uses
          the same, so a group chat and a 1:1 chat line up on one left edge
          rather than each having its own. */}
      <header className='flex shrink-0 flex-col gap-3 border-b border-border px-4 py-3'>
        <div className='flex min-w-0 items-center gap-3'>
          {onBack ? (
            <button
              type='button'
              onClick={onBack}
              aria-label='Back'
              className='inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring'
            >
              <ChevronLeft className='size-4' />
            </button>
          ) : null}
          <div className='flex min-w-0 flex-1 flex-col items-start'>
            <h2 className='flex min-w-0 max-w-full text-base font-semibold text-foreground'>
              <HeaderLine onEdit={onEditName} label={`Rename group chat: ${name}`}>
                {name}
              </HeaderLine>
            </h2>
            {topicEchoesName ? (
              onEditTopic ? (
                <HeaderLine
                  onEdit={onEditTopic}
                  label='Add a topic'
                  className='text-xs text-muted-foreground'
                >
                  Add a topic
                </HeaderLine>
              ) : null
            ) : (
              <HeaderLine
                onEdit={onEditTopic}
                label={`Edit topic: ${trimmedTopic}`}
                className='text-xs text-muted-foreground'
              >
                {topic}
              </HeaderLine>
            )}
          </div>
          {/* The avatar cluster is the single handle for who is taking part:
              the participants at a glance, and -- when the host makes it
              interactive -- the entry point for adding and removing members.
              The host owns that interaction (it needs the directory and the
              add/remove actions), so it can replace this with a clickable
              cluster through `membersSlot`; left plain it is read-only. The
              full member list lives behind it rather than as a row of names, so
              the header is one line at any width. */}
          {membersSlot ?? <MemberAvatarGroup members={members} max={6} size='md' />}
          {/* Kept out of the scroll region and never allowed to shrink: past
              the cluster, the name and topic give up their space first, because
              a truncated name is still readable and a squeezed control is not. */}
          {actions ? <div className='flex shrink-0 items-center gap-1'>{actions}</div> : null}
        </div>
      </header>
      {/* Above the scroll region, not in it: pins are standing context for the
          whole chat, and standing context that scrolls away with the threads
          stops standing. It is also why the panel collapses itself rather than
          growing -- see group-chat-pins. */}
      {pins ? <div className='shrink-0 border-b border-border px-4 py-2'>{pins}</div> : null}
      <div className='min-h-0 flex-1 overflow-y-auto'>
        {/* A full-height flex column INSIDE the scroll region, and the reason
            the composer below sits on the bottom edge rather than under the
            last row. `position: sticky` never moves a box below its own static
            position, so with a short thread list and nothing spending the
            leftover space the composer renders directly beneath the list --
            floating mid-pane, in a pane that is itself full height.
            `min-h-full` makes this wrapper at least the scrollport's height
            (and taller as the list grows), and the `flex-1` below spends what
            is left over.

            The thread screen fixes the same thing the same way -- see
            group-chat-thread-framing, which forces its scroll viewport into
            exactly this shape. That one needs a selector to reach a wrapper it
            does not own; this screen scrolls a plain div, so it can say it
            directly. Top-anchored here and bottom-anchored there, which is the
            one deliberate difference: a list reads from its first row down, a
            conversation from its last message up. */}
        <div className='flex min-h-full flex-col'>
          {/* The padding sits on this inner wrapper, not on the scroll
              container: that way the scrollbar rides the pane's edge while the
              content keeps its margin, which is how the 1:1 conversation is
              built (its content column carries px-4 py-4 inside the scroll
              area, not on it). */}
          <div className='flex-1 px-4 py-4'>
            {threads ??
              emptyState ?? (
                <p className='py-6 text-center text-sm text-muted-foreground'>No threads yet.</p>
              )}
          </div>
          {/* Inside the scroll region, not below it -- a sticky dock so the
              composer overlays the thread list as it scrolls, the same shape
              the 1:1 chat's ChatBar and the thread screen's own footer use
              (see group-chat-thread-framing, including the same reasoning for
              one `--flex-padding` inset layer rather than two -- this screen
              runs full pane width with no centering cap, and the halved value
              is the nearest preset step, not a new constant). A layout block
              here, reserving its own row beneath the list, was the bug this
              replaces. */}
          {composer ? (
            <StickySection side='bottom' fade>
              <CommandBarFrame>{composer}</CommandBarFrame>
            </StickySection>
          ) : null}
        </div>
      </div>
    </div>
  )
}
