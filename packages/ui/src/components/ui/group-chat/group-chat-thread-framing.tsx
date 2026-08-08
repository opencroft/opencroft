'use client'

import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'

import { AgentActivityLine } from '@/components/ui/agent-chat/agent-activity'
import type { ChatStatus } from '@/components/ui/chat/chat-list-item'
import { MemberAvatarGroup, type MemberRef } from '@/components/ui/group-chat/member-avatar-group'
import { cn } from '@/lib/utils'

import { CommandBarFrame } from '@/components/ui/agent-chat/command-bar-frame'
import { Flex } from '@/components/ui/layout/flex'
// The flat shadcn path, not `ui/layout/scroll-area`. The kit stores component
// files flat and the export composes the category folder on install, so a
// nested path resolves in a consumer and NOT here -- which is why this screen's
// preview rendered as an invalid element rather than as itself.
import { ScrollArea } from '@/components/ui/scroll-area'
import { StickySection } from '@/components/ui/layouts/sticky-section'

export interface GroupChatThreadFramingProps {
  /** The NAME of the group chat this thread belongs to -- not its topic. This
   * line is a breadcrumb: it says where the reader is, and what a place is
   * called is what locates it. The topic is a statement of purpose written for
   * the chat's agents and can run to a sentence, which is not what a one-line
   * breadcrumb above a conversation is for. */
  groupChatName: string
  /** The thread's own title; null until something names it. */
  threadTitle?: string | null
  /** Optional participants, shown compactly on the trailing side. */
  members?: MemberRef[]
  /** What this thread's agent is doing right now -- the SAME `ChatStatus` a
   * chat row takes, so the thread list and the thread screen speak with one
   * vocabulary and the host maps its session status once.
   *
   * Domain truth: this screen has nothing to derive it from and never guesses.
   * `idle`, or nothing at all, says nothing and costs no height, so a host with
   * no state to give renders exactly what it rendered before this existed.
   *
   * `waiting` means a PERSON is the blocker -- an unresolved permission request
   * -- not "a turn is running". Some session objects spell their
   * turn-is-running flag with the same word; mapping that one here puts the
   * heaviest mark on the screen on every running turn. */
  status?: ChatStatus
  /** The thread's agent, by name, used to word the activity line -- a thread is
   * a session with exactly one agent, so there is one to name. Without it the
   * line still reads, as "The agent": a screen that knows a turn is running
   * should say so even if the name has not loaded. */
  agentName?: string
  /** Back out of the conversation -- to the thread list / group chat. */
  onBack?: () => void
  /** The conversation itself -- agent-chat/chat-conversation, reused not redrawn. */
  children: ReactNode
  /** The composer, pinned beneath the conversation. Reused from the agent-chat
   * composer family, never redrawn here -- a group-chat thread is an ordinary
   * agent session, so it gets the same composer a 1:1 chat uses, in the same
   * CommandBarFrame. That the composer was already shared and the FRAME was not
   * is exactly how this footer came to look unlike the 1:1 one. */
  composer?: ReactNode
  className?: string
}

// The framing for a thread's conversation inside a group chat. The conversation
// surface itself is reused unchanged (a group-chat thread is an ordinary agent
// session -- see agent-chat/chat-conversation); what is worth designing is the
// context above it: the group chat a thread belongs to, by name, with the
// thread's own title, and a back affordance that matters most on minimal widths
// where the conversation is a leaf view. No locks -- this states where the
// reader is, and whether the agent is doing anything about it.
//
// The composer is a slot here rather than the host's business because this
// component already owns the vertical arrangement: header pinned, conversation
// scrolling, and now composer pinned. A composer placed inside `children` would
// scroll away with the conversation, and a host rebuilding the arrangement
// around this one would have to re-derive it -- which is exactly the layout
// this already exists to keep right at a phone width.
export function GroupChatThreadFraming({
  groupChatName,
  threadTitle,
  members,
  status,
  agentName,
  onBack,
  children,
  composer,
  className,
}: GroupChatThreadFramingProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* px-4, the same horizontal rhythm as the group-chat detail screen and
          the 1:1 conversation beneath -- the back arrow, the chat name and the
          first message all start on one left edge. The scroll area itself gets
          no padding: the conversation inside it carries its own px-4 py-4, and
          adding more here would double it. */}
      <header className='flex shrink-0 items-center gap-2 border-b border-border px-4 py-2'>
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
        <div className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
          <span className='truncate text-xs text-muted-foreground'>{groupChatName}</span>
          <span className='truncate text-sm font-medium text-foreground'>
            {threadTitle || 'Thread'}
          </span>
        </div>
        {members && members.length > 0 ? (
          <MemberAvatarGroup members={members} max={4} size='sm' className='shrink-0' />
        ) : null}
      </header>
      <ScrollArea className='min-h-0 flex-1'>
        {children}
        {/* The footer dock: the SAME StickySection + padded Flex the 1:1
            chat's ChatBar wraps its own composer in (see command-bar-frame's
            own note that the two used to drift). Placed INSIDE the scroll
            area, not below it, so it overlays the transcript as the reader
            scrolls -- a layout block here is exactly the bug this replaces.

            The activity line sits inside the same sticky dock, not the
            padded inner Flex, so its own `px-4` keeps the header's left
            edge; `-mx-2` cancels the dock's own left/right inset (also
            `--flex-padding`, 0.5rem) so the two don't stack. Rendered
            UNCONDITIONALLY even with nothing to say -- see its own doc
            comment on why a live region has to already be in the DOM. */}
        <StickySection side='bottom' fade>
          <AgentActivityLine status={status} agentName={agentName} className='shrink-0 -mx-2' />
          {composer ? (
            <Flex withGaps withPadding>
              <CommandBarFrame>{composer}</CommandBarFrame>
            </Flex>
          ) : null}
        </StickySection>
      </ScrollArea>
    </div>
  )
}
