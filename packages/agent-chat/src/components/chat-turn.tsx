'use client'

import { Maximize2, Minimize2, Pencil, X } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useState } from 'react'
// The type import back the other way is erased, so this is not a runtime cycle.
import { facesInRun } from '../author-runs'
import { Markdown } from './markdown'

import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'
import { Button } from 'ui/components/ui/button'
import {
  CollapsingStickyHeader,
  CollapsingStickyHeaderContent,
  CollapsingStickyHeaderPinned,
} from 'ui/components/ui/layouts/collapsing-sticky-header'
import { cn } from 'ui/lib/utils'

// The attribute the host's scroll restore uses to find a block again and
// measure how far it moved. Exported so the host queries the same name rather
// than duplicating the literal.
export const BLOCK_ID_ATTR = 'data-block-id'

// A user's own words, after the host has passed them through its own
// sanitiser. Branded rather than `string` on purpose: this is the only
// component that renders a user's message, and requiring the brand is what
// closes the route raw stream text once took into the sticky header. A host
// cannot hand this component text that has not been through that step.
export type UserText = string & { readonly __userText: unique symbol }

// Declared here rather than imported from the package that also defines it: a
// type-only import still puts that package in this one's import graph and
// manifest, which is the layering this component exists on the right side of.
// The host's own copies satisfy this structurally.
export type ChainDotVariant = 'default' | 'success' | 'destructive'

