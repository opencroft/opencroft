'use client'

import { Bot, ListTodo, TerminalSquare } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { AgentAvatar } from '../media/agent-avatar'
import { BackButton } from '../utils/back-button'
import { Button } from 'ui/components/ui/button'
import { type ChatStatus, STATUS_DOT, STATUS_WORD } from '../chat/chat-list-item'
import { cn } from 'ui/lib/utils'

import { CommandBarFrame } from '../agent-chat/command-bar-frame'
import { Flex } from 'ui/components/ui/layout/flex'
import { Popover, PopoverContent, PopoverTrigger } from 'ui/components/ui/popover'
// The scroll area is the kit's own rather than the plain primitive -- the
// declared registry dependency is what selects it, and where it lands in a
// consumer is composed from that component's category, not written here.
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '../resizable'
import { ScrollArea } from '../layout/scroll-area'
import { StickySection } from '../layouts/sticky-section'
import { type Artifact, ArtifactPanel, ArtifactStrip } from './thread-artifacts'

/** One piece of delegated work the thread's transcript carries: a subagent or
 * a background task, named by the id its transcript block is marked with.
 * Presentational -- the host derives the list from its own session; this
 * component only lists it and hands the pressed id back. */
export interface ThreadWorkItem {
  id: string
  kind: 'subagent' | 'task'
  name: string
  /** The state badge's word -- the harness's own (running / paused /
   * completed / failed / stopped / ...). */
  state: string
  /** Still going: a running or paused task, a subagent with no terminal
   * state yet. Live entries pulse; terminal ones read as outcomes. */
  live: boolean
}

/** The header's delegated-work summary. `liveCount` is the trigger's badge
 * (the host decides what counts -- the product counts live background
 * tasks); `onJump` receives a pressed entry's id and is expected to bring
 * that entry's transcript block into view. */
export interface ThreadWork {
  items: ThreadWorkItem[]
  liveCount: number
  onJump: (id: string) => void
}

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
  /** The session's delegated work -- subagents and background tasks -- for
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

// The same badge palette the transcript's own subagent and task blocks wear,
// so the panel and the block a jump lands on agree about what a state looks
// like: live work pulses primary, paused holds amber, completed settles
// emerald, and every other terminal state reads muted.
function workBadgeClass(item: ThreadWorkItem): string {
  if (item.state === 'paused') {
    return 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
  }
  if (item.live) {
    return 'bg-primary/10 text-primary animate-pulse'
  }
  if (item.state === 'completed') {
    return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
  }
  return 'bg-muted text-muted-foreground'
}

// The session's delegated work, on the header's trailing side: a compact
// trigger carrying a count of the LIVE work, opening a panel that lists every
// subagent and background task the transcript carries. Pressing an entry
// hands its id to the host, whose jump brings that entry's block into view --
// the panel is an index of the work, not a second rendering of it, which is
// why every line here names a block that exists.
function ThreadWorkControl({ work }: { work: ThreadWork }) {
  // Controlled so choosing an entry can close the panel: the jump's landing
  // highlight is the feedback, and a popover left open would cover the very
  // block it just pointed at.
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='ghost'
          size='sm'
          className='h-7 shrink-0 gap-1.5 px-2 text-muted-foreground'
          aria-label='Delegated work'
          title='Delegated work'
        >
          <ListTodo className='size-4' />
          {work.liveCount > 0 ? (
            <span className='rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary'>
              {work.liveCount}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-72 p-1'>
        <div className='flex max-h-72 flex-col gap-0.5 overflow-y-auto'>
          {work.items.map((item) => (
            <button
              key={item.id}
              type='button'
              onClick={() => {
                setOpen(false)
                work.onJump(item.id)
              }}
              className='flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent'
            >
              {item.kind === 'subagent' ? (
                <Bot className='size-3.5 shrink-0 text-muted-foreground' />
              ) : (
                <TerminalSquare className='size-3.5 shrink-0 text-muted-foreground' />
              )}
              <span className='min-w-0 flex-1 truncate text-xs font-medium text-foreground'>{item.name}</span>
              <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${workBadgeClass(item)}`}>
                {item.state}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// The framing for a thread's conversation inside a group chat. The conversation
// surface itself is reused unchanged (a group-chat thread is an ordinary agent
// session -- see agent-chat/chat-conversation); what is worth designing is the
// context above it: who the thread is with and whether they are doing anything
// about it (the agent's avatar, name and status lead the header, under a
// breadcrumb naming the group chat and the thread), what the session has
// delegated (the trailing work control), and a back affordance that matters
// most on minimal widths where the conversation is a leaf view. No locks --
// this states where the reader is, never who is allowed in.
//
// The status line speaks the chat list's vocabulary -- the same word and the
// same dot a row for this session shows, imported from it rather than
// restated, so the two surfaces cannot drift apart.
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
        {/* The agent leads: its avatar wears the same status dot a chat list
            row gives it, and the line under the breadcrumb says who and what
            they are doing -- "Carol · Working" -- in the row vocabulary
            (offline/idle carry no dot; working and waiting do). A thread is a
            conversation WITH someone, so the someone opens it. */}
        {agent ? (
          <AgentAvatar avatar={agent.avatarUrl} name={agent.name} statusIndicator={status ? STATUS_DOT[status] : undefined} />
        ) : null}
        <div className='flex min-w-0 flex-1 flex-col overflow-hidden leading-tight'>
          {/* One breadcrumb line, not two stacked names: where the reader is
              is one fact -- this chat, this thread -- and the agent line below
              needs the row. */}
          <span className='truncate text-xs text-muted-foreground'>
            {groupChatName} / {threadTitle || 'Thread'}
          </span>
          {agent ? (
            <span className='truncate text-sm font-medium text-foreground'>
              {agent.name}
              {status ? <span className='font-normal text-muted-foreground'> · {STATUS_WORD[status]}</span> : null}
            </span>
          ) : (
            // No agent to attribute the thread to: the title takes the
            // prominent line, so the header never collapses to one muted
            // breadcrumb.
            <span className='truncate text-sm font-medium text-foreground'>{threadTitle || 'Thread'}</span>
          )}
        </div>
        {/* The trailing side belongs to what the session has delegated. Drawn
            only when there is something to list -- a control opening an empty
            panel is noise, and a thread that never delegated is framed
            exactly as before. */}
        {work && work.items.length > 0 ? <ThreadWorkControl work={work} /> : null}
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
