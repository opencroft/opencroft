'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import type { ChatUserMessagePart } from 'agent-chat/components/chat-turn'
import type { AgentChatEdit } from 'agent-chat/session'
import { usePaginatedHistory } from 'agent-chat/use-paginated-history'
import { toEditableParts } from 'agent-chat/user-parts'
import { isTerminalToolStatus } from 'agent-client/fold'
import { DEFAULT_PRESENCE } from 'agent-client/presence'
import type { PermissionOpt, Presence, QueuedPrompt, QueueMode } from 'agent-client/types'
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'

import type { AgentSession } from '@/app/_authed/(agent)/_components/agent-chat'
import {
  type AcpStreamEvent,
  type AuthoredChatEvent,
  HISTORY_END_KIND,
  type ResolvedAuthor,
} from '@/app/_authed/(agent)/_lib/acp-stream'
import { headerFromWindow, userText } from '@/app/_authed/(agent)/_lib/build-blocks'
import type { ChatMessage, ChatPart } from '@/app/_authed/(agent)/_lib/messages'
import { READER_ORIGIN, type WirePromptOrigin } from '@/app/_authed/(agent)/_lib/prompt-origin'
import {
  cancelLocal,
  deliverQueueLocal,
  editTurnLocal,
  ensureLocalSession,
  forgetLocalSession,
  getSessionHistoryPageLocal,
  promptLocal,
  removeQueuedLocal,
  respondLocal,
  setLocalConfigOption,
  setPresenceLocal,
  stopLocal,
} from '@/app/_authed/(agent)/_server/acp'
import { sendFailureMessage } from '@/app/_authed/(agent)/_shared/send-refused-error'

export interface LocalSource {
  agentNodeId: string
  jobNodeId: string
  tabKey: string
}

/**
 * How a message actually reaches the server.
 *
 * Exists so a host can keep every bit of this hook's send bookkeeping —
 * ordering, the message held while the session is still being created, the
 * first-message transform, the waiting state — while routing the request
 * through an endpoint of its own. Group chats need that: `promptLocal` is
 * addressed by session id and performs no membership check, so a group-chat
 * thread sends through its own server function instead, which re-checks
 * membership before delegating to the same underlying prompt.
 *
 * OMITTING IT MUST CHANGE NOTHING. Every existing caller passes no transport
 * and therefore runs the `promptLocal` path below, unchanged.
 */
export type SendTransport = (args: {
  sessionId: string
  text: string
  front?: boolean
  queue: QueueMode
  origin: WirePromptOrigin
}) => Promise<unknown>

// The default transport: exactly the call this hook has always made, now
// carrying the caller's queue choice rather than deciding it here.
const promptLocalTransport: SendTransport = ({ sessionId, text, front, queue, origin }) =>
  promptLocal({ data: { sessionId, text, front, queue, origin } })

/**
 * How this tab's live session is opened.
 *
 * Exists for a host whose tab key is DERIVED from something renameable, which
 * means the key this hook is holding can go stale while the tab is open. Opening
 * by that key is the one call that can create a session, so a stale one does not
 * fail -- it mints a fresh, empty conversation under an address nothing else
 * resolves, and the reader sees an empty chat where their history was.
 *
 * The fix is not to resolve the stale key. It is to stop addressing a session by
 * a mutable value: a host that has a STABLE id for the thing the session belongs
 * to passes a transport that sends that id instead, and the server reads
 * whatever key the thing currently has. Group chats do exactly that -- a thread's
 * id never moves, its session key does.
 *
 * OMITTING IT MUST CHANGE NOTHING. Every existing caller passes no transport and
 * therefore runs the `ensureLocalSession` path below, unchanged.
 */
export type OpenTransport = (source: LocalSource) => Promise<OpenedSessionResult>

/** What opening a session answers with, whichever transport did it. */
export interface OpenedSessionResult {
  sessionId: string
  canFork: boolean
  canSteer: boolean
  adapterId: string
  created: boolean
  contextUsage: { usedTokens: number; contextLimit: number | null; asOf?: number } | null
}

// The default: exactly the call this hook has always made.
const ensureLocalSessionTransport: OpenTransport = (source) => ensureLocalSession({ data: source })

export interface PendingPermission {
  requestId: string
  title: string
  options: PermissionOpt[]
}

export interface PendingAsk {
  requestId: string
  message: string
}

// The queue lives server-side in agent-client; this is its wire shape, aliased
// (not redeclared) so there is a single source of truth for the fields.
export type QueuedMessage = QueuedPrompt

export interface AgentUsage {
  used: number
  size?: number
  // Wall-clock time (ms since epoch) this figure was last known -- present
  // only when it's the last-known reading ensureLocalSession seeded while
  // the session was offline, never on a figure a live 'usage' event reported
  // this connection. Mirrors ContextUsage's own `asOf` (session-context-usage.ts).
  asOf?: number
}

