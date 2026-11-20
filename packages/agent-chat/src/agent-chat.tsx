'use client'

import type { ReactNode, RefObject } from 'react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Flex } from 'ui/components/ui/layout/flex'
import { LogoLoader } from 'ui/components/ui/logo-loader'

import type { AgentComposerHandle } from './agent-command-bar'
import { type Block, ChatConversation, type ChatConversationHandle } from './components/chat-conversation'
import { ChatEmptyState } from './components/chat-empty-state'
import {
  ChatNotice,
  type ChatTurnRenderers,
  ChatUserMessage,
  type ChatUserMessagePart,
  type DetailItem,
  type UserText,
} from './components/chat-turn'
import { ChatUnread, type ChatUnreadMessage } from './components/chat-unread'
import { MessageActionsProvider, MessageSelectionBar } from './components/message-selection-bar'
import { appendQuotedReply } from './message-quote'
import type { AgentChatSession } from './session'
import { ThinkingIndicator } from './thinking-indicator'

export type { AgentChatSession } from './session'
export type { Block, ChatUnreadMessage, DetailItem, UserText }

// The Pick of the named session-shape contract (session.ts) this component
// actually reads — not the host's full session controller, and not even the
// whole contract: `permissions`/`asks`/the resolve callbacks belong to
// approvals.tsx's own Pick, not this component's, since AgentChat never
// touches them. A host's own richer session type structurally satisfies this
// without a wrapper, since it already carries every field the full contract
// documents. `messages`/`historyHeader` are absent from the full contract
// itself (not merely un-Picked here): turning those into a transcript is the
// host's own message-processing pipeline (e.g. stripping host-specific tags
// before a user message renders), so the host builds `blocks` itself and
// hands them in, the same way `ChatConversation` (one layer down) already
// takes blocks rather than raw messages.
type AgentChatCoreSession = Pick<
  AgentChatSession,
  | 'sessionKey'
  | 'loading'
  | 'sending'
  | 'waiting'
  | 'thinking'
  | 'botName'
  | 'send'
  | 'stop'
  | 'canFork'
  | 'editMessage'
  | 'forkMessage'
  | 'draft'
  | 'notice'
  | 'starting'
  | 'disabled'
  | 'hasMoreHistory'
  | 'loadingMoreHistory'
  | 'loadMoreHistory'
>

