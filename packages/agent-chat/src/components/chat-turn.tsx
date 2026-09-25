'use client'

import { Bot, ChevronDown, ChevronRight, Copy, Ellipsis, GitFork, ListTodo, Loader2, Maximize2, Minimize2, Pencil, Square, SquareCheck, TerminalSquare, X } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useState } from 'react'
// Both of these import types back from this file, and a type import is erased,
// so neither is a runtime cycle.
import { type AuthorRun, authorRuns } from './author-runs'
import { detailEntryKeys, withHeader } from './detail-entries'
import { Markdown } from './markdown'

import { SelectionBadge } from './selection-badge'

import { AgentAvatar } from 'ui/components/ui/media/agent-avatar'
import { Button } from 'ui/components/ui/button'
import { TypingDots } from 'ui/components/ui/chat/typing-dots'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from 'ui/components/ui/dropdown-menu'
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

// The attribute a host's jump-to-work control uses to find a subagent's or a
// background task's block in the transcript. Exported for the same reason as
// BLOCK_ID_ATTR: the host queries the name this file writes, never a second
// copy of the literal. The value is the entity's own id — a subagent's
// session id, a task's asyncTaskId.
export const WORK_ID_ATTR = 'data-work-id'

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

// One entry of the agent's plan checklist (ACP `plan` session update, as the
// host folds it — this component never learns the wire shape). `status` is the
// agent's own word; the three ACP spellings ('pending' | 'in_progress' |
// 'completed') get the intended drawing, anything else draws as pending.
export type PlanEntry = { content: string; status: string; priority: string }

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
  // `name` is what a reader is shown for the call — the agent's own human
  // phrasing, which for a file tool embeds the path ("Write src/app.tsx").
  // `toolName` is the PROGRAMMATIC name behind it ("Write"), carried separately
  // because a host that keys a view registry on the displayed name matches
  // nothing whose phrasing contains an argument, which is every file tool.
  // Absent when the agent named no tool.
  | {
      kind: 'tool'
      id: string
      name: string
      toolName?: string
      args: unknown
      result?: { text: string; isError?: boolean }
    }
  // The agent's live plan, as one checklist that the host patches in place —
  // every plan update replaces the entries wholesale, so this item is keyed by
  // its `id` (like a tool) rather than by position: entries come and go around
  // it without remounting the rest of the chain.
  | { kind: 'plan'; id: string; entries: PlanEntry[] }
  // A subagent the turn spawned, drawn as a nested, bordered block: its name
  // and task in a header with a live/terminal state badge, and its OWN reply
  // chain (`items`, built by the host the same way the parent's is) rendered
  // inside. `id` is the subagent's session id — its React key and identity.
  // The host pre-renders the nested items to DetailItem so this component never
  // learns the wire shape a subagent's transcript arrives in.
  | { kind: 'subagent'; id: string; name: string; task: string; state?: string; items: DetailItem[] }
  // A background task the harness reported under the turn (a detached job, a
  // loop), drawn as a single row in the same bordered family as a subagent.
  // Unlike a subagent it has no transcript — the fields ARE the whole of it.
  // `id` is the task's own id (its React key and identity); `state` is the
  // harness's word, with running/paused live and anything else terminal.
  // `onStop` is the host's stop-this-task call, already bound — present only
  // while stopping is offered, so the row draws a Stop control exactly when
  // pressing it can mean something.
  | {
      kind: 'task'
      id: string
      name: string
      description?: string
      summary?: string
      state: string
      onStop?: () => void
    }

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
//
// Dressed as the same centred divider the unread heading wears: both mark a
// boundary in the transcript (history beyond this point / messages not read
// yet), so they share one visual language instead of one being a divider and
// the other a stray button.
export function ChatLoadOlderButton({ loading, onLoadOlder }: { loading: boolean; onLoadOlder: () => void }) {
  return (
    <Button
      type='button'
      variant='ghost'
      className='h-auto w-full gap-2 px-0 py-1 text-xs font-medium text-muted-foreground'
      disabled={loading}
      onClick={onLoadOlder}
    >
      <span className='h-px min-w-6 flex-1 bg-border' />
      {loading ? 'Loading…' : 'Load Older Messages'}
      <span className='h-px min-w-6 flex-1 bg-border' />
    </Button>
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
// Who a message's stamped identifier resolved to.
//
// Named rather than written inline because a whole RUN of messages is drawn
// under one of these, so the run and the message it came from have to be
// talking about the same thing by construction rather than by two literals
// that happen to match today.
export interface ChatAuthorAccount {
  name: string
  avatarUrl?: string | null
}

// Something that travelled WITH a message and is not part of its words: a
// passage the reader had selected, a reference to whatever they were looking at.
//
// Presentation only, and the host's to resolve. This draws one chip per
// attachment; how it was attached, and what the agent actually received, is not
// visible from here and deliberately is not this component's business.
export interface MessageAttachment {
  // What the chip says. Short -- it truncates.
  label: string
  // The whole of what travelled, for a reader who would rather see it than be
  // told it exists. Optional, because a host may have nothing but the label.
  detail?: string
  // Where the picture can be drawn from, when what travelled was a picture.
  // Present makes this an image rather than a quotation, with `label` as its
  // alternative text; the host resolves it (a stored URL, typically), because
  // where pictures live is not this component's business either.
  src?: string
}

export interface ChatUserMessagePart {
  text: UserText
  author?: string
  authorAccount?: ChatAuthorAccount
  sentAt?: string
  // What travelled with this message besides its words, drawn as chips above
  // them. Absent or empty draws nothing, which is every message that carried
  // only words.
  attachments?: readonly MessageAttachment[]
  // A stable identity for this one message, where it has one.
  //
  // A message that has been sent does not: it is decoded out of a text that
  // cannot change, so its position IS its identity. A message still waiting to
  // be read does, because it can be taken back out of the middle of the turn it
  // is waiting in -- which is both what the remove control needs to name and
  // what stops React reusing the wrong row when one disappears.
  id?: string
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
  // Whether EDITING is refused right now — a running turn, typically. Editing
  // rewinds this conversation to the turn and re-runs it, which is a thing to
  // refuse while the agent is mid-turn.
  //
  // Deliberately not shared with the fork below. They are different acts and
  // one flag made them look like one: see `forkDisabled`.
  editDisabled?: boolean
  onEdit?: () => void
  // FORK the turn into a new conversation. Same turn-scoped rule as `onEdit`:
  // it belongs to the message that ends the turn, and unset means this
  // conversation offers no fork.
  onFork?: () => void
  // Whether FORKING is refused right now, which is almost never — and that is
  // the point of it being its own flag.
  //
  // A fork branches the conversation BEFORE this message, so what it copies is
  // a turn that has already finished; the turn running now is after the cut and
  // is not in the fork at all, delegated work included. Sharing `editDisabled`
  // greyed Fork out for the whole of every run, which is exactly when a reader
  // watching the agent go the wrong way wants to branch and try the other one.
  forkDisabled?: boolean
  // Take one message back before it is ever delivered, named by its own id.
  // Its button is always visible rather than revealed on hover -- hover is not
  // a route on a touch screen, and this is the only way to undo a send.
  //
  // Per message rather than per turn, because a turn that is still waiting is
  // the one case where its messages are still separable. The control appears
  // beside each part that carries an id, so a turn whose parts have none --
  // every turn already sent -- offers it nowhere.
  onRemove?: (id: string) => void
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
  forkDisabled,
  onEdit,
  onFork,
  onRemove,
  sticky,
  renderers,
}: ChatUserMessageProps) {
  const { Chained } = renderers

  // The turn's messages cut into runs of one sender, each of which gets ONE
  // rail segment below.
  //
  // Computed for THIS delivery only: a turn is a batch, and a batch opens with
  // a face whatever was said before it.
  const runs = authorRuns(parts)

  // The face for a run, or the space where one would be.
  //
  // THE ACCOUNT AND NOT THE IDENTIFIER, AND THAT IS NOT A GUARD AGAINST A
  // MISSING PROP. A face is drawn only where the run's opening message resolved
  // to an account -- because `AgentAvatar` with nothing to show falls through
  // to a generic person icon, and a person icon per sender change is a picture
  // of somebody standing in for every message this application cannot identify.
  // Unresolved has to stay visibly unresolved: the name renders as the text it
  // holds and no face appears, which is the state the design already has for
  // it.
  //
  // The population makes it concrete rather than theoretical: every author
  // stamped before accounts had handles resolves to nothing, so drawing a face
  // per run regardless would put an anonymous face on every run in every
  // transcript already written.
  //
  // The blank is the avatar's own size rather than nothing, so a run with no
  // face sits at the same left edge as one with it -- a rail that changed width
  // depending on whether the sender was known would read as a different kind of
  // thing rather than as the same conversation continuing.
  const markerFor = (run: AuthorRun) =>
    run.account ? (
      <AgentAvatar avatar={run.account.avatarUrl ?? undefined} name={run.account.name} size='md' />
    ) : (
      <span aria-hidden className='block size-8' />
    )

  // The remove control for one message, where there is one to offer.
  //
  // Both conditions are the same condition seen from two sides: only a message
  // that is still waiting can be taken back, and only a message that is still
  // waiting carries the id to name it by. So this returns nothing for every
  // part of every turn already in the transcript, without either side having to
  // know which kind of turn it is in.
  const removeFor = (part: ChatUserMessagePart) => {
    const id = part.id
    if (!onRemove || id === undefined) {
      return undefined
    }
    return () => onRemove(id)
  }

  const body = (
    // The same rail the replies below are rendered in, so both columns start at
    // the same left edge by construction rather than by a matched indent -- if
    // the rail's width changes, the two move together.
    <>
      {runs.map((run, runIndex) => {
        // Later messages supersede earlier ones -- the rule the agent is told
        // to read a turn by -- so the last message of the last run is the one
        // that stays behind as the header, and everything above it scrolls away
        // with the rest of the content.
        const isLastRun = runIndex === runs.length - 1
        const marker = markerFor(run)
        return (
          // ONE SEGMENT PER RUN, NOT PER MESSAGE. The rail column is a fixed
          // width OUTSIDE the content column and stretches to its segment's
          // height, so a segment spanning the whole run is what gives the face
          // both of the things it needs: a place in the rail that the messages
          // below it share, and a column taller than itself to travel in. A
          // segment per message gives the face to the opening message alone and
          // leaves every message after it holding an avatar-sized blank.
          //
          // Keyed by the opening message's own id where it has one, and by the
          // run's position otherwise. A turn already sent is decoded from a
          // text that cannot change, so nothing reorders and position IS
          // identity. One still waiting can have a message taken out of its
          // middle, and a positional key would renumber every run after the
          // hole; the id keeps the runs on either side of it matched to
          // themselves.
          //
          // WHAT IT DOES NOT BUY, since this key is per RUN and the shape it
          // replaced was per message: removing the message that OPENS a run
          // changes that run's key, so the run remounts. Nothing is lost by
          // that today because every row below is stateless. If one ever holds
          // state of its own -- an open menu, a selection, a transition in
          // flight -- this is where it would be dropped, and the key would have
          // to become something that survives its own first message going away.
          <Chained
            key={run.parts[0].id ?? runIndex}
            // Pinned rather than duplicated: the face holds the container's top
            // edge while its own run scrolls under it, so it is rendered once
            // and never fades. Placed in the cross-fade instead it would appear
            // out of nothing exactly as the message left, which is the kind of
            // thing a reader sees even when they could not say what happened.
            //
            // EVERY run's face, not only the last one's. The collapsing header
            // slides the whole turn past the container's edge, so a face that
            // let go the moment its own first message did would leave the rest
            // of its run passing unattributed -- which is the same defect as
            // drawing no face at all, arriving a scroll later.
            //
            // Only where the turn takes part in pinning: `sticky` is the caller
            // saying this render holds the viewport's top edge, and a queue
            // waiting below the transcript holds nothing.
            marker={sticky ? <CollapsingStickyHeaderPinned>{marker}</CollapsingStickyHeaderPinned> : marker}
            lineAbove={false}
            lineBelow={false}
            align='start'
          >
            {/* One voice speaking, so its messages stack at the bubble's own
                internal rhythm rather than at the distance between segments.
                That difference is what makes a run read as one block and the
                space before the next run read as a change of speaker -- and it
                is one value for both surfaces, so what is waiting to be read
                and what has been read cannot space themselves differently. */}
            <div className='flex min-w-0 flex-col gap-1.5'>
              {run.parts.map((part, partIndex) => {
                const handsOver = isLastRun && partIndex === run.parts.length - 1
                // The turn's menu rides the message that ends it, and offers
                // only what this conversation can do: edit and fork when the
                // host can serve them, copy whenever there are words.
                const turnMenu =
                  handsOver && (onEdit || onFork) ? (
                    <MessageMenu
                      editDisabled={editDisabled}
                      forkDisabled={forkDisabled}
                      onEdit={onEdit}
                      onFork={onFork}
                      copyText={part.text}
                    />
                  ) : null
                return (
                  // The turn's actions — edit, copy, fork — belong to the
                  // message that ends it, and live in that message's own
                  // header; remove belongs to a message and so is asked for
                  // per part, here as everywhere else.
                  <MessageRow key={part.id ?? partIndex} onRemove={removeFor(part)}>
                    {handsOver && sticky ? (
                      // The last message is the one that hands over: its full
                      // form scrolls away like ordinary content, its opening
                      // three lines stay behind, and the two cross only in the
                      // final stretch. That wait is the point -- a message
                      // taller than the screen is read rather than shrunk out
                      // from under the reader.
                      <CollapsingStickyHeaderContent preview={<UserMessageBubble part={part} preview />}>
                        <UserMessageBubble part={part} menu={turnMenu} />
                      </CollapsingStickyHeaderContent>
                    ) : (
                      <UserMessageBubble part={part} menu={turnMenu} />
                    )}
                  </MessageRow>
                )
              })}
            </div>
          </Chained>
        )
      })}
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

// One message's row: its bubble, and the controls that act on it.
//
// Every part of every turn renders through this, so a message in the middle of
// a turn and the one that ends it are the same row with the same geometry. They
// used to be two shapes -- a bare bubble for the earlier ones, a bubble in a
// flex column beside a control strip for the last -- which meant the width a
// message got depended on its position in its own turn.
//
// The turn's actions live INSIDE the bubble's own header (see UserMessageBubble's
// `menu` slot) rather than in a strip beside it; this row keeps the one control
// that is not the bubble's to draw -- remove, which acts on a message still
// waiting and is asked for per part.
function MessageRow({
  onRemove,
  children,
}: {
  onRemove?: () => void
  children: ReactNode
}) {
  return (
    <div className='flex items-start group w-full gap-1'>
      <div className='flex min-w-0 flex-1 flex-col gap-1.5'>{children}</div>
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
  )
}

// The turn's action menu, rendered in the bubble header where the send time
// used to sit: edit, copy the words, fork the conversation here. The trigger is
// always visible, not hover-revealed: a control that only appears under a
// pointer is invisible to a touch screen, which is exactly the surface a
// message menu is most useful on. Copy is never disabled: reading your own
// words back is not a turn-scoped act, and a menu where every item greys out
// because the agent is busy would take the one useful thing away with the rest.
function MessageMenu({
  onEdit,
  editDisabled,
  onFork,
  forkDisabled,
  copyText,
}: {
  onEdit?: () => void
  editDisabled?: boolean
  onFork?: () => void
  forkDisabled?: boolean
  copyText?: UserText
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type='button'
            size='icon'
            variant='ghost'
            className='h-5 w-5 shrink-0'
            title='Message actions'
            aria-label='Message actions'
          />
        }
      >
        <Ellipsis className='size-3.5' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end' className='w-auto min-w-36'>
        {onEdit && (
          <DropdownMenuItem onClick={onEdit} disabled={editDisabled}>
            <Pencil className='size-3.5' />
            Edit
          </DropdownMenuItem>
        )}
        {copyText && (
          <DropdownMenuItem onClick={() => void navigator.clipboard.writeText(copyText)}>
            <Copy className='size-3.5' />
            Copy Text
          </DropdownMenuItem>
        )}
        {onFork && (
          <DropdownMenuItem onClick={onFork} disabled={forkDisabled}>
            <GitFork className='size-3.5' />
            Fork
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  menu,
}: {
  part: ChatUserMessagePart
  // True for the short form that stays behind once the turn has slid away: the
  // same bubble, clamped to its opening lines. It is a second rendering rather
  // than a state of the first, so neither one's height ever depends on how far
  // the slide has gone.
  preview?: boolean
  // The turn's action menu (edit / copy / fork), rendered in the header's right
  // slot. Omitted for the preview form, which is a clamped look at a message
  // whose real, interactive self is somewhere else.
  menu?: ReactNode
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
      {(part.author || part.authorAccount || part.sentAt || menu) && (
        // Who sent it and when, together at the left; the turn's action menu
        // at the right, in the slot the send time used to hold alone.
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
          <span className='flex min-w-0 items-center gap-2'>
            {part.authorAccount ? (
              <span className='min-w-0 truncate text-xs font-medium text-foreground'>{part.authorAccount.name}</span>
            ) : part.author ? (
              <span className='min-w-0 truncate text-xs font-medium text-muted-foreground'>{part.author}</span>
            ) : null}
            {part.sentAt ? <ChatMessageTime sentAt={part.sentAt} /> : null}
          </span>
          {menu}
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
      {!preview && part.attachments?.length ? (
        // ABOVE THE WORDS, which is where it was when the message was written:
        // a composer's attachments row sits above the box being typed into, so
        // the message is read in the order it was composed.
        //
        // QUOTATIONS STACKED, PICTURES SIDE BY SIDE. Each quotation has a rule
        // down its left, and quotations set beside one another read as columns
        // of a table rather than as separate things that were carried -- so
        // they stack, which also keeps a long one from squeezing its neighbour
        // to a few characters. Pictures carry no such rule and read as a row of
        // pictures, which is what the composer showed when they were picked.
        //
        // Left out of the collapsed form deliberately. That form is the opening
        // few LINES of the message, kept short so a tall question cannot cover
        // the reply it belongs to -- and quoted context is neither its words nor
        // a line of them.
        <div className='flex min-w-0 flex-col gap-1'>
          {part.attachments.some((attachment) => attachment.src) ? (
            <div className='flex min-w-0 flex-wrap gap-1'>
              {part.attachments.map((attachment, index) =>
                attachment.src ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: see the quotation key below -- the same reasoning, the same list.
                  <SentPicture key={index} src={attachment.src} name={attachment.label} />
                ) : null,
              )}
            </div>
          ) : null}
          {part.attachments.map((attachment, index) =>
            attachment.src ? null : (
              // The same component the composer quotes the live selection with,
              // rendering the same way: here it is a record, and what makes it one
              // is that the message has already gone, not a flag on the element.
              // There is no control in it to leave unwired.
              <SelectionBadge
                // biome-ignore lint/suspicious/noArrayIndexKey: a delivered message's attachments are decoded out of a text that cannot change, so nothing here reorders, is inserted or is removed -- position IS the identity, and there is no id to key on instead. What would retire this suppression: attachments becoming editable after delivery, or arriving carrying an identity of their own. Either one makes position stop being identity, and the key then has to become that identity rather than this comment being widened.
                key={index}
                label={attachment.label}
                // Everything the quotation is not told to name itself is spread
                // onto it, so the whole of what travelled reaches the reader
                // through the ordinary title attribute rather than a prop of its
                // own.
                title={attachment.detail ?? attachment.label}
              />
            ),
          )}
        </div>
      ) : null}
      <Markdown text={part.text} className={preview ? 'line-clamp-3' : undefined} />
    </div>
  )
}

// A picture a message carried, drawn as the picture.
//
// THE IMAGE, NOT ITS NAME. A reader who sent a screenshot recognises it by
// looking at it; `Screenshot 2026-09-22 at 02.14.png` tells them nothing the
// picture does not. The name is still there -- alternative text and tooltip --
// for anything that does not render images.
//
// Bounded in height so a tall screenshot does not push the conversation off
// the screen, and a link to the whole of it for a reader who wants detail.
//
// A picture that cannot be drawn -- its bytes gone, or a host that answered
// with nothing -- falls back to the quotation with its name, so the message
// still says something travelled rather than showing a broken image.
function SentPicture({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <SelectionBadge label={name} title={name} />
  }
  return (
    <a href={src} target='_blank' rel='noopener noreferrer' title={name} className='block max-w-full shrink-0'>
      <img
        src={src}
        alt={name}
        loading='lazy'
        onError={() => setFailed(true)}
        className='block max-h-48 max-w-full rounded-md border bg-muted object-contain'
      />
    </a>
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

// The agent's plan as one checklist. Not interactive — the agent owns the list
// and rewrites it wholesale on every update; the reader only watches it. The
// whole point of the drawing is the frontier: done entries strike through, the
// one in progress spins, the rest wait.
function PlanChecklist({ item }: { item: Extract<DetailItem, { kind: 'plan' }> }) {
  return (
    <div className='rounded-md border border-border/60 bg-muted/20 px-3 py-2'>
      <div className='flex items-center gap-1.5 text-xs font-medium text-muted-foreground'>
        <ListTodo className='size-3.5' />
        Plan
      </div>
      <ul className='mt-1.5 flex flex-col gap-1'>
        {item.entries.map((entry, i) => {
          const completed = entry.status === 'completed'
          const inProgress = entry.status === 'in_progress'
          return (
            // Position is the only identity a plan entry has: the agent
            // rewrites the list wholesale and may repeat a line of text, so
            // neither the content nor anything else on the entry can serve as
            // a stable key. The same deliberate index key the nested-subagent
            // renderers below use for host-built, wholesale-replaced lists.
            // biome-ignore lint/suspicious/noArrayIndexKey: plan entries carry no id and their text may repeat
            <li key={i} className='flex items-start gap-2 text-sm leading-5'>
              {completed ? (
                <SquareCheck className='mt-0.5 size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
              ) : inProgress ? (
                <Loader2 className='mt-0.5 size-3.5 shrink-0 animate-spin text-primary' />
              ) : (
                <Square className='mt-0.5 size-3.5 shrink-0 text-muted-foreground/60' />
              )}
              <span className={cn('min-w-0', completed && 'text-muted-foreground line-through')}>{entry.content}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// A subagent's nested transcript, in a bordered block under the parent turn.
// Renders its own items with the SAME per-kind renderers the parent uses
// (text as markdown, thinking via the host's block, tool via renderTool), one
// level deep — a subagent that itself spawns a subagent nests again through
// this same component. Live subagents show a pulsing badge; a terminal one
// shows its outcome.
function SubagentBlock({
  item,
  renderTool,
  renderers,
}: {
  item: Extract<DetailItem, { kind: 'subagent' }>
  renderTool: (item: Extract<DetailItem, { kind: 'tool' }>) => ReactNode
  renderers: ChatTurnRenderers
}) {
  const { ThinkingBlock } = renderers
  const live = item.state === undefined
  // Subagent blocks start collapsed by default, live or finished — the
  // chat stays scannable when several are spawned at once. Initial value
  // only: expanding is a manual, one-way action from here, so a block the
  // reader opened to watch must not snap shut when its subagent completes.
  const [open, setOpen] = useState(false)
  const badge = live ? 'running' : item.state
  const badgeClass = live
    ? 'bg-primary/10 text-primary animate-pulse'
    : item.state === 'completed'
      ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
      : 'bg-muted text-muted-foreground'
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    // Marked with the subagent's id so a host's jump-to-work control can find
    // this block in the DOM — same mechanism as BLOCK_ID_ATTR, one level down.
    <div className='rounded-md border border-border/60 bg-muted/20' {...{ [WORK_ID_ATTR]: item.id }}>
      {/* The whole header is the toggle — a chevron-sized target fails on
          touch, and the header row carries nothing else pressable. */}
      <button
        type='button'
        onClick={() => setOpen((value) => !value)}
        className='flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-accent/40'
        title={open ? 'Collapse subagent' : 'Expand subagent'}
      >
        <Chevron className='size-3.5 shrink-0 text-muted-foreground' />
        <Bot className='size-3.5 shrink-0 text-muted-foreground' />
        {/* Title, then the working dots while it runs, then everything else
            pushed to the right: the step count and the status badge. */}
        <span className='truncate text-xs font-medium text-foreground'>{item.name || 'Subagent'}</span>
        {live ? <TypingDots className='shrink-0' variant='primary' size='sm' /> : null}
        {item.items.length > 0 ? (
          <span className='ml-auto shrink-0 text-[10px] text-muted-foreground'>
            {item.items.length} step{item.items.length === 1 ? '' : 's'}
          </span>
        ) : null}
        <span
          className={`${item.items.length > 0 ? '' : 'ml-auto '}shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeClass}`}
        >
          {badge}
        </span>
      </button>
      {open && item.task ? <div className='px-3 pb-2 text-xs text-muted-foreground'>{item.task}</div> : null}
      {open && item.items.length > 0 ? (
        <div className='flex flex-col gap-2 border-t border-border/40 px-3 py-2'>
          {item.items.map((child, i) => {
            if (child.kind === 'assistant-text') {
              return child.text.trim() ? <Markdown key={i} text={child.text} /> : null
            }
            if (child.kind === 'thinking') {
              return <ThinkingBlock key={i} text={child.text} />
            }
            if (child.kind === 'subagent') {
              return <SubagentBlock key={child.id} item={child} renderTool={renderTool} renderers={renderers} />
            }
            if (child.kind === 'plan') {
              return <PlanChecklist key={child.id} item={child} />
            }
            if (child.kind === 'task') {
              return <TaskBlock key={child.id} item={child} />
            }
            return <div key={child.id}>{renderTool(child)}</div>
          })}
        </div>
      ) : null}
    </div>
  )
}

// A background task's row, in the same bordered family as SubagentBlock. Not
// collapsible: a task has no transcript to fold away, so the row is the whole
// block — name and state on the header line, the latest summary (or the
// standing description) beneath it. The badge palette is SubagentBlock's, plus
// a paused colour of its own: paused is live work someone chose to hold, which
// is neither running nor an outcome.
function TaskBlock({ item }: { item: Extract<DetailItem, { kind: 'task' }> }) {
  const running = item.state === 'running'
  const badgeClass = running
    ? 'bg-primary/10 text-primary animate-pulse'
    : item.state === 'paused'
      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
      : item.state === 'completed'
        ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
        : 'bg-muted text-muted-foreground'
  // The freshest line wins: a summary is the harness talking about now, the
  // description is what the task was asked to be.
  const detail = item.summary || item.description
  return (
    // Marked with the task's id so a host's jump-to-work control can find
    // this block in the DOM — the same contract SubagentBlock carries.
    <div className='rounded-md border border-border/60 bg-muted/20 px-3 py-2' {...{ [WORK_ID_ATTR]: item.id }}>
      <div className='flex w-full items-center gap-2'>
        <TerminalSquare className='size-3.5 shrink-0 text-muted-foreground' />
        <span className='truncate text-xs font-medium text-foreground'>{item.name || 'Task'}</span>
        {running ? <Loader2 className='size-3.5 shrink-0 animate-spin text-primary' /> : null}
        <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${badgeClass}`}>
          {item.state}
        </span>
        {item.onStop ? (
          <Button variant='ghost' size='sm' className='h-6 shrink-0 gap-1 px-2 text-[11px]' onClick={item.onStop}>
            <Square className='size-3' />
            Stop
          </Button>
        ) : null}
      </div>
      {detail ? <div className='mt-1 truncate text-xs text-muted-foreground'>{detail}</div> : null}
    </div>
  )
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
  // Not the entry's own position: `withHeader` prepends conditionally, so that
  // position shifts by one the moment the first item's kind changes. The
  // reasoning, and what this deliberately does not cover, is where the
  // derivation lives.
  const entryKeys = detailEntryKeys(entries, items)

  // Offered for any turn with something to hide. `> 1` alone missed the turn
  // whose single item is a subagent — the largest block a turn can carry, and
  // the one the reader most wants to fold away.
  const toggle =
    items.length > 1 || items.some((item) => item.kind === 'subagent') ? (
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
    if (item.kind === 'subagent') {
      return <SubagentBlock item={item} renderTool={renderTool} renderers={renderers} />
    }
    if (item.kind === 'plan') {
      return <PlanChecklist item={item} />
    }
    if (item.kind === 'task') {
      return <TaskBlock item={item} />
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
                  if (last.item.kind === 'plan') {
                    // The plan is present-tense state: even folded away, a
                    // collapsed turn still shows where the agent stands.
                    return <PlanChecklist item={last.item} />
                  }
                  if (last.item.kind === 'task') {
                    // Present-tense for the same reason as the plan: a task
                    // that is still running is what the agent is doing NOW,
                    // and its Stop control must not fold away with the rest.
                    return <TaskBlock item={last.item} />
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
            key={entryKeys[i]}
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