export interface AcpSession {
  session: AgentSession
  permissions: PendingPermission[]
  asks: PendingAsk[]
  // Messages typed while a turn was in progress, held server-side awaiting
  // delivery — the latest 'queue' snapshot from the event stream.
  queue: QueuedMessage[]
  // What that snapshot's senders resolve to, resolved by the server and
  // carried with the snapshot. A waiting message and the same message once
  // delivered must draw the same way, so both halves get the same resolution.
  queueAuthors?: Record<string, ResolvedAuthor>
  // The session's agent-advertised config options (model/effort/mode/…) —
  // the latest 'config_options' snapshot. Empty for adapters that don't
  // advertise any.
  configOptions: SessionConfigOption[]
  // How often this session reads what is waiting for it — the latest
  // 'presence' snapshot. Realtime until the server says otherwise, which is
  // also what a session that has never been told anything else reads at.
  presence: Presence
  // Context usage meter (tokens used / window) from the latest 'usage' event.
  usage?: AgentUsage
  resolvePermission: (requestId: string, optionId?: string) => void
  resolveAsk: (requestId: string, answer?: string) => void
  respondPermissionText: (requestId: string, text: string) => void
  // Drop a still-queued message before it's delivered.
  removeQueued: (id: string) => void
  // Deliver the whole waiting queue now, whatever the cadence would do.
  deliverQueue: () => void
  // Change one of the session's advertised config options. Applies to this
  // session only — never written back into the profile it was started from.
  setConfigOption: (configId: string, value: string | boolean) => void
  // Change how often this session reads what is waiting for it. Persisted
  // server-side, so it outlives the tab that set it.
  setPresence: (presence: Presence) => void
}

type ToolPart = Extract<ChatPart, { type: 'tool-call' }>

function toolText(output: unknown): string {
  if (typeof output === 'string') {
    return output
  }
  return JSON.stringify(output ?? '', null, 2)
}

export interface Folded {
  messages: ChatMessage[]
  permissions: PendingPermission[]
  asks: PendingAsk[]
  waiting: boolean
  // Server-held prompts awaiting delivery — the last 'queue' snapshot wins.
  queue: QueuedMessage[]
  // What that snapshot's senders resolve to. Travels with the snapshot rather
  // than being looked up, the same as a delivered turn's.
  queueAuthors?: Record<string, ResolvedAuthor>
  // The last 'config_options' snapshot wins.
  configOptions: SessionConfigOption[]
  // The last 'presence' snapshot wins, same as the queue's.
  presence: Presence
  usage?: AgentUsage
}

