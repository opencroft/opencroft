'use client'

import { PermissionRequest } from 'agent-chat/messages'
import { ArrowLeft, Pencil, X } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from 'ui/dialog'
import { Input } from 'ui/input'

import { AgentChat, AgentChatInput, type AgentSession } from '@/app/(agent)/_components/agent-chat'
import {
  type AcpSession,
  type LocalSource,
  type PendingAsk,
  type QueuedMessage,
  useAcpSession,
} from '@/app/(agent)/_components/use-acp-session'
import { useOverlay } from '@/app/(dashboard)/_canvas/overlay-context'
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
  // Two-page chat inspector. The inspector shows one of three things:
  //   'list' — page 1, the agent/session list (reached via back)
  //   'chat' — page 2, the conversation
  //   'none' — nothing docked; the list is offered as a command-bar menu hint
  //            on focus instead (so the list is never shown in both places).
  // `listView` is the shared list, reused by page 1 and the focus hint.
  listView?: ReactNode
  inspectorPage?: 'list' | 'chat' | 'none'
  onBack?: () => void
  // Page-2 header: current session title + a rename control.
  sessionTitle?: string
  onRename?: (title: string) => void
  // Force the session list into the command-bar menu regardless of the inspector
  // page — lets the start icon open a session picker while a chat is docked.
  forceListMenu?: boolean
  // Clicking the command bar's Sparkles start icon opens that session picker.
  onOpenSessions?: () => void
}