export interface AgentChatProps {
  session: AgentChatCoreSession
  // The transcript, already folded from the host's own message log — see
  // AgentChatCoreSession's own note above on why this isn't computed here.
  blocks: readonly Block[]
  // Whether the session has exchanged anything at all, which is NOT the same
  // question as `blocks.length > 0`: a message made entirely of content the
  // host strips before rendering produces zero blocks but is still a real
  // exchange, and the empty-state copy should say so correctly.
  hasMessages: boolean
  // The sticky header for a turn the loaded window starts inside (see
  // ChatConversation's own `historyHeaderText`) — the host resolves it
  // alongside `blocks`, from the same source.
  historyHeaderParts?: readonly ChatUserMessagePart[]
  emptyText?: string
  agentAvatar?: string
  agentName?: string
  // When true, chains render expanded (full detail) by default instead of the
  // collapsed last-message-only view.
  defaultExpanded?: boolean
  // The typing indicator shown at the foot of the message list while a turn
  // runs. On by default, because a conversation with no other activity
  // affordance needs it.
  //
  // A host that pins its own activity indication OUTSIDE the scroll region
  // turns this off, and should: the two say the same thing, so leaving both on
  // shows a reader at the bottom of the transcript the same fact twice.
  showThinkingIndicator?: boolean
  // A registered tool view renders in place of the generic block (e.g. a real
  // diff instead of a raw args dump) — which views exist is the host's own
  // registry, so it is passed in rather than known by this component. Must be
  // an identity-stable reference (a module-level function, or memoized) —
  // this flows straight into ChatConversation's own renderTool prop, and a
  // fresh function every render defeats the memoization this component and
  // ChatConversation both rely on to keep the transcript from re-rendering
  // (and, worse, remounting mid-turn) on every unrelated state change.
  renderTool: (item: Extract<DetailItem, { kind: 'tool' }>) => ReactNode
  // The chain/thinking-block renderers `ChatConversation` renders a turn
  // with — supplied by the host so this component never needs its own copy.
  // Same identity-stability requirement as `renderTool` above, for the same
  // reason: a module-level constant (see this app's CHAT_RENDERERS), never
  // an object literal built inline in a render.
  renderers: ChatTurnRenderers
  // Messages that have arrived but the agent has not read yet, already
  // formatted to display text — a host with its own outgoing-text transform
  // undoes it first, the same way it hands over pre-built `blocks` rather than
  // raw messages. They render at the foot of the transcript, after the activity
  // indicator: what the agent is doing now comes before what it has not got to
  // yet.
  unread?: readonly ChatUnreadMessage[]
  // Take one of them back before it is delivered. Without it no remove control
  // is offered, which is what a host that can show what is waiting but not edit
  // it wants.
  onRemoveUnread?: (id: string) => void
  // Deliver everything waiting, now, rather than at the session's cadence.
  // Without it the unread heading is only a heading, which is what a host
  // without a way to hand the queue over wants.
  onDeliverUnread?: () => void
  // Messages the reader sent that the server does not hold yet, in the order
  // sent, each with its own `id` and `delivery`: sending (a spinner by its
  // time) or failed (the error notice under it). They render last, below
  // anything unread, because each is the newest thing the reader did. The host
  // drops one in the same render its own record of it -- a queue entry or a
  // delivered turn -- appears, so a message is never on screen twice or not
  // at all.
  outgoing?: readonly ChatUserMessagePart[]
  // Send a failed one again, and drop one, by its id. Without them a failed
  // message's notice offers no control.
  onRetryOutgoing?: (id: string) => void
  onDiscardOutgoing?: (id: string) => void
  // Extra content rendered in the footer alongside the thinking indicator —
  // a host-specific status indicator (e.g. a voice playback visualizer) with
  // nowhere else in this component's own contract to live.
  footerExtra?: ReactNode
  // The composer this conversation replies into -- the same ref the host hands
  // `useAgentCommandBar`. With it every message's menu offers Reply, which
  // quotes the message at the end of the composer, and text selected in a
  // message gets a selection bar with Reply for the selected part; without it
  // there is no Reply.
  composerRef?: RefObject<AgentComposerHandle | null>
  // Open the conversation at a turn instead of at its end: older history is
  // loaded until a block with one of these ids is rendered, and its turn is
  // scrolled to the top. Several ids because a turn renders as its question
  // or, when that renders nothing, as its replies -- the host names both.
  // A new object is a new request; the same object is never acted on twice.
  reveal?: AgentChatReveal | null
}

export interface AgentChatReveal {
  blockIds: readonly string[]
  // Told once per request: whether the turn was found, or the history ran out
  // without it.
  onSettled?: (found: boolean) => void
}

