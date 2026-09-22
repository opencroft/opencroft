'use client'

import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { BackButton } from '../utils/back-button'
import { LIST_ROW_SECONDARY_CLASS, LIST_ROW_TITLE_CLASS } from '../utils/list-row'
import { cn } from 'ui/lib/utils'

import { CommandBarFrame } from '../agent-chat/command-bar-frame'
import { Flex } from 'ui/components/ui/layout/flex'
// The scroll area is the kit's own rather than the plain primitive -- the
// declared registry dependency is what selects it, and where it lands in a
// consumer is composed from that component's category, not written here.
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../resizable'
import { ScrollArea } from '../layout/scroll-area'
import { StickySection } from '../layouts/sticky-section'
import { type Artifact, ArtifactPanel, ArtifactStrip } from './thread-artifacts'
import { type ChatStatus, ThreadAgentCluster } from './thread-agent-cluster'
import { type ThreadWork, type ThreadWorkItem, ThreadWorkControl } from './thread-work-control'

// Re-exported for hosts that reach the work types through the framing they
// compose -- the types are the control's, and stay defined there once.
export type { ThreadWork, ThreadWorkItem }

export interface GroupChatThreadFramingProps {
  /** The NAME of the group chat this thread belongs to -- not its topic. This
   * line is a breadcrumb: it says where the reader is, and what a place is
   * called is what locates it. The topic is a statement of purpose written for
   * the chat's agents and can run to a sentence, which is not what a one-line
   * breadcrumb above a conversation is for. */
  groupChatName: string
  /** The thread's own title; null until something names it. */
  threadTitle?: string | null
  /** The fixed agent this thread is with, leading the header: its avatar
   * (with the status dot) and its name on the line under the breadcrumb. A
   * thread has exactly one agent -- unlike the group chat itself, which can
   * have several -- so this shows who, not how many. */
  agent?: { name: string; avatarUrl?: string | null }
  /** The agent's process state, in the SAME vocabulary the chat list rows
   * speak (see ChatListItem): one status drives both the word beside the
   * agent's name and the dot on the avatar, so a list row and the header a
   * press on it opens can never disagree about the same session. Omit to
   * show the name alone. */
  status?: ChatStatus
  /** The session's background tasks -- subagents and tasks alike -- for
   * the header's trailing side: a count of the live work, and a panel that
   * jumps to each entry's block. Omit, or pass one with no items, and no
   * control is drawn. */
  work?: ThreadWork
  /** Back out of the conversation -- to the thread list / group chat. Draws
   * the shared BackButton: the deepest of three nesting surfaces, and the same
   * control the two above it use rather than a matching one. */
  onBack?: () => void
  /** The conversation itself -- agent-chat/chat-conversation, reused not redrawn. */
  children: ReactNode
  /** The composer, pinned beneath the conversation. Reused from the agent-chat
   * composer family, never redrawn here -- a group-chat thread is an ordinary
   * agent session, so it gets the same composer a 1:1 chat uses, in the same
   * CommandBarFrame. That the composer was already shared and the FRAME was not
   * is exactly how this footer came to look unlike the 1:1 one. */
  composer?: ReactNode
  /** The notes the thread's agent has left. Absent or empty renders nothing --
   * a thread earns artifacts by having work done in it. */
  artifacts?: Artifact[]
  /** Which artifact is open, if any. Controlled: this screen owns the
   * arrangement, the host owns the selection. */
  openArtifactId?: string
  onOpenArtifact?: (id: string) => void
  onCloseArtifact?: () => void
  className?: string
}