// Reduce the agent-client event log into the message shape AgentChat renders,
// plus the set of still-pending approval / elicitation prompts. `baseIndex` is
// the absolute (server-side) index of `events[0]` — each created message is
// stamped with `baseIndex + <its event's position>` as a stable id, so a
// "load older" prepend (which shifts every existing event's position within
// `events`, but not its absolute index) never changes an already-rendered
// message's id. See ChatMessage.id.
export function fold(events: AuthoredChatEvent[], baseIndex: number): Folded {
  const messages: ChatMessage[] = []
  const tools = new Map<string, ToolPart>()
  const permissions = new Map<string, PendingPermission>()
  const asks = new Map<string, PendingAsk>()
  let assistant: ChatMessage | null = null
  let waiting = false
  let queue: QueuedMessage[] = []
  let queueAuthors: Record<string, ResolvedAuthor> | undefined
  let configOptions: SessionConfigOption[] = []
  // Seeded with the engine's own default rather than a second copy of it, so
  // "what a session reads at until told otherwise" is stated in one place.
  let presence: Presence = DEFAULT_PRESENCE
  let usage: AgentUsage | undefined

  const ensureAssistant = (id: number): ChatMessage => {
    if (!assistant) {
      assistant = { id, role: 'assistant', parts: [], timestamp: 0 }
      messages.push(assistant)
    }
    return assistant
  }

  events.forEach((event, offset) => {
    const id = baseIndex + offset
    switch (event.kind) {
      case 'user': {
        assistant = null
        messages.push({
          id,
          role: 'user',
          parts: [{ type: 'text', text: event.text }],
          timestamp: 0,
          // Carried straight through from the event that brought this turn.
          // Spread rather than assigned so a turn with nothing resolved has no
          // field at all, which is what it looked like before this existed --
          // and `satisfies`, because a key spread into a literal is not
          // excess-property-checked against the literal's target, so a
          // misspelling would compile and the field would never arrive.
          ...(event.authors ? ({ authors: event.authors } satisfies Pick<ChatMessage, 'authors'>) : {}),
        })
        waiting = true
        break
      }
      case 'agent_message': {
        const message = ensureAssistant(id)
        const last = message.parts[message.parts.length - 1]
        if (last && last.type === 'text') {
          last.text += event.text
        } else {
          message.parts.push({ type: 'text', text: event.text })
        }
        break
      }
      case 'agent_thought': {
        const message = ensureAssistant(id)
        const last = message.parts[message.parts.length - 1]
        if (last && last.type === 'thinking') {
          last.text += event.text
        } else {
          message.parts.push({ type: 'thinking', text: event.text })
        }
        break
      }
      case 'tool_call': {
        const message = ensureAssistant(id)
        const part: ToolPart = { type: 'tool-call', id: event.toolCallId, name: event.title, args: event.input }
        message.parts.push(part)
        tools.set(event.toolCallId, part)
        break
      }
      case 'tool_update': {
        const part = tools.get(event.toolCallId)
        if (part) {
          if (event.title) {
            part.name = event.title
          }
          if (event.input !== undefined) {
            part.args = event.input
          }
          if (event.output !== undefined || isTerminalToolStatus(event.status)) {
            part.result = { text: toolText(event.output), isError: event.status === 'failed' }
          }
        }
        break
      }
      case 'permission_request': {
        permissions.set(event.requestId, { requestId: event.requestId, title: event.title, options: event.options })
        break
      }
      case 'permission_resolved': {
        permissions.delete(event.requestId)
        break
      }
      case 'ask_user': {
        asks.set(event.requestId, { requestId: event.requestId, message: event.message })
        break
      }
      case 'ask_user_resolved': {
        asks.delete(event.requestId)
        break
      }
      case 'queue': {
        // Snapshots are complete, so the latest one IS the queue state — and
        // the accounts that came with the snapshot are that snapshot's, for the
        // same reason.
        queue = event.items
        queueAuthors = event.authors
        break
      }
      case 'config_options': {
        configOptions = event.options
        break
      }
      case 'presence': {
        // A snapshot like the queue's, for the same reason: a reconnecting
        // client folds the last one seen and knows what it is looking at.
        presence = event.presence
        break
      }
      case 'usage': {
        usage = { used: event.used, size: event.size }
        break
      }
      case 'turn_end': {
        assistant = null
        waiting = false
        break
      }
      case 'error': {
        ensureAssistant(id).parts.push({ type: 'text', text: `⚠️ ${event.message}` })
        waiting = false
        break
      }
      default:
        break
    }
  })

  return {
    messages,
    permissions: [...permissions.values()],
    asks: [...asks.values()],
    waiting,
    queue,
    queueAuthors,
    configOptions,
    presence,
    usage,
  }
}

// Title the agent self-reports at the very start of its first reply.
const TITLE_TAG = /<opencroft-title>([\s\S]*?)<\/opencroft-title>/i