// One item inside a turn's detail chain. The host builds these; this component
// only renders them.
//
// Only a tool call carries an `id`: it is the React key for the single node the
// collapsed view re-renders, and it is the request id a tool view resolves
// against. Text and thinking entries are keyed by position instead, so giving
// them an id would be inventing data the host does not have.
export type DetailItem =
  | { kind: 'assistant-text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; args: unknown; result?: { text: string; isError?: boolean } }

export type DetailEntry = { kind: 'header' } | { kind: 'item'; item: DetailItem }

// The pieces this component renders but deliberately does not own.
//
// **This bundle is a seam, not a preference.** The chain rail and the thinking
// block each exist in more than one implementation in this workspace, and which
// one renders has to stay the host's choice until they are consolidated --
// otherwise one conversation mixes two copies of the same component. Taking
// them as props keeps that decision where it can be made once, for the whole
// conversation.
//
// Markdown is deliberately NOT in here: rendering its own content is this
// component's job, and a renderer slot would push a rendering concern onto
// every consumer.
//
// When the consolidation lands these collapse into plain imports and this type
// goes away. A consumer reading these as props can see they are a seam; the
// same code written as imports would just look like a settled decision.
export interface ChatTurnRenderers {
  // One segment of the vertical rail: a marker beside the segment's content.
  Chained: ComponentType<{
    marker: ReactNode
    lineAbove: boolean
    lineBelow: boolean
    align?: 'first-line' | 'start'
    children: ReactNode
  }>
  // The small status dot used as a rail marker.
  ChainDot: ComponentType<{ variant?: ChainDotVariant }>
  // A collapsible reasoning block.
  ThinkingBlock: ComponentType<{ text: string; pending?: boolean }>
}

// Every markdown link in chat content opens in a new tab, so following one
// never costs the conversation the reader was in. `noopener` is required
// alongside `target="_blank"` -- without it the opened page keeps a handle on
// ours through `window.opener`.
//
// This is behaviour, not formatting, and it is why the markdown renderer is not
// a host prop: as a slot, every consumer would have to re-establish it, and a
// consumer that passed a bare renderer would silently lose it. Owning the
// renderer here is what makes the guarantee a property of the component.




// Chat content is markdown, and rendering it is this component's own
// presentation rather than something a host supplies: a message component that
// cannot render its own message is not a component, and pushing the renderer
// out as a slot would make every consumer re-wire a rendering concern.


// The one way older history is loaded. A click cannot fire at the wrong moment
// or fail to fire at all, which is what four rebuilds of an automatic trigger
// could not be made to guarantee.
//
// It is also where the guards that trigger needed now live, as states rather
// than as code: absent once the host says there is nothing left, disabled while
// a fetch is in flight. Same guarantees, nothing to remember to check.
//
// Rendered in the transcript's own flow rather than pinned above it, so on a
// conversation too short to scroll it sits with the content instead of at the
// top of an empty scroll area.
export function ChatLoadOlderButton({ loading, onLoadOlder }: { loading: boolean; onLoadOlder: () => void }) {
  return (
    <div className='flex justify-center w-full py-1'>
      <Button variant='ghost' size='sm' disabled={loading} onClick={onLoadOlder}>
        {loading ? 'loading…' : 'load older messages'}
      </Button>
    </div>
  )
}

// A message's send time, rendered small beside whoever sent it.
//
// It is shown at all because the send time and the read time stop being close
// together: a message can wait to be read for as long as the reading cadence
// says, so when it was SENT is a fact the reader has no other way to recover.
//
// `<time>` rather than a span: the exact instant stays in `dateTime` and in the
// title, so the visible text can stay short enough to sit on the header's line
// without ever being truncated.
export function ChatMessageTime({ sentAt }: { sentAt: string }) {
  const at = new Date(sentAt)
  if (Number.isNaN(at.getTime())) {
    return null
  }
  return (
    <time dateTime={at.toISOString()} title={at.toLocaleString()} className='shrink-0 text-xs text-muted-foreground'>
      {formatSentAt(at)}
    </time>
  )
}

// Today's messages read as a clock time; anything older carries its date too,
// because a bare clock time is ambiguous the moment a day has passed -- which
// under a slow reading cadence is an ordinary case and not an edge one.
//
// `now` is a parameter so the boundary this turns on can be stated in a test
// rather than waited for.
export function formatSentAt(at: Date, now: Date = new Date()): string {
  const time = at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  return sameDay ? time : `${at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${time}`
}

// One message inside a turn: its own words, and who sent them when.
//
// `author` is the identifier the delivery carried; `authorAccount` is what that
// identifier resolved to. They are separate fields because resolution can fail
// and the header still has to render -- an identifier written before accounts
// had them, or one whose account has since gone, leaves the message holding
// text and nothing else. That case is a rendering state, not an error.
//
// THE RESOLVED ACCOUNT ARRIVES ON THE PART. This component never looks one up.
// A header that consulted a cache or a directory would render differently
// depending on how much of the conversation happened to be loaded around it --
// the same message showing an avatar deep in a transcript and none at the top
// of it, with bugs that reproduce only at the depth the reporter happened to
// reach. One element, one behaviour: whatever it needs comes with the item it
// renders.
//
// All three are optional together: a prompt the application issued on its own
// behalf has no author and no send time, and it is still rendered, so that
// something waiting is never invisible.
//
// `sentAt` is the SENT time and never the delivered one. Those are different
// instants as soon as a message waits, and only the first is a fact about the
// sender.
export interface ChatUserMessagePart {
  text: UserText
  author?: string
  authorAccount?: { name: string; avatarUrl?: string | null }
  sentAt?: string
}

export interface ChatUserMessageProps {
  // Marks this block in the DOM so the host's load-older restore can find it
  // again and measure how far it moved. Sits on the outermost box, which is the
  // block's own element in the flow.
  //
  // Optional, because not every message this renders is a block: one still
  // waiting to be read has no place in the transcript for a restore to find.
  blockId?: string
  // Everything this turn said, in the order it was sent.
  //
  // A list rather than one text because a turn can carry more than one message:
  // a reader can send several while the agent is busy, and they are handed over
  // together as a single turn. Joined into one text they would all render under
  // one author and one time, which is wrong for every message but the last.
  //
  // One message is the one-part case, and needs no special handling anywhere.
  parts: readonly ChatUserMessagePart[]
  editDisabled?: boolean
  onEdit?: () => void
  // Take this message back before it is ever delivered. Its button is always
  // visible rather than revealed on hover -- hover is not a route on a touch
  // screen, and this is the only way to undo a send.
  onRemove?: () => void
  // Hold the top of the viewport while this turn's replies scroll underneath.
  //
  // The turn is then rendered twice by `CollapsingStickyHeader`: in full, and
  // as the short strip it collapses to. That component owns the sticky
  // geometry, the stacking order and the cross-fade between the two forms;
  // what each form looks like stays here.
  sticky?: boolean
  renderers: ChatTurnRenderers
}

export function ChatUserMessage({
  blockId,
  parts,
  editDisabled,
  onEdit,
  onRemove,
  sticky,
  renderers,
}: ChatUserMessageProps) {
  const { Chained } = renderers

  // Later messages supersede earlier ones -- the rule the agent is told to read
  // a turn by -- so the last one is what stays behind as the header, and the
  // earlier ones simply scroll away with everything else.
  const earlier = parts.slice(0, -1)
  const last = parts[parts.length - 1]

  // Whether each message opens a new run, and so shows its sender's face.
  // Computed for THIS delivery only: a turn is a batch, and a batch opens with
  // a face whatever was said before it.
  const faces = facesInRun(parts)

  // The face for a message, or the space where one would be.
  //
  // TWO CONDITIONS, AND THE SECOND IS NOT A GUARD AGAINST A MISSING PROP. A
  // face is drawn when the message opens a run AND there is an account to draw
  // -- because `AgentAvatar` with nothing to show falls through to a generic
  // person icon, and a person icon per sender change is a picture of somebody
  // standing in for every message this application cannot identify. Unresolved
  // has to stay visibly unresolved: the name renders as the text it holds and
  // no face appears, which is the state the design already has for it.
  //
  // The population makes it concrete rather than theoretical: every author
  // stamped before accounts had handles resolves to nothing, so gating on the
  // run alone would put an anonymous face on the opening message of every run
  // in every transcript already written.
  //
  // The blank is the avatar's own size rather than nothing, so a message
  // inside a run sits at the same left edge as the one that opened it -- a run
  // that shifted sideways as it went would read as a different kind of thing
  // rather than as the same sender continuing.
  const markerFor = (part: ChatUserMessagePart, index: number) =>
    faces[index] && part.authorAccount ? (
      <AgentAvatar avatar={part.authorAccount.avatarUrl ?? undefined} name={part.authorAccount.name} size='md' />
    ) : (
      <span aria-hidden className='block size-8' />
    )

  const body = (
    // The same rail the replies below are rendered in, so both columns start at
    // the same left edge by construction rather than by a matched indent -- if
    // the rail's width changes, the two move together.
    //
    // The sentence that used to end this comment -- that the avatar has no
    // source and falls back to a person icon, which is the intended
    // placeholder -- was true of the single avatar a turn used to carry, and
    // stopped being true the moment there was one per sender change. A
    // placeholder standing in for a whole turn is a layout decision; one per
    // sender change is a claim about who spoke.
    <>
      {earlier.map((part, index) => (
        // Each message is its own rail segment, because each one answers the
        // avatar question for itself. The rail column is a fixed width OUTSIDE
        // the content column, so a face can only sit in it by the message
        // having a segment -- drawing them inside the content column instead
        // would indent every bubble by the rail's width and stop the question
        // lining up with the replies below it.
        //
        // Keyed by position: a turn's parts are decoded from text that cannot
        // change once it has been sent, so they never reorder and nothing is
        // ever inserted between them. There is no id to key on instead -- a
        // message carries an author and a time, not an identity.
        <Chained key={index} marker={markerFor(part, index)} lineAbove={false} lineBelow={false} align='start'>
          <UserMessageBubble part={part} />
        </Chained>
      ))}
      <Chained
        // Pinned rather than duplicated, on the segment that hands over. The
        // avatar holds the container's edge while the message slides past it,
        // so it is rendered once and never fades. Placed in the cross-fade
        // instead it would appear out of nothing exactly as the message left,
        // which is the kind of thing a reader sees even when they could not
        // say what happened.
        marker={
          sticky && last ? (
            <CollapsingStickyHeaderPinned>{markerFor(last, parts.length - 1)}</CollapsingStickyHeaderPinned>
          ) : last ? (
            markerFor(last, parts.length - 1)
          ) : null
        }
        lineAbove={false}
        lineBelow={false}
        align='start'
      >
      <div className='flex items-start group w-full gap-1'>
        <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
          {last &&
            (sticky ? (
              // The last message is the one that hands over: its full form
              // scrolls away like ordinary content, its opening three lines
              // stay behind, and the two cross only in the final stretch. That
              // wait is the point -- a message taller than the screen is read
              // rather than shrunk out from under the reader.
              <CollapsingStickyHeaderContent preview={<UserMessageBubble part={last} preview />}>
                <UserMessageBubble part={last} />
              </CollapsingStickyHeaderContent>
            ) : (
              <UserMessageBubble part={last} />
            ))}
        </div>
        {onEdit && (
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100'
            title='Edit message'
            disabled={editDisabled}
            onClick={onEdit}
          >
            <Pencil className='size-3.5' />
          </Button>
        )}
        {onRemove && (
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-6 w-6 shrink-0'
            title='Remove message'
            onClick={onRemove}
          >
            <X className='size-3.5' />
          </Button>
        )}
        </div>
      </Chained>
    </>
  )

  // Not stickable: a plain block in the flow, and nothing collapses.
  if (!sticky) {
    return <div {...{ [BLOCK_ID_ATTR]: blockId }}>{body}</div>
  }

  return (
    <CollapsingStickyHeader
      // Marks the block in the DOM so the host's load-older restore can find it
      // again and measure how far it moved. It belongs on the outermost box,
      // which is the header's reserved element in the flow -- not the box that
      // moves.
      {...{ [BLOCK_ID_ATTR]: blockId }}
      // The backing: fully opaque at its top edge, falling away to nothing at
      // its bottom, so replies dissolve as they pass under it instead of being
      // clipped at a line. `bg-transparent` clears the header's own solid
      // default first -- left in place it would sit behind the gradient and
      // make the falloff opaque all the way down.
      //
      // It costs no legibility even though it fades behind the message: the
      // question sits in its own `bg-muted` bubble and the avatar in a
      // `bg-muted` circle, both opaque in either theme, so nothing passes
      // behind the text. What this backs is the gutter around them -- the rail,
      // and the strip beside the edit control -- and a reply showing through
      // there as it passes is the accepted trade, not a defect.
      className='bg-transparent bg-linear-to-b from-background to-transparent'
    >
      {body}
    </CollapsingStickyHeader>
  )
}

// One message's own box, inside the turn that carried it.
//
// Its author and send time sit INSIDE the bubble rather than above it, so a
// message waiting to be read and one already in the transcript are the same
// object with the same header. That is what lets one component render both
// instead of two that drift apart.
function UserMessageBubble({
  part,
  preview,
}: {
  part: ChatUserMessagePart
  // True for the short form that stays behind once the turn has slid away: the
  // same bubble, clamped to its opening lines. It is a second rendering rather
  // than a state of the first, so neither one's height ever depends on how far
  // the slide has gone.
  preview?: boolean
}) {
  return (
    <div className='flex flex-col relative min-w-0 gap-1.5 rounded-md bg-muted border-1 p-2'>
      {preview && (
        // The header form's shadow -- the command bar's, on the same opaque
        // rounded box the composer's card uses, so it floats on the gradient
        // rather than tracing a dissolving edge.
        //
        // Its own layer, matching the bubble's box by being its child, so it
        // sits behind the bubble's background -- which hides nothing, since an
        // outer shadow is drawn outside the border box. It needs no transition
        // and no query: this form only exists as the thing left behind, and the
        // header cross-fades the whole of it in.
        <div aria-hidden className='absolute inset-0 -z-1 rounded-md pointer-events-none shadow-lg shadow-black/50' />
      )}
      {(part.author || part.authorAccount || part.sentAt) && (
        // Author on the left, send time on the right, above the words.
        //
        // Centred rather than baseline-aligned: an avatar has no baseline to
        // sit on, and one row that changes its alignment depending on whether
        // the author resolved would be two layouts wearing one name.
        <div className='flex min-w-0 items-center justify-between gap-2'>
          {/* A NAME, NEVER A FACE. There is already an avatar beside this
              bubble, on the rail; a second one inside it is two pictures of
              one sender, which is rejected outright.
              Where the face goes is a rail question and is answered there.

              The resolved name and the raw identifier keep their two states,
              because they say different things: a name is somebody this
              application knows, and an identifier is a message whose sender it
              could not place -- an old tag, or an account since removed. */}
          {part.authorAccount ? (
            <span className='min-w-0 truncate text-xs font-medium text-foreground'>{part.authorAccount.name}</span>
          ) : part.author ? (
            <span className='min-w-0 truncate text-xs font-medium text-muted-foreground'>{part.author}</span>
          ) : null}
          {part.sentAt ? <ChatMessageTime sentAt={part.sentAt} /> : null}
        </div>
      )}
      {/* Three lines in the header form, whole everywhere else. That is the
          problem in one line: a question renders at its full height, and
          because the turn holds the top of the viewport while its own replies
          scroll underneath, a tall one covered the answer it belonged to. Read
          in its own place in the flow it costs nothing, so it is left alone.

          The clamp is UNCONDITIONAL on this form rather than a `scroll-state`
          query on the live text. Those queries are Chromium-only, so everywhere
          else a stuck turn was never clamped at all -- which is exactly the
          case the bound exists for.

          It sits on the markdown rather than on the bubble because a line clamp
          is `-webkit-box`, and that display value cannot be put on a bordered
          bubble without destroying it. */}
      <Markdown text={part.text} className={preview ? 'line-clamp-3' : undefined} />
    </div>
  )
}

export function ChatDetailsToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? Maximize2 : Minimize2
  return (
    <button
      type='button'
      onClick={onToggle}
      className={cn(
        'shrink-0 size-6 inline-flex items-center justify-center rounded-md transition-colors',
        collapsed
          ? 'text-muted-foreground hover:text-foreground hover:bg-accent'
          : 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
      )}
      title={collapsed ? 'Show details' : 'Hide details'}
    >
      <Icon className='size-3.5' />
    </button>
  )
}

