'use client'

import type { ReactNode } from 'react'
import { useCallback, useMemo, useRef } from 'react'
import { type Block, ChatConversation, type ChatConversationHandle } from 'ui/agent-chat/chat-conversation'
import type { ChatTurnRenderers, DetailItem, UserText } from 'ui/agent-chat/chat-turn'

import type { AgentChatSession } from './session'
import { ThinkingIndicator } from './thinking-indicator'

export type { AgentChatSession } from './session'
export type { Block, DetailItem, UserText }

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
  | 'botName'
  | 'send'
  | 'stop'
  | 'canFork'
  | 'editMessage'
  | 'draft'
  | 'sendError'
  | 'dismissSendError'
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
  historyHeaderText?: UserText | null
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
  // Extra content rendered in the footer alongside the thinking indicator —
  // a host-specific status indicator (e.g. a voice playback visualizer) with
  // nowhere else in this component's own contract to live.
  footerExtra?: ReactNode
}

export function AgentChat({
  session,
  blocks,
  hasMessages,
  historyHeaderText,
  emptyText,
  agentAvatar,
  agentName,
  defaultExpanded,
  showThinkingIndicator = true,
  renderTool,
  renderers,
  footerExtra,
}: AgentChatProps) {
  const displayName = agentName ?? session.botName
  // 0-based user-turn index per user block, so "fork from here" rewinds to it.
  // Keyed by the block's position in `blocks` — the same position the kit
  // component reports back through `onEditUser`.
  const turnByBlock = useMemo(() => {
    const map = new Map<number, number>()
    let turn = -1
    blocks.forEach((block, index) => {
      if (block.kind === 'user') {
        turn += 1
        map.set(index, turn)
      }
    })
    return map
  }, [blocks])
  const edit = session.canFork === true ? session.editMessage : undefined
  const onEditUser = useMemo(
    () =>
      edit ? (absoluteIndex: number, text: UserText) => edit(turnByBlock.get(absoluteIndex) ?? 0, text) : undefined,
    [edit, turnByBlock],
  )

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

  return (
    <ChatConversation
      ref={conversationRef}
      sessionKey={session.sessionKey}
      blocks={blocks}
      hasMessages={hasMessages}
      loading={session.loading}
      emptyText={emptyText}
      waiting={session.waiting}
      historyHeaderText={historyHeaderText}
      hasMoreHistory={session.hasMoreHistory === true}
      loadingMoreHistory={session.loadingMoreHistory === true}
      onLoadOlder={loadOlder}
      onEditUser={onEditUser}
      defaultExpanded={defaultExpanded}
      botName={displayName}
      agentAvatar={agentAvatar}
      renderers={renderers}
      renderTool={renderTool}
      footer={
        <>
          {showThinkingIndicator && session.waiting && <ThinkingIndicator />}
          {footerExtra}
        </>
      }
    />
  )
}