export function useAcpSession(
  source: LocalSource,
  transformOutgoing?: (text: string, isFirstMessage: boolean) => string,
  botName = 'assistant',
  onTitle?: (title: string) => void,
  // Optional on purpose — see SendTransport. No argument, no behaviour change.
  sendTransport?: SendTransport,
  // Optional on purpose — see OpenTransport. No argument, no behaviour change.
  openTransport?: OpenTransport,
): AcpSession {
  const { agentNodeId, jobNodeId, tabKey } = source
  // Held in a ref and called through it, so a caller that rebuilds the function
  // each render cannot make the resolve-session effect re-run and reopen the
  // session in a loop -- the same guard the send transport's own callers rely on
  // by memoising, made unnecessary here because opening is not idempotent from
  // the reader's point of view.
  const openRef = useRef<OpenTransport>(openTransport ?? ensureLocalSessionTransport)
  openRef.current = openTransport ?? ensureLocalSessionTransport
  const open = useCallback((source: LocalSource) => openRef.current(source), [])
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<AuthoredChatEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [localWaiting, setLocalWaiting] = useState(false)
  const [canFork, setCanFork] = useState(false)
  // Whether the tab's agent accepts mid-turn prompts as live-turn input
  // (adapter-declared, resolved server-side). Steers the permission-rejection
  // flow below; plain sends need no gating — the server already delivers
  // instead of queueing for such agents.
  const [canSteer, setCanSteer] = useState(false)
  // The adapter this session runs, resolved server-side. Only used to classify
  // the session's permission modes for display — a mode id means nothing
  // without knowing who advertised it. Empty until the session resolves.
  const [adapterId, setAdapterId] = useState('')
  const [draft, setDraft] = useState<{ text: string; key: number } | undefined>(undefined)
  const [edit, setEdit] = useState<AgentChatEdit | undefined>(undefined)
  const draftKey = useRef(0)
  const [sendError, setSendError] = useState<string | undefined>(undefined)
  const [sending, startSending] = useTransition()
  // Bumped by clearSession to force the resolve-session effect below to run
  // again for the SAME tab -- agentNodeId/jobNodeId/tabKey don't change on a
  // clear, so nothing else would re-trigger it.
  const [generation, setGeneration] = useState(0)
  // A message typed before the ACP session finished being created, queued so
  // the first message isn't dropped during the (slow first-spawn) handshake.
  // This is the only client-held queue: the server can't hold a message for a
  // session that doesn't exist yet. Once the session is live, mid-turn messages
  // are queued server-side by agent-client (one prompt-turn at a time is an ACP
  // constraint it owns) and observed here via 'queue' snapshot events.
  const pending = useRef<string | null>(null)
  // Historical events accumulate here while a subscribe's synchronous replay is
  // in flight (see acp-stream.ts), committed to `events` in one `setEvents` call
  // when the history_end marker arrives — so a long reopened session paints once
  // instead of one React state update (and one fold() re-run) per stored event.
  const historyBufferRef = useRef<AuthoredChatEvent[]>([])
  const replayingHistoryRef = useRef(true)
  // Absolute (server-side) index of `events[0]` — see fold()'s doc comment.
  // Set from the stream's history_end payload on every (re)connect; decremented
  // as older pages are prepended by loadMoreHistory. Live-appended events don't
  // move events[0], so they never touch this.
  const baseIndexRef = useRef(0)
  // Whether `ensureLocalSession` just created a brand-new ACP session for this
  // tab (vs. resuming a tab-cache hit or a cold-start session/load) — the same
  // authoritative signal the send-message path keys session-scoped envelope
  // content off (see acp.ts / message-envelope.ts). Read inside callbacks to
  // avoid stale closures.
  const createdRef = useRef(false)
  // Latched the moment deliver() hands off any message for this tab source, so
  // two quick sends can't both see `createdRef.current` true and both claim
  // "first" — attaching the title request twice and re-titling the chat on the
  // second reply. Reset only when the tab source changes — a fork's sessionId
  // swap must not clear it mid-conversation.
  const deliveredOnceRef = useRef(false)
  // Outgoing prompts are serialized through this chain. The server assigns
  // queue/turn order by request arrival, so two concurrent promptLocal calls
  // could otherwise arrive reordered on the network and invert the messages.
  // Each link swallows its own failure so one failed send never blocks (or
  // reorders) the sends behind it.
  const sendChainRef = useRef<Promise<void>>(Promise.resolve())
  // Armed only when we deliver a live first message (which carries the title
  // request). This keeps auto-titling off history replay and later turns: a
  // remounted hook starts disarmed, so reconnecting a session never re-titles.
  const titleRequestedRef = useRef(false)
  const transformRef = useRef(transformOutgoing)
  transformRef.current = transformOutgoing
  // Held in a ref for the same reason as transformRef above: `deliver` is
  // memoised on [sessionId], and reading the transport straight from the
  // parameter would put it in that dependency list. A host passing an inline
  // arrow would then give `deliver` a new identity every render, and every
  // callback built on it downstream with it.
  const transportRef = useRef(sendTransport)
  transportRef.current = sendTransport
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle
  // sessionId is read through a ref (not closed over directly) so fetchPage's
  // identity doesn't need to change — and can't go stale — across renders.
  const sessionIdRef = useRef<string | null>(null)
  sessionIdRef.current = sessionId
  const paginatedHistory = usePaginatedHistory({
    fetchPage: useCallback(async (beforeIndex: number) => {
      const id = sessionIdRef.current
      const page = id ? await getSessionHistoryPageLocal({ data: { sessionId: id, beforeIndex } }) : null
      return page ?? { events: [], startIndex: beforeIndex, hasMore: false }
    }, []),
  })
  // The question of the turn the loaded window starts inside, when that turn
  // is only partly loaded — its `user` event sits above what we hold.
  //
  // Kept beside `events` rather than prepended into it: `events` is a
  // contiguous slice and `fold` derives each message's stable id from its
  // offset within it, so splicing in an event from far above would shift every
  // id below it and change them again on the next prepend — which is exactly
  // the churn that broke the scroll restore before stable ids landed. It is a
  // rendering concern anyway: it supplies the sticky header's text.
  // Its `index` is not decoration: it is the identity of the leading details
  // block (see buildBlocks' `enclosingTurnId`). Without it that block is renamed
  // by every mid-turn page and the scroll restore loses its anchor.
  const [historyHeader, setHistoryHeader] = useState<{
    index: number
    parts: readonly ChatUserMessagePart[]
  } | null>(null)
  // Seeded from ensureLocalSession's own read of this session's context usage
  // (live if it has a process right now, else the last-known reading from
  // before it went offline). Shown until a live 'usage' event streams in over
  // THIS connection (folded.usage below), which then takes over permanently —
  // reset alongside the rest of this tab's state so a previous tab's seed
  // never leaks into a freshly resolving one.
  const [seedUsage, setSeedUsage] = useState<AgentUsage | undefined>(undefined)

  // Resolve (or lazily create) the live ACP session for this tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies(generation): not read in the body -- it exists purely to force this effect to re-run for the SAME tab after clearSession, which agentNodeId/jobNodeId/tabKey alone would not trigger
  useEffect(() => {
    let cancelled = false
    setSessionId(null)
    setEvents([])
    setLoading(true)
    setLocalWaiting(false)
    setCanFork(false)
    setCanSteer(false)
    setSeedUsage(undefined)
    deliveredOnceRef.current = false
    sendChainRef.current = Promise.resolve()
    open({ agentNodeId, jobNodeId, tabKey })
      .then((result) => {
        if (!cancelled) {
          setSessionId(result.sessionId)
          setCanFork(result.canFork)
          setCanSteer(result.canSteer)
          setAdapterId(result.adapterId)
          createdRef.current = result.created
          setSeedUsage(
            result.contextUsage
              ? {
                  used: result.contextUsage.usedTokens,
                  size: result.contextUsage.contextLimit ?? undefined,
                  asOf: result.contextUsage.asOf,
                }
              : undefined,
          )
        }
      })
      .catch((error) => {
        console.error('opening the session failed', error)
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [agentNodeId, jobNodeId, tabKey, generation, open])

  // Stream events once the session id is known.
  useEffect(() => {
    if (!sessionId) {
      return
    }
    const eventSource = new EventSource(`/api/acp/stream?sessionId=${encodeURIComponent(sessionId)}`)
    // subscribe replays a bounded tail of the session's history on every
    // (re)connect — including native EventSource auto-reconnects and a fork's
    // sessionId swap (see acp.stream.ts's INITIAL_HISTORY_TURNS; older history
    // is fetched separately via loadMoreHistory, not sent here) — so onopen
    // re-enters buffering mode each time: historical events queue in the ref below
    // instead of hitting setEvents, and are only committed (replacing, not
    // appending, to cleanly swap in a fork's rewound transcript) once history_end
    // confirms the replay is done.
    eventSource.onopen = () => {
      historyBufferRef.current = []
      replayingHistoryRef.current = true
    }
    eventSource.onmessage = (e) => {
      const event = JSON.parse(e.data) as AcpStreamEvent
      if (event.kind === HISTORY_END_KIND) {
        replayingHistoryRef.current = false
        baseIndexRef.current = event.startIndex
        setEvents(historyBufferRef.current)
        setLoading(false)
        // The replayed history is a bounded tail (see acp.stream.ts), not
        // necessarily the whole session — hand the cursor to the pagination
        // hook so a scroll-triggered loadMoreHistory() picks up from here.
        paginatedHistory.reset(event.startIndex, event.hasMore)
        // Set unconditionally: a fresh connect re-sends a fresh tail, so a
        // header from a previous connection must not linger.
        setHistoryHeader(headerFromWindow(event.header))
        return
      }
      if (replayingHistoryRef.current) {
        historyBufferRef.current.push(event)
        return
      }
      setEvents((prev) => [...prev, event])
      // turn_end / error: the turn is over, so whatever the client optimistically
      // marked working is not working. A NON-EMPTY queue snapshot is the other
      // half of the same correction: the engine saying a message is WAITING
      // means nothing is running to wait on. Without it, a message held by the
      // session's cadence leaves the optimistic flag stuck on — a working
      // indicator and a Stop button over an agent that is idle, until the chat
      // is left and re-entered.
      if (event.kind === 'turn_end' || event.kind === 'error' || (event.kind === 'queue' && event.items.length > 0)) {
        setLocalWaiting(false)
      }
    }
    eventSource.onerror = () => setLoading(false)
    return () => eventSource.close()
  }, [sessionId, paginatedHistory.reset])

  const folded = useMemo(() => fold(events, baseIndexRef.current), [events])

  // Pull the self-reported title out of the first reply and apply it once. Gated
  // on titleRequestedRef so it only fires for the live first turn — never on the
  // replayed transcript of a reopened session or on any later message.
  useEffect(() => {
    if (!titleRequestedRef.current) {
      return
    }
    const reply = folded.messages.find((m) => m.role === 'assistant')
    if (!reply) {
      return
    }
    const text = reply.parts.reduce((acc, part) => (part.type === 'text' ? acc + part.text : acc), '')
    const match = text.match(TITLE_TAG)
    if (!match) {
      return
    }
    titleRequestedRef.current = false
    const title = match[1].trim()
    if (title) {
      onTitleRef.current?.(title)
    }
  }, [folded.messages])

  // The single seam where a message leaves the client (applies the outgoing
  // transform, so it runs for every message — including ones the server will
  // queue rather than deliver right away). The server owns the queue-vs-prompt
  // decision, but NOT the order of concurrent requests — it queues by arrival —
  // so requests are chained here to reach it in send order. `front` asks the
  // server to queue ahead of anything already held.
  const deliver = useCallback(
    (value: string, opts: { front?: boolean; queue: QueueMode; origin: WirePromptOrigin }) => {
      if (!sessionId) {
        return
      }
      const transform = transformRef.current
      const isFirst = createdRef.current && !deliveredOnceRef.current
      deliveredOnceRef.current = true
      // Transform at send time (not when the chain link runs): the chain
      // preserves order, so "first" and the canvas context are decided the
      // moment the user hit send.
      const text = transform ? transform(value, isFirst) : value
      if (isFirst) {
        titleRequestedRef.current = true
      }
      setLocalWaiting(true)
      setSendError(undefined)
      const chained = sendChainRef.current.then(async () => {
        try {
          await (transportRef.current ?? promptLocalTransport)({
            sessionId,
            text,
            front: opts.front,
            queue: opts.queue,
            origin: opts.origin,
          })
        } catch (error) {
          console.error('promptLocal failed', error)
          setLocalWaiting(false)
          // A failed send used to end here, in the console. The composer had
          // already cleared itself (the kit bar clears before calling onSend),
          // so from the screen it was indistinguishable from a delivered
          // message — the message simply vanished.
          //
          // Two things have to happen instead. The failure gets copy the host
          // can render, and the text goes back into the composer so it is not
          // lost. `value` is restored, not `text`: `text` has the outgoing
          // transform applied (session-init envelope, canvas context), and
          // putting that in front of the user would show them machinery they
          // never typed.
          setSendError(sendFailureMessage(error))
          draftKey.current += 1
          setDraft({ text: value, key: draftKey.current })
        }
      })
      sendChainRef.current = chained
      // `sending` tracks the chain tail, so it stays set while earlier sends
      // are still in flight ahead of this one.
      startSending(async () => {
        await chained
      })
    },
    [sessionId],
  )

  const send = useCallback(
    (value: string) => {
      if (!sessionId) {
        // Session is still being created — hold the raw text, flush once ready.
        pending.current = value
        setLocalWaiting(true)
        return
      }
      // Always hand the message to the server: it delivers immediately when the
      // session is idle and queues it when a turn is running. deliver() chains
      // the requests so rapid sends reach the server in send order.
      deliver(value, { queue: 'wait', origin: READER_ORIGIN })
    },
    [sessionId, deliver],
  )

  // Flush the message held while the session was being created.
  useEffect(() => {
    if (!sessionId || pending.current === null) {
      return
    }
    const text = pending.current
    pending.current = null
    deliver(text, { queue: 'wait', origin: READER_ORIGIN })
  }, [sessionId, deliver])

  // Interrupt the running turn. The agent emits a (cancelled) turn_end, which
  // clears the waiting state through the event stream.
  // Stop, which the server may turn into a delivery: with unread messages held
  // it cancels the turn AND hands them over, since a stop with something unsaid
  // is usually a redirection rather than an abandonment. The queue is read
  // server-side, next to the queue -- this component's copy of it is a render
  // old, and a message landing between the paint and the click is exactly the
  // case the behaviour exists for.
  const stop = useCallback(() => {
    if (sessionId) {
      void stopLocal({ data: sessionId })
    }
  }, [sessionId])

  // Deliver everything waiting, now — the Unread divider, pressed. The engine
  // owns the hand-over (and what it interrupts to do it); the queue snapshots
  // it emits are what say the queue went, the same as for a send.
  const deliverQueue = useCallback(() => {
    if (sessionId) {
      void deliverQueueLocal({ data: sessionId })
    }
  }, [sessionId])

  // Edit a user message: open the turn named by its block id. Nothing is staged
  // in the composer and nothing is forked yet -- a turn can carry several
  // messages, and the composer takes them one at a time (see the command bar's
  // own edit machinery). The fork happens on commit, server-side, together
  // with rebuilding the turn.
  //
  // The RAW delivered text is what gets decoded, read from this hook's own
  // messages rather than from the block. `Block.text` has already been through
  // the app's tag stripper over the whole delivery, and that stripper can take
  // a newline with it -- leaving the next `<agent-message …/>` no longer at the
  // start of a line, so the client would decode fewer messages than the server
  // and commit a body into the wrong one. Stripping happens per message here
  // instead, which is what `toEditableParts`' render seam is for.
  const editMessage = useCallback(
    (blockId: string) => {
      const message = folded.messages.find((m) => m.role === 'user' && `u:${m.id}` === blockId)
      const raw = message?.parts.find((part) => part.type === 'text')
      if (!message || !raw) {
        return
      }
      const parts = toEditableParts(raw.text, userText)
      // A turn with nothing editable in it -- every message was application
      // context -- opens no editor rather than an empty one.
      if (parts.length === 0) {
        return
      }
      // `id` is the absolute position of this turn in the session's event log
      // (see ChatMessage.id), which is the numbering the server indexes by.
      setEdit({ eventIndex: message.id, parts })
    },
    [folded.messages],
  )

  const cancelEdit = useCallback(() => setEdit(undefined), [])

  // Commit the open turn: the server rewinds to it and re-sends it with these
  // words in place of the messages at these positions.
  //
  // Words only. Authorship, send times, the interrupt note and this app's own
  // context tags are resolved server-side from the delivered turn -- this call
  // cannot state them, for the same reason an ordinary send cannot state its
  // sender.
  //
  // The mode stays OPEN until the server answers, and closes only on success.
  // A refusal (the turn is no longer there) or a failure used to close the bar,
  // empty the composer and report nothing, which lost the reader's words with
  // nothing on screen to say so. Left open, the drafts are still in the
  // composer where they were, and `sendError` says what happened -- the same
  // pair a failed send uses.
  const commitEdit = useCallback(
    (edits: { index: number; text: string }[]) => {
      const open = edit
      if (!sessionId || !open) {
        return
      }
      // Nothing changed: leaving the mode is the whole of it. Re-sending the
      // turn unaltered would still fork the conversation and re-run it, which
      // is a lot to do about a reader who opened an editor and thought better
      // of it.
      if (edits.length === 0) {
        setEdit(undefined)
        return
      }
      setSendError(undefined)
      // Through the same transition an ordinary send uses, so `sending` covers
      // the round trip and the composer's own button is disabled for it -- a
      // second press cannot fork the conversation twice.
      startSending(async () => {
        try {
          const result = await editTurnLocal({
            data: { tabKey, sessionId, eventIndex: open.eventIndex, edits },
          })
          if (!result) {
            setSendError('That message is no longer in this conversation, so the edit was not applied.')
            return
          }
          setEdit(undefined)
          setLocalWaiting(false)
          setSessionId(result.sessionId)
        } catch (error) {
          console.error('editTurnLocal failed', error)
          setSendError(sendFailureMessage(error))
        }
      })
    },
    [edit, sessionId, tabKey],
  )

  const resolvePermission = useCallback((requestId: string, optionId?: string) => {
    void respondLocal({ data: { type: 'permission', requestId, optionId } })
  }, [])

  const resolveAsk = useCallback((requestId: string, answer?: string) => {
    void respondLocal({ data: { type: 'ask', requestId, answer } })
  }, [])

  // "Tell what to do different": ACP can't attach a reason to a rejection, so
  // the request is rejected and the typed guidance sent separately. On an
  // agent that takes mid-turn input, the guidance simply streams into the
  // live turn — the model course-corrects without losing the turn's progress.
  // Otherwise the run is cancelled and the guidance sent with `front` set, so
  // the server queues it ahead of anything else held for the session and
  // delivers it as soon as the interrupted turn ends.
  const respondPermissionText = useCallback(
    (requestId: string, text: string) => {
      resolvePermission(requestId)
      const value = text.trim()
      if (!value || !sessionId) {
        return
      }
      if (canSteer) {
        deliver(value, { queue: 'wait', origin: READER_ORIGIN })
        return
      }
      void cancelLocal({ data: sessionId })
      deliver(value, { front: true, queue: 'wait', origin: READER_ORIGIN })
    },
    [sessionId, resolvePermission, deliver, canSteer],
  )

  // Fetches the next older page and prepends its raw events ahead of whatever
  // is already loaded — fold() re-derives `messages` from the combined log, so
  // the newly revealed history renders through the same path as everything
  // else. Resolves once `events` (and so `messages`) reflects the fetched
  // page — a caller can await it before adjusting its render window / scroll
  // position instead of racing the fetch. A no-op fetch (nothing returned)
  // resolves without touching `events`.
  const loadMoreHistory = useCallback(async () => {
    const page = await paginatedHistory.loadOlder()
    if (!page || page.events.length === 0) {
      return
    }
    // The page abuts what we already hold, so the array stays contiguous and
    // `baseIndexRef` moves by exactly the number of events prepended.
    baseIndexRef.current -= page.events.length
    setEvents((prev) => [...page.events, ...prev])
    // The topmost partly-loaded turn has changed: either it's an older turn
    // now, or this page reached far enough up that the question is inside the
    // slice and no separate header is needed.
    setHistoryHeader(headerFromWindow(page.header))
  }, [paginatedHistory.loadOlder])

  const dismissSendError = useCallback(() => setSendError(undefined), [])

  // Discards this tab's session entirely (transcript, durable pointer, live
  // process) and bumps `generation` so the resolve-session effect opens a
  // fresh one in its place -- same tab, same chat-list entry, empty history.
  //
  // State semantics on Clear:
  // - Pending permission requests and the server-side prompt queue die with
  //   the session -- they belong to the deleted session's live process, which
  //   is gone, so there is nothing left to resume either into.
  // - The composer draft SURVIVES: both the in-memory text and the persisted
  //   per-tab entry live in use-agent-sessions.ts's own store, keyed by
  //   tabKey and never touched here -- the draft belongs to the composer, not
  //   to the session identity Clear is replacing.
  //
  // Returns the promise (rather than firing it and forgetting) so a caller's
  // in-flight guard -- see agent-chat's useClearControl -- can actually wait
  // for it, and catches its own failure rather than leaving a rejection
  // unhandled: a destructive control that fails silently is worse than one
  // that logs and lets the caller's guard release normally either way.
  const clearSession = useCallback(() => {
    return forgetLocalSession({ data: tabKey })
      .then(() => setGeneration((g) => g + 1))
      .catch((err) => {
        console.error('Failed to clear session', tabKey, err)
      })
  }, [tabKey])

  const session = useMemo<AgentSession>(
    () => ({
      sessionKey: tabKey,
      messages: folded.messages,
      loading,
      sending,
      waiting: folded.waiting || localWaiting,
      botName,
      send,
      stop,
      canFork,
      adapterId,
      editMessage,
      edit,
      cancelEdit,
      commitEdit,
      draft,
      sendError,
      dismissSendError,
      clearSession,
      hasMoreHistory: paginatedHistory.hasMore,
      loadingMoreHistory: paginatedHistory.loadingMore,
      loadMoreHistory,
      historyHeader,
    }),
    [
      tabKey,
      folded.messages,
      folded.waiting,
      loading,
      sending,
      localWaiting,
      botName,
      send,
      stop,
      canFork,
      adapterId,
      editMessage,
      edit,
      cancelEdit,
      commitEdit,
      draft,
      sendError,
      dismissSendError,
      clearSession,
      paginatedHistory.hasMore,
      paginatedHistory.loadingMore,
      loadMoreHistory,
      historyHeader,
    ],
  )

  // The server drops the message and confirms via a 'queue' snapshot on the
  // stream — no optimistic local state to keep in sync.
  const removeQueued = useCallback(
    (id: string) => {
      if (sessionId) {
        void removeQueuedLocal({ data: { sessionId, id } })
      }
    },
    [sessionId],
  )

  // The server confirms via a fresh 'config_options' snapshot on the stream —
  // no optimistic local state to keep in sync.
  const setConfigOption = useCallback(
    (configId: string, value: string | boolean) => {
      if (sessionId) {
        void setLocalConfigOption({ data: { sessionId, configId, value } })
      }
    },
    [sessionId],
  )

  // The server confirms via a fresh 'presence' snapshot on the stream — no
  // optimistic local state to keep in sync.
  const setPresence = useCallback(
    (presence: Presence) => {
      if (sessionId) {
        void setPresenceLocal({ data: { sessionId, presence } })
      }
    },
    [sessionId],
  )

  return useMemo(
    () => ({
      session,
      permissions: folded.permissions,
      asks: folded.asks,
      queue: folded.queue,
      queueAuthors: folded.queueAuthors,
      configOptions: folded.configOptions,
      presence: folded.presence,
      // A live event this connection has actually seen wins and stays won —
      // once one lands, folded.usage keeps returning it on every later render
      // (it's derived from the accumulated event log), so the ring never
      // reverts to the seed after going live. Before that, the seed is what
      // ensureLocalSession resolved this tab's usage to at open time.
      usage: folded.usage ?? seedUsage,
      resolvePermission,
      resolveAsk,
      respondPermissionText,
      removeQueued,
      deliverQueue,
      setConfigOption,
      setPresence,
    }),
    [
      session,
      folded.permissions,
      folded.asks,
      folded.queue,
      folded.queueAuthors,
      folded.configOptions,
      folded.presence,
      folded.usage,
      seedUsage,
      resolvePermission,
      resolveAsk,
      respondPermissionText,
      removeQueued,
      deliverQueue,
      setConfigOption,
      setPresence,
    ],
  )
}