// The framing for a thread's conversation inside a group chat. The conversation
// surface itself is reused unchanged (a group-chat thread is an ordinary agent
// session -- see agent-chat/chat-conversation); what is worth designing is the
// context above it: who the thread is with and whether they are doing anything
// about it (the agent cluster -- avatar, breadcrumb, name and status -- leads
// the header), the session's background tasks (the trailing work control),
// and a back affordance that matters most on minimal widths where the
// conversation is a leaf view. No locks -- this states where the reader is,
// never who is allowed in.
//
// Both header pieces are siblings this composes rather than draws: the dock
// window puts the same cluster and the same control in the header it already
// has, so a thread reads identically whichever surface it is open in.
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
  agent,
  status,
  work,
  onBack,
  children,
  composer,
  artifacts,
  openArtifactId,
  onOpenArtifact,
  onCloseArtifact,
  className,
}: GroupChatThreadFramingProps) {
  const openArtifact = artifacts?.find((artifact) => artifact.id === openArtifactId)
  // Two arrangements, not one that stretches. On a wide screen the note opens
  // beside the conversation and the reader can drag the divide. On a phone it
  // REPLACES the conversation and closing brings it back -- a split there
  // leaves neither side readable, and dragging a divider on a touch screen is
  // an accelerator nobody asked for.
  //
  // Read live rather than once, because the arrangement has to be right after a
  // rotation, not just at mount. Starts narrow so the server and the first
  // client paint agree; a wide client corrects on its first effect, before
  // anyone has scrolled.
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)')
    const sync = () => setWide(query.matches)
    sync()
    query.addEventListener('change', sync)
    return () => query.removeEventListener('change', sync)
  }, [])
  const conversation = (
    <>
      {/* TWO wrappers sit between the scroll viewport and this file's JSX, and
          both have to fill the viewport's height or the bottom anchoring below
          stops working with nothing reporting it: Radix inserts one of its own
          inside the viewport, and this scroll area wraps whatever it is given
          in a flex column of its own. The selector forces the first into a
          filling flex column; innerClassName makes the second grow inside it.
          With either one missing, `Flex expanded justify='end'` has no ancestor
          with a real height to fill, and both (a) a short conversation renders
          top-anchored with the composer floating right after it instead of
          glued to the true bottom, and (b) StickySection has nothing to stay
          pinned against.

          The plain primitive has only Radix's wrapper, so the selector alone is
          enough there -- which is why the 1:1 chat's ChatArea, the same
          mechanism reused rather than re-implemented, carries the selector and
          no innerClassName. The difference is which scroll area is in play, not
          the arrangement. */}
      <ScrollArea
        className='min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!flex [&_[data-radix-scroll-area-viewport]>div]:!flex-col [&_[data-radix-scroll-area-viewport]>div]:!min-h-full'
        innerClassName='flex-1'
      >
        {/* Bottom-anchored, exactly like the 1:1 chat's ChatContent: with few
            messages the conversation sits at the bottom of the viewport, not
            the top, and scrolls up from there as it grows. No inner padded Flex
            layer here, unlike ChatContent's -- the conversation already carries
            its own padding, for the same reason the header note gives for
            leaving the scroll area itself unpadded. */}
        <Flex expanded justify='end'>
          {children}
        </Flex>
        {/* The footer dock: StickySection, the same sticky-bottom-with-fade
            mechanism the 1:1 chat's ChatBar uses for its own composer. Placed
            INSIDE the scroll area, not below it, so it overlays the transcript
            as the reader scrolls -- a layout block here is exactly the bug this
            replaces.

            One inset layer, not two: StickySection's own `--flex-padding`
            (0.5rem) is the only padding the composer gets. The 1:1 chat centers
            its composer under a max-w-3xl cap while this screen runs full pane
            width, so the same value read as too much here.

            An earlier pass added a second padded wrapper around the frame to
            match the 1:1 chat's inset exactly, and it was rejected: the product
            call was to HALVE it, and the nearest step below one `--flex-padding`
            layer is zero extra layers rather than a smaller constant. This is a
            settled decision, not an oversight -- if the composer reads tight,
            that is the value to revisit, not this arrangement. */}
        <StickySection side='bottom' fade>
          {composer ? <CommandBarFrame>{composer}</CommandBarFrame> : null}
        </StickySection>
      </ScrollArea>
    </>
  )

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      {/* px-4, the same horizontal rhythm as the group-chat detail screen and
          the 1:1 conversation beneath -- the back arrow, the chat name and the
          first message all start on one left edge. The scroll area itself gets
          no padding: the conversation inside it carries its own px-4 py-4, and
          adding more here would double it. */}
      <header className='flex shrink-0 items-center gap-2 border-b border-border px-4 py-2'>
        {onBack ? <BackButton onClick={onBack} /> : null}
        {agent ? (
          // The agent leads, in a chat list row's own terms -- the cluster is
          // the row's avatar, dot, breadcrumb and "Name · Status" line, so a
          // row and the header a press on it opens say one thing in one type.
          <ThreadAgentCluster
            agent={agent}
            status={status}
            groupChatName={groupChatName}
            threadTitle={threadTitle}
            className='flex-1'
          />
        ) : (
          // No agent to attribute the thread to: the same two row styles,
          // with the title taking the prominent line so the header never
          // collapses to one muted breadcrumb.
          <div className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
            <span className={LIST_ROW_SECONDARY_CLASS}>{groupChatName}</span>
            <span className={LIST_ROW_TITLE_CLASS}>{threadTitle || 'Thread'}</span>
          </div>
        )}
        {/* The trailing side belongs to the session's background tasks. The
            control draws nothing of its own until there is something to list,
            so a thread with no background tasks is framed exactly as before. */}
        {work ? <ThreadWorkControl work={work} /> : null}
      </header>
      {/* Artifacts get their own row rather than a place in the line above.
          That line is already carrying a breadcrumb, a title and an agent, and
          on a phone there is nothing left to give -- while the strip is the one
          part that grows with use. It exists only when there is something in
          it, so a thread that has never produced a note is framed exactly as
          before. */}
      {artifacts && artifacts.length > 0 ? (
        <div className='shrink-0 border-b border-border px-4 py-1'>
          <ArtifactStrip artifacts={artifacts} openId={openArtifactId} onOpen={(id) => onOpenArtifact?.(id)} />
        </div>
      ) : null}
      {/* No direction prop on the panel group below: it is a flex row by
          default and turns vertical from its aria-orientation, so horizontal is
          simply the default rather than an omission. */}
      {wide ? (
        <ResizablePanelGroup className='min-h-0 flex-1'>
          {/* `id` on both, because the artifact panel comes and goes: without
              stable identities the group cannot tell an added panel from a
              rearranged one, and re-lays-out from scratch each time. */}
          <ResizablePanel
            id='conversation'
            defaultSize={openArtifact ? 68 : 100}
            minSize={20}
            className='flex min-w-0 flex-col'
          >
            {conversation}
          </ResizablePanel>
          {openArtifact ? (
            <>
              {/* `withHandle` so the grip is drawn rather than left as a hit
                  area to discover. Dragging is the only way to resize, which is
                  acceptable for a width: it adjusts a layout that already
                  works, it is not a route to something otherwise unreachable. */}
              <ResizableHandle withHandle />
              <ResizablePanel id='artifact' defaultSize={32} minSize={20} className='flex min-w-0 flex-col'>
                <ArtifactPanel artifact={openArtifact} onClose={onCloseArtifact} />
              </ResizablePanel>
            </>
          ) : null}
        </ResizablePanelGroup>
      ) : (
        <div className='flex min-h-0 flex-1'>
          {/* Hidden, not unmounted: the reader comes back to this the moment
              they close the note, and rebuilding the transcript would drop
              their place in it. */}
          <div className={openArtifact ? 'hidden' : 'flex min-w-0 flex-1 flex-col'}>{conversation}</div>
          {openArtifact ? (
            <div className='flex min-w-0 flex-1 flex-col'>
              <ArtifactPanel artifact={openArtifact} onClose={onCloseArtifact} />
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
