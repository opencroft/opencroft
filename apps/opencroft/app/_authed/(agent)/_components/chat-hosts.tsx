'use client'

import type { SessionConfigOption } from '@agentclientprotocol/sdk'
import { ArrowLeft, Pencil } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Button } from 'ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from 'ui/dialog'
import { Input } from 'ui/input'

import { AgentChat, type AgentSession } from '@/app/_authed/(agent)/_components/agent-chat'
import { Approvals } from '@/app/_authed/(agent)/_components/approvals'
import { AgentCommandBarHost } from '@/app/_authed/(agent)/_components/command-bar-host'
import { type LocalSource, type QueuedMessage, useAcpSession } from '@/app/_authed/(agent)/_components/use-acp-session'
import { useOverlay } from '@/app/_authed/(dashboard)/_canvas/overlay-context'

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
  //   'none' — nothing docked; the command bar offers its own menu on focus
  //            instead, so the inspector page is never shown in both places.
  // The two surfaces answer different questions and are therefore two views:
  // `listView` is the inspector's page 1 — the conversations that exist.
  // `menuView` is the command bar's — the agents a new chat can be started
  // with. Neither is a filtered version of the other.
  listView?: ReactNode
  menuView?: ReactNode
  inspectorPage?: 'list' | 'chat' | 'none'
  onBack?: () => void
  // Page-2 header: current session title + a rename control.
  sessionTitle?: string
  onRename?: (title: string) => void
  // Apply a title the agent self-reported on the first reply (see use-acp-session).
  onAutoTitle?: (title: string) => void
  // Force the session list into the command-bar menu regardless of the inspector
  // page — lets the start icon open a session picker while a chat is docked.
  forceListMenu?: boolean
  // Clicking the command bar's Sparkles start icon opens that session picker.
  onOpenSessions?: () => void
  // This session's persisted composer draft (unsent text), loaded into the
  // composer when it opens. Distinct from AgentSession.draft, which stages
  // edit-message text — this is the session-list-level persisted value.
  savedDraft?: string
  // Save (or clear, with '') the given session's draft. Debounced by the
  // composer; called with the session key so a flush during a session switch
  // always targets the session the text actually belongs to.
  onDraftChange?: (key: string, text: string) => void
}

function ChatHost({
  session,
  agentNodeId,
  activeAgent,
  createButton,
  focused,
  onFocusChange,
  approvals,
  defaultExpanded,
  queued,
  onRemoveQueued,
  configOptions,
  onSetConfigOption,
  usage,
  listView,
  menuView,
  inspectorPage = 'chat',
  onBack,
  sessionTitle,
  onRename,
  forceListMenu,
  onOpenSessions,
  savedDraft,
  onDraftChange,
}: {
  session: AgentSession
  agentNodeId?: string
  activeAgent?: AgentMeta
  createButton: ReactNode
  focused: boolean
  onFocusChange: (focused: boolean) => void
  approvals?: ReactNode
  defaultExpanded?: boolean
  queued?: QueuedMessage[]
  onRemoveQueued?: (id: string) => void
  configOptions?: SessionConfigOption[]
  onSetConfigOption?: (configId: string, value: string | boolean) => void
  usage?: { used: number; size?: number }
  listView?: ReactNode
  menuView?: ReactNode
  inspectorPage?: 'list' | 'chat' | 'none'
  onBack?: () => void
  sessionTitle?: string
  onRename?: (title: string) => void
  forceListMenu?: boolean
  onOpenSessions?: () => void
  savedDraft?: string
  onDraftChange?: (key: string, text: string) => void
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

  // When no inspector page is open, focusing the input surfaces the command
  // bar's own menu. Gated on `focused` (which stays set while the user
  // interacts with the menu), so picking from it isn't lost to a blur. The
  // start icon (`forceListMenu`) opens the same menu while a chat is docked.
  const focusMenu = forceListMenu || (focused && inspectorPage === 'none') ? menuView : undefined

  // ChatHost renders no visible DOM of its own: it mounts inside the canvas
  // container underneath the absolutely-positioned canvas/overlay layers, so
  // anything emitted here is painted over. All real UI — the conversation, the
  // composer, and the queued-messages list — is published into overlay slots
  // (content/header above, bar via AgentCommandBarHost).
  return (
    <AgentCommandBarHost
      session={session}
      agentNodeId={agentNodeId}
      placeholder='Ask AI...'
      onFocus={() => onFocusChange(true)}
      leadingBarContent={createButton}
      focusMenu={focusMenu}
      onStartIconClick={onOpenSessions}
      queued={queued}
      onRemoveQueued={onRemoveQueued}
      configOptions={configOptions}
      onSetConfigOption={onSetConfigOption}
      usage={usage}
      savedDraft={savedDraft}
      onDraftChange={onDraftChange}
      sendError={session.sendError}
      onDismissSendError={session.dismissSendError}
    />
  )
}

export function RenameDialog({
  open,
  onOpenChange,
  title,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  onSubmit: (title: string) => void
}) {
  const [draft, setDraft] = useState(title)
  useEffect(() => {
    if (open) {
      setDraft(title)
    }
  }, [open, title])
  const commit = () => {
    onSubmit(draft)
    onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
              commit()
            }
          }}
        />
        <DialogFooter>
          <Button variant='ghost' onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={commit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
          onClick={() => setRenaming(true)}
          className='inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground cursor-pointer'
          aria-label='Rename session'
          title='Rename session'
        >
          <Pencil className='size-3.5' />
        </button>
      )}
      {onRename && <RenameDialog open={renaming} onOpenChange={setRenaming} title={title ?? ''} onSubmit={onRename} />}
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
  menuView,
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
  menuView?: ReactNode
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
      menuView={menuView}
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
  menuView,
  inspectorPage,
  onBack,
  sessionTitle,
  onRename,
  onAutoTitle,
  forceListMenu,
  onOpenSessions,
  savedDraft,
  onDraftChange,
}: HostProps & { source: LocalSource }) {
  const acp = useAcpSession(source, transformOutgoing, activeAgent?.name, onAutoTitle)
  // Stable element identity so ChatHost's memoized content (and the published
  // overlay slot) don't re-fire every render — that would be an infinite update loop.
  const approvals = useMemo(() => <Approvals acp={acp} />, [acp])
  return (
    <ChatHost
      session={acp.session}
      agentNodeId={source.agentNodeId}
      activeAgent={activeAgent}
      createButton={createButton}
      focused={focused}
      onFocusChange={onFocusChange}
      approvals={approvals}
      defaultExpanded
      queued={acp.queue}
      onRemoveQueued={acp.removeQueued}
      configOptions={acp.configOptions}
      onSetConfigOption={acp.setConfigOption}
      usage={acp.usage}
      listView={listView}
      menuView={menuView}
      inspectorPage={inspectorPage}
      onBack={onBack}
      sessionTitle={sessionTitle}
      onRename={onRename}
      forceListMenu={forceListMenu}
      onOpenSessions={onOpenSessions}
      savedDraft={savedDraft}
      onDraftChange={onDraftChange}
    />
  )
}
