'use client'

import type { ChatEvent, PermissionOpt } from 'agent-client/types'
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'

import type { AgentSession } from '@/app/(agent)/_components/agent-chat'
import type { ChatMessage, ChatPart } from '@/app/(agent)/_lib/messages'
import { cancelLocal, ensureLocalSession, forkLocal, promptLocal, respondLocal } from '@/app/(agent)/_server/acp'

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

export interface QueuedMessage {
  id: string
  text: string
}

export interface AcpSession {
  session: AgentSession
  permissions: PendingPermission[]
  asks: PendingAsk[]
  // Messages typed while a turn is in progress, awaiting delivery.
  queue: QueuedMessage[]
  resolvePermission: (requestId: string, optionId?: string) => void
  resolveAsk: (requestId: string, answer?: string) => void
  respondPermissionText: (requestId: string, text: string) => void
  // Drop a still-queued message before it's delivered.
  removeQueued: (id: string) => void
}

type ToolPart = Extract<ChatPart, { type: 'tool-call' }>

function toolText(output: unknown): string {
  if (typeof output === 'string') {
    return output
  }
  return JSON.stringify(output ?? '', null, 2)
}

interface Folded {
  messages: ChatMessage[]
  permissions: PendingPermission[]
  asks: PendingAsk[]
  waiting: boolean
}

