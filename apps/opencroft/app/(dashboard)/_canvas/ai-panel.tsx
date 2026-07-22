'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AgentSessionGroup,
  AgentSessionList,
  type AgentRef as SessionAgentRef,
  type AgentJobRef as SessionJobRef,
} from 'ui/sessions/agent-session-list'

import { DashboardHost, LocalAgentHost } from '@/app/(agent)/_components/chat-hosts'
import { useChatTabsMaybe } from '@/app/(agent)/_lib/chat-tabs-context'
import { useAgentSessions } from '@/app/(agent)/_lib/use-agent-sessions'
import type { SessionEntry } from '@/app/(agent)/_server/agent-sessions-store'
import { slug } from '@/app/(server)/_server/types'
import { type AgentJobRef, type AgentNodeRef, listAgentNodes } from '@/app/(space)/_server/agents'

interface AiPanelProps {
  spaceName: string
  spaceSlug: string
  selectedNodeId: string | null
  focused: boolean
  onFocusChange: (focused: boolean) => void
}

// SessionEntry now lives in the server store (agent-sessions-store.ts), synced
// via the shared useAgentSessions hook; the type is imported above.

// Sentinel key for the "no session selected" state; namespaces the chat-tabs
// fallback so a dashboard view never collides with a real session.
const DASHBOARD_KEY = 'agent:dashboard'
// Sent with every message: the space and the node currently selected on the canvas.
const systemTag = (spaceName: string, spaceSlug: string, selectedNodeId: string | null) =>
  `<opencroft-system>Sent from OpenCroft space: ${spaceName} (${spaceSlug}). Selected node: ${selectedNodeId ?? 'none'}. This may or may not relate to the current request.</opencroft-system>`
// Injected on the first message of a session: asks the agent to lead its reply
// with a self-titled chat name, which use-acp-session parses out to rename the
// tab. No literal nested opencroft tag here — a nested close would truncate the
// render-time stripOpencroftTags match and leak the instruction into the bubble.
const TITLE_REQUEST =
  '<opencroft-title-request>Begin your very first reply with a concise title that summarizes this request: maximum 5 words, Title Case, no quotes or trailing punctuation. Put it on its own first line wrapped in an opencroft-title tag (opening and closing), then continue your normal reply on the next lines. Do this only in this first reply.</opencroft-title-request>'

function resolveJobForSession(
  sessionKey: string,
  sessions: SessionEntry[],
  agents: AgentNodeRef[],
): { job: AgentJobRef | null; agent: AgentNodeRef | null } {
  const local = sessions.find((s) => s.key === sessionKey)
  if (local) {
    const agent = agents.find((a) => a.nodeId === local.agentNodeId)
    return { job: agent?.jobs.find((j) => j.nodeId === local.jobNodeId) ?? null, agent: agent ?? null }
  }
  const parts = sessionKey.split(':')
  if (parts.length < 3 || parts[0] !== 'agent') {
    return { job: null, agent: null }
  }
  const agentSlug = parts[1].trim().toLowerCase()
  const jobSlug = parts.slice(2).join(':').trim().toLowerCase()
  const agent = agents.find((a) => slug(a.name) === agentSlug)
  return { job: agent?.jobs.find((j) => slug(j.name) === jobSlug) ?? null, agent: agent ?? null }
}