export function ChatAssistantText({
  text,
  botName,
  sentAt,
  toggle,
}: {
  text: string
  botName?: string
  sentAt?: string
  toggle?: ReactNode
}) {
  return (
    <div className='flex flex-col min-w-0 w-full gap-1'>
      <div className='flex items-center justify-between w-full gap-2'>
        <div className='flex min-w-0 items-baseline gap-2'>
          {botName ? <div className='truncate text-xs font-medium text-foreground'>{botName}</div> : null}
          {sentAt ? <ChatMessageTime sentAt={sentAt} /> : null}
        </div>
        {toggle}
      </div>
      {text ? (
        <Markdown text={text} />
      ) : null}
    </div>
  )
}

function toolDotVariant(item: DetailItem): ChainDotVariant {
  if (item.kind !== 'tool' || !item.result) {
    return 'default'
  }
  return item.result.isError ? 'destructive' : 'success'
}

function withHeader(items: DetailItem[]): DetailEntry[] {
  const entries: DetailEntry[] = items.map((item) => ({ kind: 'item', item }))
  if (items[0] && items[0].kind !== 'assistant-text') {
    entries.unshift({ kind: 'header' })
  }
  return entries
}

export interface ChatTurnDetailsProps {
  blockId: string
  items: DetailItem[]
  botName: string
  // When this reply began. A reply is one turn, so the time belongs to the
  // chain rather than to each entry in it, and it is shown once beside the
  // name at the top.
  sentAt?: string
  agentAvatar?: string
  defaultCollapsed?: boolean
  onCollapseChange?: (collapsed: boolean) => void
  // True while this turn is the active turn and still generating.
  pending?: boolean
  // Renders one tool call. A registered view gives e.g. a file edit a real diff
  // instead of a raw args dump; which views exist is the host's registry, not
  // this component's business.
  renderTool: (item: Extract<DetailItem, { kind: 'tool' }>) => ReactNode
  renderers: ChatTurnRenderers
}