// Reduce the agent-client event log into the message shape AgentChat renders,
// plus the set of still-pending approval / elicitation prompts.
function fold(events: ChatEvent[]): Folded {
  const messages: ChatMessage[] = []
  const tools = new Map<string, ToolPart>()
  const permissions = new Map<string, PendingPermission>()
  const asks = new Map<string, PendingAsk>()
  let assistant: ChatMessage | null = null
  let waiting = false

  const ensureAssistant = (): ChatMessage => {
    if (!assistant) {
      assistant = { role: 'assistant', parts: [], timestamp: 0 }
      messages.push(assistant)
    }
    return assistant
  }

  for (const event of events) {
    switch (event.kind) {
      case 'user': {
        assistant = null
        messages.push({ role: 'user', parts: [{ type: 'text', text: event.text }], timestamp: 0 })
        waiting = true
        break
      }
      case 'agent_message': {
        const message = ensureAssistant()
        const last = message.parts[message.parts.length - 1]
        if (last && last.type === 'text') {
          last.text += event.text
        } else {
          message.parts.push({ type: 'text', text: event.text })
        }
        break
      }
      case 'agent_thought': {
        const message = ensureAssistant()
        const last = message.parts[message.parts.length - 1]
        if (last && last.type === 'thinking') {
          last.text += event.text
        } else {
          message.parts.push({ type: 'thinking', text: event.text })
        }
        break
      }
      case 'tool_call': {
        const message = ensureAssistant()
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
      case 'turn_end': {
        assistant = null
        waiting = false
        break
      }
      case 'error': {
        ensureAssistant().parts.push({ type: 'text', text: `⚠️ ${event.message}` })
        waiting = false
        break
      }
      default:
        break
    }
  }

  return {
    messages,
    permissions: [...permissions.values()],
    asks: [...asks.values()],
    waiting,
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
  const [draft, setDraft] = useState<{ text: string; key: number } | undefined>(undefined)
  const draftKey = useRef(0)
  const [sending, startSending] = useTransition()
  // A message typed before the ACP session finished being created, queued so
  // the first message isn't dropped during the (slow first-spawn) handshake.
  const pending = useRef<string | null>(null)
  // Messages typed while a turn is in progress. ACP allows only one prompt-turn
  // at a time, so they're held here and delivered one-by-one as each turn ends
  // (removable until pulled). When ACP gains native mid-turn input, deliver()
  // can target the live turn instead of routing through this queue.
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const queueIdRef = useRef(0)
  // Read inside callbacks/effects to avoid stale closures.
  const waitingRef = useRef(false)
  const isFirstRef = useRef(true)
  // Armed only when we deliver a live first message (which carries the title
  // request). This keeps auto-titling off history replay and later turns: a
  // remounted hook starts disarmed, so reconnecting a session never re-titles.
  const titleRequestedRef = useRef(false)
  const transformRef = useRef(transformOutgoing)
  transformRef.current = transformOutgoing
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle

  // Resolve (or lazily create) the live ACP session for this tab.
  useEffect(() => {
    let cancelled = false
    setSessionId(null)
    setEvents([])
    setLoading(true)
    setLocalWaiting(false)
    setCanFork(false)
    setQueue([])
    ensureLocalSession({ data: { agentNodeId, jobNodeId, tabKey } })
      .then((result) => {
        if (!cancelled) {
          setSessionId(result.sessionId)
          setCanFork(result.canFork)
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
    // subscribe replays the session's full history on connect, so reset on each
    // (re)connection to avoid duplicating it — and to cleanly swap in a fork's
    // rewound transcript when the session id changes.
    eventSource.onopen = () => {
      setEvents([])
      setLoading(false)
    }
    eventSource.onmessage = (e) => {
      const event = JSON.parse(e.data) as ChatEvent
      setEvents((prev) => [...prev, event])
      if (event.kind === 'turn_end' || event.kind === 'error') {
        setLocalWaiting(false)
      }
    }
    eventSource.onerror = () => setLoading(false)
    return () => eventSource.close()
  }, [sessionId])

  const folded = useMemo(() => fold(events), [events])

  isFirstRef.current = folded.messages.length === 0

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

  // The single seam where a message reaches the agent (applies the outgoing
  // transform). Used for an immediate send and for draining the queue. When ACP
  // gains native mid-turn input, this is what changes — not the queue/UX.
  const deliver = useCallback(
    (value: string) => {
      if (!sessionId) {
        return
      }
      const transform = transformRef.current
      const isFirst = isFirstRef.current
      const text = transform ? transform(value, isFirst) : value
      if (isFirst) {
        titleRequestedRef.current = true
      }
      setLocalWaiting(true)
      startSending(async () => {
        try {
          await promptLocal({ data: { sessionId, text } })
        } catch (error) {
          console.error('promptLocal failed', error)
          setLocalWaiting(false)
        }
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
      if (waitingRef.current) {
        // A turn is in progress — ACP can't take a second prompt, so queue it.
        // The turn-end effect drains the queue one message at a time.
        queueIdRef.current += 1
        const id = `q${queueIdRef.current}`
        setQueue((q) => [...q, { id, text: value }])
        return
      }
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

  // "Tell what to do different": ACP can't attach a reason to a rejection, so we
  // reject the request, cancel the run, then queue the typed guidance at the
  // front — the queue delivers it once the interrupted turn has stopped.
  const respondPermissionText = useCallback(
    (requestId: string, text: string) => {
      resolvePermission(requestId)
      const value = text.trim()
      if (!value || !sessionId) {
        return
      }
      void cancelLocal({ data: sessionId })
      queueIdRef.current += 1
      const id = `q${queueIdRef.current}`
      setQueue((q) => [{ id, text: value }, ...q])
    },
    [sessionId, resolvePermission],
  )

  const waiting = folded.waiting || localWaiting
  waitingRef.current = waiting

  // Drain the queue one message per turn: when no turn is active and messages
  // are waiting, deliver the next. deliver() sets waiting again, so subsequent
  // messages wait for the turn each one starts to finish.
  useEffect(() => {
    if (waiting || !sessionId || queue.length === 0) {
      return
    }
    const [next, ...rest] = queue
    setQueue(rest)
    deliver(next.text)
  }, [waiting, sessionId, queue, deliver])

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
    ],
  )

  const removeQueued = useCallback((id: string) => {
    setQueue((q) => q.filter((m) => m.id !== id))
  }, [])

  return useMemo(
    () => ({
      session,
      permissions: folded.permissions,
      asks: folded.asks,
      queue,
      resolvePermission,
      resolveAsk,
      respondPermissionText,
      removeQueued,
    }),
    [
      session,
      folded.permissions,
      folded.asks,
      queue,
      resolvePermission,
      resolveAsk,
      respondPermissionText,
      removeQueued,
    ],
  )
}