export function AgentChat({
  session,
  blocks,
  hasMessages,
  historyHeaderParts,
  emptyText,
  agentAvatar,
  agentName,
  defaultExpanded,
  showThinkingIndicator = true,
  renderTool,
  renderers,
  unread,
  onRemoveUnread,
  onDeliverUnread,
  outgoing,
  onRetryOutgoing,
  onDiscardOutgoing,
  footerExtra,
  composerRef,
  reveal,
}: AgentChatProps) {
  const displayName = agentName ?? session.botName
  // Provided around both renderings below, since unread messages show in the
  // panel state too. Memoized: every message in the transcript reads it.
  const messageActions = useMemo(
    () =>
      composerRef
        ? { onReply: (text: string) => composerRef.current?.update((current) => appendQuotedReply(current, text)) }
        : {},
    [composerRef],
  )
  // Editing is keyed on the block's own id, which the host assigned and can
  // resolve against its whole conversation. Nothing is derived from a position
  // in `blocks` here: that array is a bounded tail, so a position in it is not
  // an identity -- counting user blocks inside it produced an index that meant
  // one turn in a freshly opened chat and a different, older one as soon as
  // history had been loaded.
  const onEditUser = session.canFork === true ? session.editMessage : undefined
  // Fork is offered only where the host can name a destination for it — the
  // same agent capability gate as editing, on top of a handler the host sets.
  const onForkUser = session.canFork === true ? session.forkMessage : undefined

  // Whether to fetch more history, and running the fetch, are the host's own
  // decision — this component only holds the reader's place while whatever
  // operation is handed to it runs.
  const conversationRef = useRef<ChatConversationHandle>(null)
  const loadOlder = useCallback(() => {
    if (session.hasMoreHistory !== true || session.loadingMoreHistory === true) {
      return
    }
    conversationRef.current?.holdAcrossLoadOlder(() => session.loadMoreHistory?.())
  }, [session])

  // One step of a reveal per commit: reveal the turn if it has rendered, else
  // fetch the next older page, else report that the history ran out. Paged
  // without a hold -- nothing the reader is looking at needs keeping, since
  // the view moves to the turn the moment it arrives.
  const settledRevealRef = useRef<AgentChatReveal | null>(null)
  // Set from the call until its page has landed: the host's own loading flag
  // only turns on at its next render, and a commit in between must not fetch
  // the same page a second time. Clearing it is a render of its own, since the
  // page's commit can land while it is still set.
  const revealPagingRef = useRef(false)
  const [revealPages, setRevealPages] = useState(0)
  // biome-ignore lint/correctness/useExhaustiveDependencies(revealPages): a finished page is a reason to take the next step, not something the body reads
  useLayoutEffect(() => {
    if (!reveal || settledRevealRef.current === reveal || session.loading) {
      return
    }
    const rendered = reveal.blockIds.find((id) => blocks.some((block) => block.id === id))
    if (rendered !== undefined && conversationRef.current?.revealBlock(rendered)) {
      settledRevealRef.current = reveal
      reveal.onSettled?.(true)
      return
    }
    if (revealPagingRef.current || session.loadingMoreHistory === true) {
      return
    }
    if (session.hasMoreHistory === true && session.loadMoreHistory) {
      revealPagingRef.current = true
      void Promise.resolve(session.loadMoreHistory()).finally(() => {
        revealPagingRef.current = false
        setRevealPages((pages) => pages + 1)
      })
      return
    }
    settledRevealRef.current = reveal
    reveal.onSettled?.(false)
  }, [reveal, blocks, session, revealPages])

  // A session being started is waited on with the product's own loader, the
  // logo, as anything else that is loading is: the agent is not working on the
  // reader's message yet, so the working indicator would say too much. Over an
  // empty conversation it is the panel's state. Under a transcript already on
  // screen it takes the indicator's place only for a start that carries
  // nothing of the reader's (Try again on a start that failed): a start a
  // send set off is told by that message's own spinner, in the conversation
  // the reader is already reading, rather than by a loader as if it were
  // being opened.
  const starting = session.starting === true
  const working = starting || (session.thinking ?? session.waiting)
  const sending = (outgoing?.length ?? 0) > 0
  // Only a message still on its way speaks for the start; one that failed is
  // told by its notice, and a start after it (Try again) gets the loader.
  const startCarried = outgoing?.some((part) => part.delivery?.state === 'sending') === true
  const empty = !hasMessages && (unread?.length ?? 0) === 0
  const loading = session.loading || (starting && empty)
  const footer = (
    <>
      {starting && !loading && !startCarried ? (
        <Flex align='center'>
          <LogoLoader size={40} className='text-foreground' />
        </Flex>
      ) : null}
      {/* Not under the panel's loader either: one loader at a time. A message
          held across the open is waited on by that loader until the history
          is in. */}
      {showThinkingIndicator && working && !starting && !loading && <ThinkingIndicator />}
      {/* Unconditional: the section renders nothing with nothing waiting, so
          guarding it here would only duplicate a check it already makes. */}
      <ChatUnread messages={unread ?? []} onRemove={onRemoveUnread} onDeliver={onDeliverUnread} renderers={renderers} />
      {/* Below what is unread: a message the server takes into the queue
          joins the end of it, the row just above, so taking it moves nothing
          but the heading a first queued message brings. One turn, like the
          queue, so a run of sends draws one face. */}
      {outgoing && outgoing.length > 0 ? (
        <ChatUserMessage
          parts={outgoing}
          onRetry={onRetryOutgoing}
          onDiscard={onDiscardOutgoing}
          renderers={renderers}
        />
      ) : null}
      {/* Last in the transcript, under the turn it is about and above
          anything the host adds: it is the newest thing that happened. */}
      {session.notice ? <ChatNotice item={{ kind: 'notice', severity: 'error', ...session.notice }} /> : null}
      {footerExtra}
    </>
  )

  // Loading and empty are PANEL states, not transcript states: the reader is
  // between conversations or waiting for one to load, not sitting at the
  // bottom of a short one. ChatConversation renders its own placeholders
  // inside its bottom-anchored region, which is the right placement when the
  // transcript IS the panel; the app's chat panels wrap the conversation in a
  // scroll region pinned to the composer, and there a placeholder inside the
  // region lands at the bottom with the transcript it stands in for. Rendered
  // here instead, the state fills the region the host gives this component
  // and centres in it. The footer still renders beneath, so a queue arriving
  // mid-load keeps its divider and the deliver affordance.
  //
  // A running turn or a notice in an empty conversation is not "no messages
  // yet": the panel stays blank above the footer that carries them. A running
  // turn with nothing in the transcript is a just-started session whose
  // history ended before the reader's first message came back.
  const panelState = loading ? (
    <LogoLoader size={40} className='text-foreground' />
  ) : empty && !sending && !working && !session.waiting && !session.notice ? (
    <ChatEmptyState text={emptyText ?? 'No messages yet'} />
  ) : null

  if (panelState || empty) {
    return (
      <MessageActionsProvider value={messageActions}>
        <MessageSelectionBar>
          <div className='flex min-h-0 min-w-0 flex-1 flex-col'>
            <div className='flex flex-1 items-center justify-center p-4'>{panelState}</div>
            {/* The conversation's own inset and spacing (Chat Conversation's
                column), so a notice or the indicator under an empty panel
                sits where it would under a transcript, not against the edges. */}
            <Flex className='min-w-0 gap-3 px-4 pb-4'>{footer}</Flex>
          </div>
        </MessageSelectionBar>
      </MessageActionsProvider>
    )
  }

  return (
    <MessageActionsProvider value={messageActions}>
      <MessageSelectionBar>
        <ChatConversation
          ref={conversationRef}
          sessionKey={session.sessionKey}
          blocks={blocks}
          hasMessages={hasMessages}
          hasUndelivered={(unread?.length ?? 0) > 0 || sending}
          loading={loading}
          emptyText={emptyText}
          waiting={session.waiting}
          historyHeaderParts={historyHeaderParts}
          hasMoreHistory={session.hasMoreHistory === true}
          loadingMoreHistory={session.loadingMoreHistory === true}
          onLoadOlder={loadOlder}
          onEditUser={onEditUser}
          onForkUser={onForkUser}
          defaultExpanded={defaultExpanded}
          botName={displayName}
          agentAvatar={agentAvatar}
          renderers={renderers}
          renderTool={renderTool}
          footer={footer}
        />
      </MessageSelectionBar>
    </MessageActionsProvider>
  )
}
