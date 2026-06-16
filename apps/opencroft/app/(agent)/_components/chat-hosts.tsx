'use client'

import { PermissionRequest } from 'agent-chat/messages'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Input } from 'ui/input'

import {
  type AcpSession,
  type LocalSource,
  type PendingAsk,
  useAcpSession,
} from '@/app/(agent)/_components/use-acp-session'
import { useOverlay } from '@/app/(dashboard)/_canvas/overlay-context'
import { AgentChat, AgentChatInput, type AgentSession, useAgentSession } from '@/app/(openclaw)/_components/agent-chat'
import { cn } from '@/lib/utils'

interface AgentMeta {
  name: string
  avatar?: string
}

type Transform = (text: string, isFirstMessage: boolean) => string

interface HostProps {
  transformOutgoing: Transform
  activeAgent?: AgentMeta
  createButton: ReactNode
  focused: boolean
  onFocusChange: (focused: boolean) => void
}

function ChatHost({
  session,
  activeAgent,
  createButton,
  focused,
  onFocusChange,
  approvals,
  defaultExpanded,
}: {
  session: AgentSession
  activeAgent?: AgentMeta
  createButton: ReactNode
  focused: boolean
  onFocusChange: (focused: boolean) => void
  approvals?: ReactNode
  defaultExpanded?: boolean
}) {
  const [slashOpen, setSlashOpen] = useState(false)
  const showChat = focused && !slashOpen

  const contentNode = useMemo(() => {
    if (!showChat) {
      return null
    }
    return (
      <>
        <AgentChat
          session={session}
          agentAvatar={activeAgent?.avatar}
          agentName={activeAgent?.name}
          defaultExpanded={defaultExpanded}
        />
        {approvals}
      </>
    )
  }, [showChat, session, activeAgent, approvals, defaultExpanded])

  useOverlay({ content: contentNode })

  return (
    <AgentChatInput
      session={session}
      placeholder='Ask AI...'
      onSlashOpenChange={setSlashOpen}
      onFocus={() => onFocusChange(true)}
      leadingBarContent={createButton}
    />
  )
}

export function OpenclawAgentHost({
  sessionKey,
  transformOutgoing,
  activeAgent,
  createButton,
  focused,
  onFocusChange,
}: HostProps & { sessionKey: string }) {
  const session = useAgentSession(sessionKey, transformOutgoing)
  return (
    <ChatHost
      session={session}
      activeAgent={activeAgent}
      createButton={createButton}
      focused={focused}
      onFocusChange={onFocusChange}
    />
  )
}

export function LocalAgentHost({
  source,
  transformOutgoing,
  activeAgent,
  createButton,
  focused,
  onFocusChange,
}: HostProps & { source: LocalSource }) {
  const acp = useAcpSession(source, transformOutgoing, activeAgent?.name)
  // Stable element identity so ChatHost's memoized content (and the published
  // overlay slot) don't re-fire every render — that would be an infinite update loop.
  const approvals = useMemo(() => <Approvals acp={acp} />, [acp])
  return (
    <ChatHost
      session={acp.session}
      activeAgent={activeAgent}
      createButton={createButton}
      focused={focused}
      onFocusChange={onFocusChange}
      approvals={approvals}
      defaultExpanded
    />
  )
}

// Approvals can pop in while the user is mid-tap on something else (e.g. while
// expanding a tool call). Animate them in and ignore pointer input until the
// entrance settles, so a tap meant for the chat doesn't accidentally resolve a
// freshly-appeared request.
const APPEAR_LOCKOUT_MS = 550

function AppearGuard({ children }: { children: ReactNode }) {
  const [locked, setLocked] = useState(true)
  useEffect(() => {
    const t = setTimeout(() => setLocked(false), APPEAR_LOCKOUT_MS)
    return () => clearTimeout(t)
  }, [])
  return (
    <div
      className={cn('animate-in fade-in slide-in-from-bottom-2 duration-500', locked && 'pointer-events-none')}
      aria-busy={locked}
    >
      {children}
    </div>
  )
}

function Approvals({ acp }: { acp: AcpSession }) {
  if (acp.permissions.length === 0 && acp.asks.length === 0) {
    return null
  }
  return (
    <div className='flex flex-col gap-2 px-4 pb-2'>
      {acp.permissions.map((p) => (
        <AppearGuard key={p.requestId}>
          <PermissionRequest
            message={{
              id: p.requestId,
              kind: 'permission',
              requestId: p.requestId,
              title: p.title,
              options: p.options,
              resolved: false,
            }}
            onRespond={acp.resolvePermission}
            onRespondText={acp.respondPermissionText}
          />
        </AppearGuard>
      ))}
      {acp.asks.map((a) => (
        <AppearGuard key={a.requestId}>
          <AskPrompt ask={a} onAnswer={acp.resolveAsk} />
        </AppearGuard>
      ))}
    </div>
  )
}

function AskPrompt({ ask, onAnswer }: { ask: PendingAsk; onAnswer: (requestId: string, answer?: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className='flex flex-col gap-1.5 rounded-md border bg-muted/40 p-2.5'>
      <div className='text-xs font-medium'>{ask.message}</div>
      <div className='flex gap-1.5'>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className='h-7 text-xs'
          placeholder='Your answer…'
        />
        <Button size='sm' className='h-7 text-xs' onClick={() => onAnswer(ask.requestId, value)}>
          Send
        </Button>
        <Button size='sm' variant='ghost' className='h-7 text-xs' onClick={() => onAnswer(ask.requestId)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