export function AiPanel({ spaceName, spaceSlug, selectedNodeId, focused, onFocusChange }: AiPanelProps) {
  const [agents, setAgents] = useState<AgentNodeRef[]>([])
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const chatTabs = useChatTabsMaybe()
  const { sessions, upsertSession, renameSession, deleteSession } = useAgentSessions()

  // Set fallback key for chat tabs context
  useEffect(() => {
    if (chatTabs) {
      chatTabs.setFallbackKey(DASHBOARD_KEY)
    }
  }, [chatTabs])

  // The active session is owned by the chat-tabs provider (single source of
  // truth, mirrored to the URL there). Fall back to the dashboard key = "none".
  const activeSessionKey = chatTabs?.activeSessionKey || DASHBOARD_KEY

  const transformOutgoing = useCallback(
    (text: string, isFirstMessage: boolean) => {
      if (text.trim().startsWith('/')) {
        return text
      }
      const system = systemTag(spaceName, spaceSlug, selectedNodeId)
      if (!isFirstMessage) {
        return `${system}\n${text}`
      }
      const { job, agent } = resolveJobForSession(activeSessionKey, sessions, agents)
      const ctx = job?.context.trim()
      let prefix = `${system}\n${TITLE_REQUEST}`
      if (ctx) {
        prefix += `\n<opencroft-task>${ctx}</opencroft-task>`
      }
      for (const instr of agent?.instructions ?? []) {
        const trimmed = instr.instruction.trim()
        if (trimmed) {
          prefix += `\n<opencroft-instruction>${trimmed}</opencroft-instruction>`
        }
      }
      return `${prefix}\n${text}`
    },
    [spaceName, spaceSlug, selectedNodeId, activeSessionKey, sessions, agents],
  )

  useEffect(() => {
    listAgentNodes().then(setAgents)
  }, [])

  const createSession = useCallback(
    (agent: SessionAgentRef, job: SessionJobRef) => {
      // Always start a fresh session — a job can have many. The unique suffix
      // keeps each session (and its lazily-created ACP session, keyed by tabKey)
      // distinct; resolution reads the stored entry, so the suffix never has to
      // be parsed back out.
      const key = `agent:${slug(agent.name)}:${slug(job.name)}:${Date.now().toString(36)}`
      const sameJob = sessions.filter((s) => s.agentNodeId === agent.nodeId && s.jobNodeId === job.nodeId).length
      const title = sameJob === 0 ? job.name : `${job.name} ${sameJob + 1}`
      upsertSession({
        key,
        agentNodeId: agent.nodeId,
        agentName: agent.name,
        jobNodeId: job.nodeId,
        jobName: job.name,
        title,
        createdAt: Date.now(),
      })
      setSessionPickerOpen(false)
      // Open with meta so a freshly created session doesn't render as its raw
      // key suffix before the updateTabMeta effect catches up — same shape the
      // effect and the sidebar use.
      chatTabs?.selectSession(key, { label: `${agent.name}: ${title}`, agentName: agent.name, title })
    },
    [sessions, upsertSession, chatTabs],
  )

  // Stable per active session: an inline arrow here would give the docked
  // inspector header a new identity every render, churning the header slot into
  // the same setState loop as the list. activeSessionKey === the active entry's key.
  const handleRename = useCallback(
    (title: string) => renameSession(activeSessionKey, title),
    [renameSession, activeSessionKey],
  )

  const activeAgent = useMemo(() => {
    const local = sessions.find((s) => s.key === activeSessionKey)
    if (local) {
      return agents.find((a) => a.nodeId === local.agentNodeId)
    }
    const parts = activeSessionKey.split(':')
    if (parts.length < 3 || parts[0] !== 'agent') {
      return undefined
    }
    const agentSlug = parts[1].trim().toLowerCase()
    return agents.find((a) => slug(a.name) === agentSlug)
  }, [sessions, agents, activeSessionKey])

  const createButton = null

  // Clicking the Sparkles start icon opens the session list in the command-bar
  // menu for quick navigation, even while a chat is already docked. Stable
  // identity so the published bar slot doesn't churn every render.
  const openSessionsMenu = useCallback(() => {
    onFocusChange(true)
    setSessionPickerOpen(true)
  }, [onFocusChange])

  // Two-page chat inspector, driven by a 3-state page:
  //   'chat' — a session is active (the conversation)
  //   'list' — page 1, reached via the back button
  //   'none' — nothing docked; the focus hint offers the list instead
  const fallbackKey = DASHBOARD_KEY
  const hasActiveSession = activeSessionKey !== fallbackKey
  const [inspectorListOpen, setInspectorListOpen] = useState(false)
  // Drop back to the focus-hint state whenever the command bar loses focus, so
  // reopening starts from the hint rather than a stale page-1. The session picker
  // closes with it (the start icon is open-only; blur is how it dismisses).
  useEffect(() => {
    if (!focused) {
      setInspectorListOpen(false)
      setSessionPickerOpen(false)
    }
  }, [focused])
  const inspectorPage: 'list' | 'chat' | 'none' = hasActiveSession ? 'chat' : inspectorListOpen ? 'list' : 'none'

  // The sidebar's "Chats" entry requests the session list (the active session is
  // already cleared at the context source). Depend only on listRequest — keying
  // on chatTabs would re-fire on every selectSession and bounce back to the list.
  const listRequest = chatTabs?.listRequest ?? 0
  useEffect(() => {
    if (!listRequest) {
      return
    }
    setInspectorListOpen(true)
  }, [listRequest])

  const sessionGroups = useMemo<AgentSessionGroup[]>(
    () =>
      agents.map((agent) => ({
        agent,
        sessions: agentExistingSessions(agent, sessions).map((s) => ({
          key: s.key,
          title: s.title,
        })),
      })),
    [agents, sessions],
  )

  // Keep every open chat tab labelled with its session title, so the sidebar
  // shows readable names instead of the raw session-key suffix.
  useEffect(() => {
    if (!chatTabs) {
      return
    }
    for (const group of sessionGroups) {
      for (const session of group.sessions) {
        chatTabs.updateTabMeta(session.key, {
          label: `${group.agent.name}: ${session.title}`,
          agentName: group.agent.name,
          title: session.title,
          agentAvatar: group.agent.avatar,
        })
      }
    }
  }, [chatTabs, sessionGroups])

  // Opening or creating a session leaves page-1 and lands on the conversation.
  const openSession = useCallback(
    (key: string) => {
      setInspectorListOpen(false)
      setSessionPickerOpen(false)
      chatTabs?.selectSession(key)
    },
    [chatTabs],
  )

  // The list element is published into the command-bar menu slot, which re-sets
  // the slot whenever the node identity changes. Keep the handlers in a ref so
  // the element's identity tracks ONLY the data (sessionGroups) — depending on
  // the callbacks (whose identity can churn) re-set the slot every render and
  // drove an infinite setState loop.
  const actionsRef = useRef({ openSession, createSession, deleteSession })
  actionsRef.current = { openSession, createSession, deleteSession }

  const listView = useMemo(
    () => (
      <AgentSessionList
        groups={sessionGroups}
        onOpenSession={(key) => actionsRef.current.openSession(key)}
        onDeleteSession={(_agent, key) => actionsRef.current.deleteSession(key)}
        onCreateSession={(agent, job) => actionsRef.current.createSession(agent, job)}
      />
    ),
    [sessionGroups],
  )

  // Back from the conversation → page 1 (the list) in the inspector, without
  // materializing a tab (selectSession would add a persistent "dashboard" tab).
  const goToList = useCallback(() => {
    setInspectorListOpen(true)
    chatTabs?.setActiveKey(fallbackKey)
  }, [chatTabs])

  const activeEntry = sessions.find((s) => s.key === activeSessionKey)
  if (activeEntry) {
    return (
      <LocalAgentHost
        source={{ agentNodeId: activeEntry.agentNodeId, jobNodeId: activeEntry.jobNodeId, tabKey: activeEntry.key }}
        transformOutgoing={transformOutgoing}
        activeAgent={activeAgent}
        createButton={createButton}
        focused={focused}
        onFocusChange={onFocusChange}
        listView={listView}
        inspectorPage={inspectorPage}
        onBack={goToList}
        sessionTitle={activeEntry.title ?? activeEntry.jobName}
        onRename={handleRename}
        onAutoTitle={handleRename}
        forceListMenu={sessionPickerOpen}
        onOpenSessions={openSessionsMenu}
      />
    )
  }
  return (
    <DashboardHost
      sessionKey={activeSessionKey}
      activeAgent={activeAgent}
      createButton={createButton}
      focused={focused}
      onFocusChange={onFocusChange}
      listView={listView}
      inspectorPage={inspectorPage}
      onBack={goToList}
      forceListMenu={sessionPickerOpen}
      onOpenSessions={openSessionsMenu}
    />
  )
}

interface ExistingSession {
  key: string
  title: string
}

function agentExistingSessions(agent: AgentNodeRef, localSessions: SessionEntry[]): ExistingSession[] {
  return localSessions
    .filter((s) => s.agentNodeId === agent.nodeId)
    .map((s) => ({ key: s.key, title: s.title ?? s.jobName }))
}
