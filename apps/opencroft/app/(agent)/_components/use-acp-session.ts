'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { usePaginatedHistory } from 'agent-chat/use-paginated-history'
import type { ChatEvent, PermissionOpt, QueuedPrompt } from 'agent-client/types'
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'

import type { AgentSession } from '@/app/(agent)/_components/agent-chat'
import { type AcpStreamEvent, HISTORY_END_KIND } from '@/app/(agent)/_lib/acp-stream'
import type { ChatMessage, ChatPart } from '@/app/(agent)/_lib/messages'
import {
  cancelLocal,
  ensureLocalSession,
  forkLocal,
  getSessionHistoryPageLocal,
  getSessionTurnRecordsPageLocal,
  promptLocal,
  removeQueuedLocal,
  respondLocal,
  setLocalConfigOption,
} from '@/app/(agent)/_server/acp'

export interface LocalSource {
  agentNodeId: string
  jobNodeId: string
  tabKey: string
}

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
}

export interface AcpSession {
  session: AgentSession
  permissions: PendingPermission[]
  asks: PendingAsk[]
  // Messages typed while a turn was in progress, held server-side awaiting
  // delivery — the latest 'queue' snapshot from the event stream.
  queue: QueuedMessage[]
  // The session's agent-advertised config options (model/effort/mode/…) —
  // the latest 'config_options' snapshot. Empty for adapters that don't
  // advertise any.
  configOptions: SessionConfigOption[]
  // Context usage meter (tokens used / window) from the latest 'usage' event.
  usage?: AgentUsage
  resolvePermission: (requestId: string, optionId?: string) => void
  resolveAsk: (requestId: string, answer?: string) => void
  respondPermissionText: (requestId: string, text: string) => void
  // Drop a still-queued message before it's delivered.
  removeQueued: (id: string) => void
  // Change one of the session's advertised config options. Applies to this
  // session only — never written back into the profile it was started from.
  setConfigOption: (configId: string, value: string | boolean) => void
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
  // The last 'config_options' snapshot wins.
  configOptions: SessionConfigOption[]
  usage?: AgentUsage
}