// The assistant's side of a turn: a chain of text, thinking and tool calls,
// collapsible to just its last text plus the tool call that followed it.
export function ChatTurnDetails({
  blockId,
  items,
  botName,
  sentAt,
  agentAvatar,
  defaultCollapsed,
  onCollapseChange,
  pending,
  renderTool,
  renderers,
}: ChatTurnDetailsProps) {
  const { Chained, ChainDot, ThinkingBlock } = renderers
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false)
  const entries = withHeader(items)
  const toggle =
    items.length > 1 ? (
      <ChatDetailsToggle
        collapsed={collapsed}
        onToggle={() => {
          const next = !collapsed
          setCollapsed(next)
          onCollapseChange?.(next)
        }}
      />
    ) : null

  const renderEntry = (
    entry: DetailEntry,
    name?: string,
    entryToggle?: ReactNode,
    entryPending?: boolean,
    entrySentAt?: string,
  ) => {
    if (entry.kind === 'header') {
      return <ChatAssistantText text='' botName={name} sentAt={entrySentAt} toggle={entryToggle} />
    }
    const { item } = entry
    if (item.kind === 'assistant-text') {
      return <ChatAssistantText text={item.text} botName={name} sentAt={entrySentAt} toggle={entryToggle} />
    }
    if (item.kind === 'thinking') {
      return <ThinkingBlock text={item.text} pending={entryPending} />
    }
    return renderTool(item)
  }

  // When collapsed, combine last text + last tool call (if tool comes AFTER text)
  if (collapsed) {
    // Find the last assistant-text entry
    let lastTextEntry: DetailEntry | null = null
    let lastTextIdx = -1
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i]
      if (e.kind === 'item' && e.item.kind === 'assistant-text' && e.item.text.trim()) {
        lastTextEntry = e
        lastTextIdx = i
        break
      }
    }

    // Find the last tool entry that comes AFTER the last text
    let lastToolAfterText: DetailItem | null = null
    if (lastTextIdx >= 0) {
      for (let i = entries.length - 1; i > lastTextIdx; i--) {
        const e = entries[i]
        if (e.kind === 'item' && e.item.kind === 'tool') {
          lastToolAfterText = e.item
          break
        }
      }
    }

    const hasAvatar = !!agentAvatar
    const marker = hasAvatar ? <AgentAvatar avatar={agentAvatar} name={botName} size='md' /> : <ChainDot />

    return (
      <div className='flex flex-col min-w-0 w-full' {...{ [BLOCK_ID_ATTR]: blockId }}>
        <Chained marker={marker} lineAbove={false} lineBelow={false} align={hasAvatar ? 'start' : 'first-line'}>
          <div className='flex flex-col min-w-0 w-full gap-1'>
            <div className='flex items-center justify-between w-full gap-2'>
              <div className='flex min-w-0 items-baseline gap-2'>
                <div className='truncate text-xs font-medium text-foreground'>{botName}</div>
                {sentAt ? <ChatMessageTime sentAt={sentAt} /> : null}
              </div>
              {toggle}
            </div>
            {/* Text — no animation, stable */}
            {lastTextEntry &&
              lastTextEntry.kind === 'item' &&
              lastTextEntry.item.kind === 'assistant-text' &&
              lastTextEntry.item.text.trim() && (
                <Markdown text={lastTextEntry.item.text} />
              )}
            {/* Tool call — animate on changes */}
            {lastToolAfterText && lastToolAfterText.kind === 'tool' && (
              <div key={lastToolAfterText.id}>{renderTool(lastToolAfterText)}</div>
            )}
            {/* If no text entry found, show the very last entry */}
            {!lastTextEntry &&
              (() => {
                const last = entries[entries.length - 1]
                if (last?.kind === 'item') {
                  if (last.item.kind === 'tool') {
                    return renderTool(last.item)
                  }
                  if (last.item.kind === 'assistant-text') {
                    return last.item.text.trim() ? (
                      <Markdown text={last.item.text} />
                    ) : null
                  }
                }
                return null
              })()}
          </div>
        </Chained>
      </div>
    )
  }

  return (
    <div className='flex flex-col min-w-0 w-full relative' {...{ [BLOCK_ID_ATTR]: blockId }}>
      {entries.map((entry, i) => {
        const isFirst = i === 0
        const isLast = i === entries.length - 1
        const hasAvatar = isFirst && !!agentAvatar
        const marker = hasAvatar ? (
          <AgentAvatar avatar={agentAvatar} name={botName} size='md' />
        ) : (
          <ChainDot variant={entry.kind === 'item' ? toolDotVariant(entry.item) : 'default'} />
        )
        return (
          <Chained
            key={i}
            marker={marker}
            lineAbove={!isFirst}
            lineBelow={!isLast}
            align={hasAvatar ? 'start' : 'first-line'}
          >
            {renderEntry(
              entry,
              isFirst ? botName : undefined,
              isFirst ? toggle : undefined,
              isLast && pending,
              isFirst ? sentAt : undefined,
            )}
          </Chained>
        )
      })}
    </div>
  )
}
