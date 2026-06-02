'use client'

import type { ChatEvent, PermissionOpt } from 'agent-client/types'
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { ensureLocalSession, promptLocal, respondLocal } from '@/app/(agent)/_server/acp'
import type { AgentSession } from '@/app/(openclaw)/_components/agent-chat'
import type { OpenclawMessage, OpenclawPart } from '@/app/(openclaw)/_lib/messages'

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

export interface AcpSession {
  session: AgentSession
  permissions: PendingPermission[]
  asks: PendingAsk[]
  resolvePermission: (requestId: string, optionId?: string) => void
  resolveAsk: (requestId: string, answer?: string) => void
}

type ToolPart = Extract<OpenclawPart, { type: 'tool-call' }>

function toolText(output: unknown): string {
  if (typeof output === 'string') {
    return output
  }
  return JSON.stringify(output ?? '', null, 2)
}

interface Folded {
  messages: OpenclawMessage[]
  permissions: PendingPermission[]
  asks: PendingAsk[]
  waiting: boolean
}

// Reduce the agent-client event log into the message shape AgentChat renders,
// plus the set of still-pending approval / elicitation prompts.
function fold(events: ChatEvent[]): Folded {
  const messages: OpenclawMessage[] = []
  const tools = new Map<string, ToolPart>()
  const permissions = new Map<string, PendingPermission>()
  const asks = new Map<string, PendingAsk>()
  let assistant: OpenclawMessage | null = null
  let waiting = false

  const ensureAssistant = (): OpenclawMessage => {
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

export function useAcpSession(source: LocalSource, transformOutgoing?: (text: string, isFirstMessage: boolean) => string, botName = 'assistant'): AcpSession {
  const { agentNodeId, jobNodeId, tabKey } = source
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [events, setEvents] = useState<ChatEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [localWaiting, setLocalWaiting] = useState(false)
  const [sending, startSending] = useTransition()
  // A message typed before the ACP session finished being created, queued so
  // the first message isn't dropped during the (slow first-spawn) handshake.
  const pending = useRef<string | null>(null)

  // Resolve (or lazily create) the live ACP session for this tab.
  useEffect(() => {
    let cancelled = false
    setSessionId(null)
    setEvents([])
    setLoading(true)
    setLocalWaiting(false)
    ensureLocalSession({ data: { agentNodeId, jobNodeId, tabKey } })
      .then((result) => {
        if (!cancelled) {
          setSessionId(result.sessionId)
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
    eventSource.onopen = () => setLoading(false)
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

  const isFirstMessage = folded.messages.length === 0
  const send = useCallback(
    (value: string) => {
      const text = transformOutgoing ? transformOutgoing(value, isFirstMessage) : value
      setLocalWaiting(true)
      if (!sessionId) {
        // Session is still being created — queue and flush once it's ready.
        pending.current = text
        return
      }
      startSending(async () => {
        try {
          await promptLocal({ data: { sessionId, text } })
        } catch (error) {
          console.error('promptLocal failed', error)
          setLocalWaiting(false)
        }
      })
    },
    [sessionId, transformOutgoing, isFirstMessage],
  )

  // Flush a message that was queued before the session existed.
  useEffect(() => {
    if (!sessionId || pending.current === null) {
      return
    }
    const text = pending.current
    pending.current = null
    promptLocal({ data: { sessionId, text } }).catch((error) => {
      console.error('promptLocal failed', error)
      setLocalWaiting(false)
    })
  }, [sessionId])

  const resolvePermission = useCallback((requestId: string, optionId?: string) => {
    void respondLocal({ data: { type: 'permission', requestId, optionId } })
  }, [])

  const resolveAsk = useCallback((requestId: string, answer?: string) => {
    void respondLocal({ data: { type: 'ask', requestId, answer } })
  }, [])

  const session = useMemo<AgentSession>(
    () => ({
      sessionKey: tabKey,
      messages: folded.messages,
      loading,
      sending,
      waiting: folded.waiting || localWaiting,
      botName,
      send,
    }),
    [tabKey, folded.messages, folded.waiting, loading, sending, localWaiting, botName, send],
  )

  return useMemo(() => ({ session, permissions: folded.permissions, asks: folded.asks, resolvePermission, resolveAsk }), [session, folded.permissions, folded.asks, resolvePermission, resolveAsk])
}