function ChatHost({
  session,
  activeAgent,
  createButton,
  focused,
  onFocusChange,
  approvals,
  defaultExpanded,
  queued,
  onRemoveQueued,
  listView,
  inspectorPage = 'chat',
  onBack,
  sessionTitle,
  onRename,
  forceListMenu,
  onOpenSessions,
}: {
  session: AgentSession
  activeAgent?: AgentMeta
  createButton: ReactNode
  focused: boolean
  onFocusChange: (focused: boolean) => void
  approvals?: ReactNode
  defaultExpanded?: boolean
  queued?: QueuedMessage[]
  onRemoveQueued?: (id: string) => void
  listView?: ReactNode
  inspectorPage?: 'list' | 'chat' | 'none'
  onBack?: () => void
  sessionTitle?: string
  onRename?: (title: string) => void
  forceListMenu?: boolean
  onOpenSessions?: () => void
}) {
  const showChat = focused

  const contentNode = useMemo(() => {
    if (!showChat || inspectorPage === 'none') {
      // 'none' → nothing docked; the focus menu (below) offers the list instead.
      return null
    }
    if (inspectorPage === 'list') {
      return listView ?? null
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
  }, [showChat, inspectorPage, listView, session, activeAgent, approvals, defaultExpanded])

  // On the conversation page, dock a back + rename control into the inspector header.
  const headerNode = useMemo(() => {
    if (!showChat || inspectorPage !== 'chat' || !onBack) {
      return null
    }
    return <ChatHeader onBack={onBack} title={sessionTitle ?? activeAgent?.name} onRename={onRename} />
  }, [showChat, inspectorPage, onBack, sessionTitle, activeAgent, onRename])

  useOverlay({ content: contentNode, header: headerNode })

  // When no inspector page is open, focusing the input surfaces the same list as
  // a command-bar menu hint. Gated on `focused` (which stays set while the user
  // interacts with the menu), so picking a session isn't lost to a blur. The
  // start icon (`forceListMenu`) opens the same list while a chat is docked.
  const focusMenu = forceListMenu || (focused && inspectorPage === 'none') ? listView : undefined

  return (
    <div className='flex min-w-0 flex-col gap-1'>
      {queued && queued.length > 0 && onRemoveQueued && <QueuedMessages items={queued} onRemove={onRemoveQueued} />}
      <AgentChatInput
        session={session}
        placeholder='Ask AI...'
        onFocus={() => onFocusChange(true)}
        leadingBarContent={createButton}
        focusMenu={focusMenu}
        onStartIconClick={onOpenSessions}
      />
    </div>
  )
}

function ChatHeader({
  onBack,
  title,
  onRename,
}: {
  onBack: () => void
  title?: string
  onRename?: (title: string) => void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  return (
    <div className='flex min-w-0 flex-1 items-center gap-1'>
      <button
        type='button'
        onClick={onBack}
        className='flex shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer'
        aria-label='Back to sessions'
      >
        <ArrowLeft className='size-4 shrink-0' />
        {title ? <span className='max-w-40 truncate'>{title}</span> : null}
      </button>
      {onRename && (
        <button
          type='button'
          onClick={() => {
            setDraft(title ?? '')
            setRenaming(true)
          }}
          className='inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer'
          aria-label='Rename session'
          title='Rename session'
        >
          <Pencil className='size-3.5' />
        </button>
      )}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className='max-w-sm'>
          <DialogHeader>
            <DialogTitle>Rename session</DialogTitle>
          </DialogHeader>
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder='Session name'
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                onRename?.(draft)
                setRenaming(false)
              }
            }}
          />
          <DialogFooter>
            <Button variant='ghost' onClick={() => setRenaming(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                onRename?.(draft)
                setRenaming(false)
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function QueuedMessages({ items, onRemove }: { items: QueuedMessage[]; onRemove: (id: string) => void }) {
  return (
    <div className='flex min-w-0 flex-col gap-1 px-2'>
      {items.map((m) => (
        <div key={m.id} className='flex min-w-0 items-center gap-2 rounded-md border bg-muted/40 px-2 py-1 text-xs'>
          <span className='shrink-0 text-muted-foreground'>Queued</span>
          <span className='min-w-0 flex-1 truncate'>{m.text}</span>
          <button
            type='button'
            onClick={() => onRemove(m.id)}
            className='shrink-0 text-muted-foreground transition-colors hover:text-foreground'
            title='Remove from queue'
          >
            <X className='size-3.5' />
          </button>
        </div>
      ))}
    </div>
  )
}

// Shown when no session is selected: the composer stays present (so the command
// bar is usable and the session picker is reachable), but send is disabled until
// the user picks an agent/job from the list.
export function DashboardHost({
  sessionKey,
  activeAgent,
  createButton,
  focused,
  onFocusChange,
  listView,
  inspectorPage,
  onBack,
  forceListMenu,
  onOpenSessions,
}: {
  sessionKey: string
  activeAgent?: AgentMeta
  createButton: ReactNode
  focused: boolean
  onFocusChange: (focused: boolean) => void
  listView?: ReactNode
  inspectorPage?: 'list' | 'chat' | 'none'
  onBack?: () => void
  forceListMenu?: boolean
  onOpenSessions?: () => void
}) {
  const session = useMemo<AgentSession>(
    () => ({
      sessionKey,
      messages: [],
      loading: false,
      sending: false,
      waiting: false,
      botName: 'assistant',
      send: () => {},
      disabled: true,
    }),
    [sessionKey],
  )
  return (
    <ChatHost
      session={session}
      activeAgent={activeAgent}
      createButton={createButton}
      focused={focused}
      onFocusChange={onFocusChange}
      listView={listView}
      inspectorPage={inspectorPage}
      onBack={onBack}
      forceListMenu={forceListMenu}
      onOpenSessions={onOpenSessions}
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
  listView,
  inspectorPage,
  onBack,
  sessionTitle,
  onRename,
  forceListMenu,
  onOpenSessions,
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
      queued={acp.queue}
      onRemoveQueued={acp.removeQueued}
      listView={listView}
      inspectorPage={inspectorPage}
      onBack={onBack}
      sessionTitle={sessionTitle}
      onRename={onRename}
      forceListMenu={forceListMenu}
      onOpenSessions={onOpenSessions}
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
