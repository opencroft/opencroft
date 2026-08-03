'use client'

import { ChainDot, Chained } from 'agent-chat/chain'
import { ThinkingBlock } from 'agent-chat/thinking-block'
import { type ComponentType, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Block, ChatConversation, type ChatConversationHandle } from 'ui/agent-chat/chat-conversation'
import type { ChatTurnRenderers, DetailItem as KitDetailItem } from 'ui/agent-chat/chat-turn'
import { TypingDots } from 'ui/chat/typing-dots'
import { Flex } from 'ui/layout/flex'

import { buildBlocks, type UserText } from '@/app/(agent)/_lib/build-blocks'
import type { ChatMessage } from '@/app/(agent)/_lib/messages'
import { loadAllExtensions } from '@/app/(extension-runtime)/_client/loader'
import { useProvided } from '@/app/(extension-runtime)/_client/provides'
import { GenericToolView } from '@/components/tool-views/builtin-views'
import { lookupToolView } from '@/components/tool-views/registry'

// The rail and the thinking block the installed conversation renders with.
// They stay the package's copies deliberately: `ui` sits below `agent-chat`, so
// the kit component cannot import them, and both exist in two implementations
// today — supplying them here is what keeps one conversation from mixing the
// two. Module-level so the reference is stable across renders.
const CHAT_RENDERERS: ChatTurnRenderers = { Chained, ChainDot, ThinkingBlock }

// A registered tool view (see components/tool-views) renders in place of the
// generic block, giving e.g. remote_edit/edit_node_property a real diff instead
// of a raw args dump. Falls back to the same chrome without a target line
// otherwise (e.g. an external MCP server's tool, with no node/handle to point
// at). Which views exist is this application's registry, so it is passed in
// rather than known by the component.
function renderToolCall(item: Extract<KitDetailItem, { kind: 'tool' }>) {
  const spec = lookupToolView(item.name)
  const args = (item.args ?? {}) as Record<string, unknown>
  if (spec) {
    const ViewComponent = spec.body
    return <ViewComponent tool={item.name} args={args} requestId={item.id} mode='history' result={item.result} />
  }
  return <GenericToolView tool={item.name} args={args} result={item.result} />
}

export interface AgentSession {
  sessionKey: string
  messages: ChatMessage[]
  loading: boolean
  sending: boolean
  waiting: boolean
  botName: string
  send: (text: string) => void
  // Turn control and message editing, provided by the ACP (local) backend; the
  // dashboard placeholder session leaves these unset.
  stop?: () => void
  canFork?: boolean
  // Rewind history to a user turn (0-based) and prefill its text for re-sending.
  editMessage?: (turnIndex: number, text: string) => void
  // Composer draft staged by editMessage; the input syncs to it when it changes.
  draft?: { text: string; key: number }
  // When set, the composer's send is disabled (e.g. no agent selected yet).
  disabled?: boolean
  // Whether the server has earlier history than what's currently in `messages`
  // — a cold-opened chat starts from a bounded tail window, not the full
  // transcript, so a long conversation needs
  // "load older" to see anything further back.
  hasMoreHistory?: boolean
  loadingMoreHistory?: boolean
  // Fetches and prepends the next page of older history, resolving once
  // `messages` reflects it (or immediately, as a no-op, while a fetch is
  // already in flight or once hasMoreHistory is false) — callers await it to
  // sequence a DOM-window/scroll-position change with the data actually
  // landing, instead of the two racing.
  loadMoreHistory?: () => Promise<void>
  // The turn the loaded history starts inside, when only part of that turn is
  // loaded — its own `user` event sits above the window. Supplies the leading
  // section's sticky header text, and its `index` names the leading details
  // block so a mid-turn page merging into that block doesn't rename it.
  //
  // The two are separately optional on purpose: a question made entirely of
  // system tags has no words to show as a header, but the turn it names is
  // still the one the leading block belongs to, so the index outlives the text.
  historyHeader?: { index: number; text: UserText | null } | null
}

interface AgentChatProps {
  session: AgentSession
  emptyText?: string
  agentAvatar?: string
  agentName?: string
  // When true, chains render expanded (full detail) by default instead of the
  // collapsed last-message-only view.
  defaultExpanded?: boolean
}

