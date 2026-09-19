'use client'

import type { ReactNode } from 'react'

import { BackButton } from 'ui/components/ui/utils/back-button'
import { CommandBarFrame } from 'ui/components/ui/agent-chat/command-bar-frame'
import { ListEmpty } from 'ui/components/ui/utils/list-empty'
import { StickySection } from 'ui/components/ui/layouts/sticky-section'
import { cn } from 'ui/lib/utils'

export interface GroupChatDetailProps {
  /** Back out of this group chat -- to the group-chat list, or to whatever
   * holds this screen. Draws the shared BackButton, so this is literally the
   * same control the list and the thread screen use rather than a matching one. */
  onBack?: () => void
  /** What this chat is called. The title, plain: renaming happens where the
   * chats are listed, from a row's menu, not on this screen. */
  name: string
  /** A search field drawn IN THE TITLE'S PLACE while a search is open -- the
   * host owns the field, its query and whether it is open, and this screen only
   * gives it the title's room. The threads below are then whatever the host
   * hands over for that query. */
  searchField?: ReactNode
  /** The header's controls, after the title: the search toggle, the pins
   * toggle, the chat's menu. Any member may use all of them, so these are
   * ordinary member controls, not admin ones. Starting a thread is the composer
   * below, not a header button: a thread begins with a first message. */
  actions?: ReactNode
  /** A panel opened from the header -- the pinned notes, edited in place --
   * drawn between the header and the threads. Above the scroll region, not in
   * it: standing context that scrolls away with the threads stops standing. */
  panel?: ReactNode
  /** The thread list (or any content) for this group chat. Omit/leave null to
   * show `emptyState` instead -- the group chat itself holds no messages, so a
   * chat with no threads yet is an empty state, not a blank. */
  threads?: ReactNode
  emptyState?: ReactNode
  /** Pinned beneath the threads -- the new-thread composer. It stays put while
   * the thread list scrolls above it, the way a chat composer stays put while
   * the conversation scrolls.
   *
   * Framed in the SAME CommandBarFrame the 1:1 chat's command bar sits in --
   * not a card of this screen's own. This screen used to draw its own, with a
   * panel's inset, and it read as a different kind of surface from the composer
   * one screen away. */
  composer?: ReactNode
  /** Draw no header of this screen's own. For a host that already has one --
   * the embedded chat panel's window -- and puts the name, the search field
   * and the controls there, the way it puts an open thread's header there.
   * `onBack`, `name`, `searchField` and `actions` are then the host's to
   * place, and this renders the panel, the threads and the composer alone. */
  headerless?: boolean
  className?: string
}

// The view inside one group chat: a one-line header (back, the name, the
// controls), an optional panel under it, and the thread list over the composer.
// The group chat itself holds no messages, so there is nothing else on this
// screen; that emptiness is part of the design and worth seeing.
//
// What the header used to carry and no longer does, on purpose: an editable
// name (renaming moved to the list's row menu), a topic line (retired), the
// avatar cluster of who is taking part (the chat's menu holds the members now,
// as a list that is searched to add to). The header is one line at any width
// because everything that needed room moved behind a control.
export function GroupChatDetail({
  onBack,
  name,
  searchField,
  actions,
  panel,
  threads,
  emptyState,
  composer,
  headerless = false,
  className,
}: GroupChatDetailProps) {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* px-4 is the chat surface's horizontal rhythm, shared by the header,
          the thread area and the composer below -- the 1:1 conversation uses
          the same, so a group chat and a 1:1 chat line up on one left edge
          rather than each having its own. */}
      {headerless ? null : (
        <header className='flex shrink-0 items-center gap-2 border-b border-border px-4 py-2'>
          {onBack ? <BackButton onClick={onBack} /> : null}
          {searchField ? (
            <div className='min-w-0 flex-1'>{searchField}</div>
          ) : (
            <h2 className='min-w-0 flex-1 truncate text-base font-semibold text-foreground'>{name}</h2>
          )}
          {/* Never allowed to shrink: past the controls, the name gives up its
              space first, because a truncated name is still readable and a
              squeezed control is not. */}
          {actions ? <div className='flex shrink-0 items-center gap-1'>{actions}</div> : null}
        </header>
      )}
      {panel ? <div className='shrink-0 border-b border-border px-4 py-2'>{panel}</div> : null}
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
            {threads ?? emptyState ?? <ListEmpty text='No threads yet.' />}
          </div>
          {/* Inside the scroll region, not below it -- a sticky dock so the
              composer overlays the thread list as it scrolls, the same shape
              the 1:1 chat's ChatBar and the thread screen's own footer use
              (see group-chat-thread-framing). A layout block here, reserving
              its own row beneath the list, was the bug this replaces. */}
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