// Reduce the agent-client event log into the message shape AgentChat renders,
// plus the set of still-pending approval / elicitation prompts. `baseIndex` is
// the absolute (server-side) index of `events[0]` — each created message is
// stamped with `baseIndex + <its event's position>` as a stable id, so a
// "load older" prepend (which shifts every existing event's position within
// `events`, but not its absolute index) never changes an already-rendered
// message's id. See ChatMessage.id.
export function fold(events: ChatEvent[], baseIndex: number): Folded {
  const messages: ChatMessage[] = []
  const tools = new Map<string, ToolPart>()
  const permissions = new Map<string, PendingPermission>()
  const asks = new Map<string, PendingAsk>()
  let assistant: ChatMessage | null = null
  let waiting = false
  let queue: QueuedMessage[] = []
  let configOptions: SessionConfigOption[] = []
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
        messages.push({ id, role: 'user', parts: [{ type: 'text', text: event.text }], timestamp: 0 })
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
          if (event.output !== undefined || event.status === 'completed' || event.status === 'failed') {
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
        // Snapshots are complete, so the latest one IS the queue state.
        queue = event.items
        break
      }
      case 'config_options': {
        configOptions = event.options
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
    configOptions,
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
): AcpSession {
  const { agentNodeId, jobNodeId, tabKey } = source
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [localWaiting, setLocalWaiting] = useState(false)
  const [canFork, setCanFork] = useState(false)
  // Whether the tab's agent accepts mid-turn prompts as live-turn input
  // (adapter-declared, resolved server-side). Steers the permission-rejection
  // flow below; plain sends need no gating — the server already delivers
  // instead of queueing for such agents.
  const [canSteer, setCanSteer] = useState(false)
  const [draft, setDraft] = useState<{ text: string; key: number } | undefined>(undefined)
  const draftKey = useRef(0)
  const [sending, startSending] = useTransition()
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
  const historyBufferRef = useRef<ChatEvent[]>([])
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
  // The absolute index of the newest turn's leading 'user' event, when that
  // turn was itself trimmed (see acp.stream.ts's INITIAL_TURN_RECORDS) — set
  // from the stream's history_end `trimmedTurn`, read by loadMoreInTurn to
  // know which turn it's paging within. Read through a ref for the same
  // reason as sessionIdRef: fetchPage's identity must not change every
  // reconnect.
  const turnStartRef = useRef<number | null>(null)
  const paginatedTurnRecords = usePaginatedHistory({
    fetchPage: useCallback(async (beforeIndex: number) => {
      const id = sessionIdRef.current
      const turnStart = turnStartRef.current
      const page =
        id && turnStart !== null
          ? await getSessionTurnRecordsPageLocal({ data: { sessionId: id, turnStart, beforeIndex } })
          : null
      return page ?? { events: [], startIndex: beforeIndex, hasMore: false }
    }, []),
  })

  // Resolve (or lazily create) the live ACP session for this tab.
  useEffect(() => {
    let cancelled = false
    setSessionId(null)
    setEvents([])
    setLoading(true)
    setLocalWaiting(false)
    setCanFork(false)
    setCanSteer(false)
    deliveredOnceRef.current = false
    sendChainRef.current = Promise.resolve()
    ensureLocalSession({ data: { agentNodeId, jobNodeId, tabKey } })
      .then((result) => {
        if (!cancelled) {
          setSessionId(result.sessionId)
          setCanFork(result.canFork)
          setCanSteer(result.canSteer)
          createdRef.current = result.created
        }
      })
      .catch((error) => {
        console.error('ensureLocalSession failed', error)
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [agentNodeId, jobNodeId, tabKey])

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
        // A fresh connect re-sends a fresh (possibly untrimmed) tail turn —
        // reset unconditionally so a stale trimmedTurn from a previous
        // connection never lingers.
        turnStartRef.current = event.trimmedTurn?.turnStart ?? null
        paginatedTurnRecords.reset(event.trimmedTurn?.startIndex ?? 0, event.trimmedTurn?.hasMore ?? false)
        return
      }
      if (replayingHistoryRef.current) {
        historyBufferRef.current.push(event)
        return
      }
      setEvents((prev) => [...prev, event])
      if (event.kind === 'user') {
        // Only the newest turn is ever trimmed on load, so a new turn retires
        // the in-turn cursor: the records it would fetch belong to a turn that
        // is no longer the newest, and its "load earlier tool calls" control
        // would otherwise linger against the wrong turn.
        turnStartRef.current = null
        paginatedTurnRecords.reset(0, false)
      }
      if (event.kind === 'turn_end' || event.kind === 'error') {
        setLocalWaiting(false)
      }
    }
    eventSource.onerror = () => setLoading(false)
    return () => eventSource.close()
  }, [sessionId, paginatedHistory.reset, paginatedTurnRecords.reset])

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
    (value: string, opts?: { front?: boolean }) => {
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
      const chained = sendChainRef.current.then(async () => {
        try {
          await promptLocal({ data: { sessionId, text, front: opts?.front } })
        } catch (error) {
          console.error('promptLocal failed', error)
          setLocalWaiting(false)
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
      deliver(value)
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
    deliver(text)
  }, [sessionId, deliver])

  // Interrupt the running turn. The agent emits a (cancelled) turn_end, which
  // clears the waiting state through the event stream.
  const stop = useCallback(() => {
    if (sessionId) {
      void cancelLocal({ data: sessionId })
    }
  }, [sessionId])

  // Branch the session at a user turn (0-based). Switching to the fork's id
  // reconnects the stream, replaying the rewound transcript.
  const fork = useCallback(
    (dropFromTurn: number) => {
      if (!sessionId) {
        return
      }
      forkLocal({ data: { tabKey, sessionId, dropFromTurn } })
        .then((result) => {
          if (result) {
            setLocalWaiting(false)
            setSessionId(result.sessionId)
          }
        })
        .catch((error) => console.error('forkLocal failed', error))
    },
    [sessionId, tabKey],
  )

  // Edit a user message: rewind the session to that turn, then stage the
  // message text as a draft for the composer to load and re-send.
  const editMessage = useCallback(
    (dropFromTurn: number, text: string) => {
      fork(dropFromTurn)
      draftKey.current += 1
      setDraft({ text, key: draftKey.current })
    },
    [fork],
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
        deliver(value)
        return
      }
      void cancelLocal({ data: sessionId })
      deliver(value, { front: true })
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
    const older = await paginatedHistory.loadOlder()
    if (older.length > 0) {
      baseIndexRef.current -= older.length
      setEvents((prev) => [...older, ...prev])
    }
  }, [paginatedHistory.loadOlder])

  // Fetches the next older page of tool calls within the current (newest)
  // turn and splices it back in right after that turn's own 'user' event —
  // unlike loadMoreHistory, this inserts mid-array rather than at the front,
  // since everything after the insertion point (the turn's already-loaded
  // tail) stays exactly where it is. `baseIndexRef` (events[0]'s absolute
  // index) is unaffected — nothing before it moved.
  const loadMoreInTurn = useCallback(async () => {
    const turnStart = turnStartRef.current
    const older = await paginatedTurnRecords.loadOlder()
    if (older.length > 0 && turnStart !== null) {
      setEvents((prev) => {
        const insertAt = turnStart - baseIndexRef.current + 1
        return [...prev.slice(0, insertAt), ...older, ...prev.slice(insertAt)]
      })
    }
  }, [paginatedTurnRecords.loadOlder])

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
      editMessage,
      draft,
      hasMoreHistory: paginatedHistory.hasMore,
      loadingMoreHistory: paginatedHistory.loadingMore,
      loadMoreHistory,
      hasMoreInTurn: paginatedTurnRecords.hasMore,
      loadingMoreInTurn: paginatedTurnRecords.loadingMore,
      loadMoreInTurn,
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
      editMessage,
      draft,
      paginatedHistory.hasMore,
      paginatedHistory.loadingMore,
      loadMoreHistory,
      paginatedTurnRecords.hasMore,
      paginatedTurnRecords.loadingMore,
      loadMoreInTurn,
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

  return useMemo(
    () => ({
      session,
      permissions: folded.permissions,
      asks: folded.asks,
      queue: folded.queue,
      configOptions: folded.configOptions,
      usage: folded.usage,
      resolvePermission,
      resolveAsk,
      respondPermissionText,
      removeQueued,
      setConfigOption,
    }),
    [
      session,
      folded.permissions,
      folded.asks,
      folded.queue,
      folded.configOptions,
      folded.usage,
      resolvePermission,
      resolveAsk,
      respondPermissionText,
      removeQueued,
      setConfigOption,
    ],
  )
}