export function AgentChat({ session, emptyText, agentAvatar, agentName, defaultExpanded }: AgentChatProps) {
  const displayName = agentName ?? session.botName
  // Computed over the FULL message list, not the visible window: turn indices
  // (for edit/fork) must stay correct regardless of how much is rendered, and
  // folding/building is cheap next to the cost of actually rendering blocks.
  const blocks: readonly Block[] = useMemo(
    () => buildBlocks(session.messages, session.historyHeader?.index),
    [session.messages, session.historyHeader?.index],
  )
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

  // Whether to fetch more history, and running the fetch, are this
  // application's own decision — the kit component only holds the reader's
  // place while whatever operation is handed to it runs.
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
      hasMessages={session.messages.length > 0}
      loading={session.loading}
      emptyText={emptyText}
      waiting={session.waiting}
      historyHeaderText={session.historyHeader?.text}
      hasMoreHistory={session.hasMoreHistory === true}
      loadingMoreHistory={session.loadingMoreHistory === true}
      onLoadOlder={loadOlder}
      onEditUser={onEditUser}
      defaultExpanded={defaultExpanded}
      botName={displayName}
      agentAvatar={agentAvatar}
      renderers={CHAT_RENDERERS}
      renderTool={renderToolCall}
      footer={
        <>
          {session.waiting && <ThinkingIndicator />}
          <AgentChatStatusIndicators />
        </>
      }
    />
  )
}

const THINKING_PHRASES = [
  'Analyzing...',
  'Architecting...',
  'Brewing...',
  'Casting...',
  'Consulting...',
  'Cooking...',
  'Crunching...',
  'Doing the THING...',
  'Figuring...',
  'Masterminding...',
  'Orchestrating...',
  'Pondering...',
  'Processing...',
  'Slacking...',
  'Snoozing...',
  'Sorcering...',
  'Thinking...',
  'Vibing...',
  'Witching...',
  'Working...',
] as const

export function ThinkingIndicator() {
  const [phrase, setPhrase] = useState<string>(
    () => THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)],
  )
  const prevPhrase = useRef(phrase)
  const [visible, setVisible] = useState(0)

  // Cycle phrases
  useEffect(() => {
    const interval = setInterval(() => {
      let next: string
      do {
        next = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]
      } while (next === phrase && next.length === phrase.length && THINKING_PHRASES.length > 1)
      prevPhrase.current = phrase
      setPhrase(next)
      setVisible(0)
    }, 3000)
    return () => clearInterval(interval)
  }, [phrase])

  const maxLen = Math.max(phrase.length, prevPhrase.current.length)

  // Typewriter effect
  useEffect(() => {
    let i = 0
    let cancelled = false
    const tick = () => {
      if (cancelled) {
        return
      }
      i++
      if (i <= maxLen) {
        setVisible(i)
        setTimeout(tick, 20 + Math.random() * 60)
      }
    }
    setTimeout(tick, 300)
    return () => {
      cancelled = true
    }
  }, [phrase])

  // Compose display: new text overwrites old character by character
  const paddedNew = phrase.padEnd(maxLen)
  const paddedOld = prevPhrase.current.padEnd(maxLen)
  const display = paddedNew.slice(0, visible) + paddedOld.slice(visible)

  return (
    <Flex row align='center' className='gap-2 text-xs text-muted-foreground font-mono'>
      <TypingDots variant='primary' size='sm' />
      <span>{display.trimEnd()}</span>
    </Flex>
  )
}

// Messages held in the session's server-side queue (typed while a turn was
// running, delivered in order as turns end). Rendered inside the command bar so
// the feedback sits directly above the composer that produced the messages.
// ── Extension-provided chat-input controls (e.g. voice) ──────────────────────
// Core owns only the injection point and this contract. The actual controls
// (mic capture, TTS playback) live in an extension that declares
// `provides: { 'agent-chat-input-controls': [{ id, component }] }` and resolves
// the agent's ASR/TTS config server-side from `agentNodeId`. Core never
// references any specific extension.
export interface AgentVoiceControlProps {
  /** The active agent's node id; the control resolves its ASR/TTS config from it. */
  agentNodeId: string
  /** Append transcribed text to the composer draft. */
  insertText: (text: string) => void
  /** Send a message as the user. */
  send: (text: string) => void
  /** Read the live message list (e.g. to speak the latest reply). */
  getMessages: () => ChatMessage[]
  /** True while the agent is generating a reply; flips false when the turn completes. */
  streaming: boolean
}

export interface AgentChatInputControl {
  id: string
  component: ComponentType<AgentVoiceControlProps>
}

export function AgentChatInputControls(props: AgentVoiceControlProps) {
  const { items } = useProvided<AgentChatInputControl>('agent-chat-input-controls', loadAllExtensions)
  return (
    <>
      {items.map((control) => (
        <control.component key={control.id} {...props} />
      ))}
    </>
  )
}

// ── Extension-provided chat status indicators (e.g. voice visualizer) ─────────
// Rendered at the foot of the message list, alongside the thinking indicator.
// Each component mounts continuously and decides its own visibility (e.g. a TTS
// playback visualizer that only appears while audio is playing). Same pattern as
// the input controls above — core owns only the injection point, no extension is
// referenced by name.
export interface AgentChatStatusIndicator {
  id: string
  component: ComponentType
}

function AgentChatStatusIndicators() {
  const { items } = useProvided<AgentChatStatusIndicator>('agent-chat-status-indicators', loadAllExtensions)
  return (
    <>
      {items.map((indicator) => (
        <indicator.component key={indicator.id} />
      ))}
    </>
  )
}
