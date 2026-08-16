'use client'

import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'
import { ChevronLeft } from 'lucide-react'

import { AgentAvatar } from '@/components/ui/media/agent-avatar'
import { cn } from '@/lib/utils'

import { CommandBarFrame } from '@/components/ui/agent-chat/command-bar-frame'
import { Flex } from '@/components/ui/layout/flex'
// The flat shadcn path, not `ui/layout/scroll-area`. The kit stores component
// files flat and the export composes the category folder on install, so a
// nested path resolves in a consumer and NOT here -- which is why this screen's
// preview rendered as an invalid element rather than as itself.
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable'
import { ScrollArea } from '@/components/ui/scroll-area'
import { StickySection } from '@/components/ui/layouts/sticky-section'
import { type Artifact, ArtifactPanel, ArtifactStrip } from 'agent-chat/components/thread-artifacts'

export interface GroupChatThreadFramingProps {
  /** The NAME of the group chat this thread belongs to -- not its topic. This
   * line is a breadcrumb: it says where the reader is, and what a place is
   * called is what locates it. The topic is a statement of purpose written for
   * the chat's agents and can run to a sentence, which is not what a one-line
   * breadcrumb above a conversation is for. */
  groupChatName: string
  /** The thread's own title; null until something names it. */
  threadTitle?: string | null
  /** The fixed agent this thread is with, shown compactly on the trailing
   * side. A thread has exactly one agent -- unlike the group chat itself,
   * which can have several -- so this shows who, not how many. */
  agent?: { name: string; avatarUrl?: string | null }
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
// context above it: the group chat a thread belongs to, by name, with the
// thread's own title, who it's with, and a back affordance that matters most on minimal widths
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
  agent,
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
        {/* Forces Radix's own internal viewport wrapper (a div ScrollArea
            inserts, not one in this file's own JSX) into a flex column filling
            the full available height -- without it `Flex expanded justify='end'`
            below has no flex-column ancestor to fill, and both (a) a short
            conversation renders top-anchored with the composer floating right
            after it instead of glued to the true bottom, and (b) StickySection
            has nothing to stay pinned against. Same mechanism the 1:1 chat's
            ChatArea uses, reused rather than re-implemented -- see that
            component's own note on why this specific selector is the fix. */}
        <ScrollArea className='min-h-0 flex-1 [&_[data-radix-scroll-area-viewport]>div]:!flex [&_[data-radix-scroll-area-viewport]>div]:!flex-col [&_[data-radix-scroll-area-viewport]>div]:!min-h-full'>
          {/* Bottom-anchored, exactly like the 1:1 chat's ChatContent: with few
              messages the conversation sits at the bottom of the viewport, not
              the top, and scrolls up from there as it grows. No inner padded
              Flex layer here (unlike ChatContent's) -- the conversation already
              carries its own px-4 py-4, per this screen's own existing note
              just below on why the scroll area itself stays unpadded. */}
          <Flex expanded justify='end'>
            {children}
          </Flex>
          {/* The footer dock: StickySection, the same sticky-bottom-with-fade
              mechanism the 1:1 chat's ChatBar uses for its own composer.
              Placed INSIDE the scroll area, not below it, so it overlays the
              transcript as the reader scrolls -- a layout block here is
              exactly the bug this replaces.

              One inset layer, not two: StickySection's own `--flex-padding`
              (0.5rem) is the only padding the composer gets. An earlier pass
              added a second padded wrapper around CommandBarFrame to match the
              1:1 chat's inset value exactly, but the 1:1 chat centers its
              composer under a max-w-3xl cap and this screen runs full pane
              width, so the same value read as too much here -- the product
              call was to halve it, and the nearest preset step below one
              `--flex-padding` layer is zero extra layers, not a smaller
              constant. */}
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
        {agent ? (
          <span className='flex min-w-0 shrink-0 items-center gap-1.5' title={agent.name}>
            <AgentAvatar avatar={agent.avatarUrl} name={agent.name} size='sm' />
            <span className='max-w-24 truncate text-sm text-foreground'>{agent.name}</span>
          </span>
        ) : null}
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
      {/* No direction prop: the group is a flex row by default and turns
          vertical from its aria-orientation, so horizontal is simply the
          default. */}
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
