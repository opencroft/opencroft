'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type AgentSessionGroup, AgentSessionList } from '@/app/(agent)/_components/agent-session-list'
import { LocalAgentHost, OpenclawAgentHost } from '@/app/(agent)/_components/chat-hosts'
import { forgetLocalSession } from '@/app/(agent)/_server/acp'
import { useChatTabsMaybe } from '@/app/(openclaw)/_lib/chat-tabs-context'
import { deleteSession, loadOpenclaw, type OpenclawAgent } from '@/app/(openclaw)/_server/actions'
import { slug } from '@/app/(server)/_server/types'
import { type AgentJobRef, type AgentNodeRef, listAgentNodes } from '@/app/(space)/_server/agents'

interface AiPanelProps {
  agentId: string
  spaceName: string
  spaceSlug: string
  selectedNodeId: string | null
  focused: boolean
  onFocusChange: (focused: boolean) => void
}

interface SessionEntry {
  key: string
  agentNodeId: string
  agentName: string
  jobNodeId: string
  jobName: string
  // User-facing session title; defaults to the job name (with a counter when a
  // job has more than one session) and is editable via the rename control.
  title?: string
  createdAt: number
  backend: 'openclaw' | 'local'
}

const SESSIONS_STORAGE_KEY = 'opencroft.aiPanel.sessions'

function loadStoredSessions(): SessionEntry[] {
  if (typeof window === 'undefined') {
    return []
  }
  const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY)
  if (!raw) {
    return []
  }
  const parsed = JSON.parse(raw) as SessionEntry[]
  return Array.isArray(parsed) ? parsed : []
}

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

function persistSessions(list: SessionEntry[]) {
  if (typeof window === 'undefined') {
    return
  }
  window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(list))
}

export function AiPanel({ agentId, spaceName, spaceSlug, selectedNodeId, focused, onFocusChange }: AiPanelProps) {
  const [agents, setAgents] = useState<AgentNodeRef[]>([])
  const [externalAgents, setExternalAgents] = useState<OpenclawAgent[]>([])
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const chatTabs = useChatTabsMaybe()

  // Set fallback key for chat tabs context
  useEffect(() => {
    if (chatTabs) {
      chatTabs.setFallbackKey(`agent:${agentId}:dashboard`)
    }
  }, [agentId, chatTabs])

  useEffect(() => {
    setSessions(loadStoredSessions())
  }, [])

  // The active session is owned by the chat-tabs provider (single source of
  // truth, mirrored to the URL there). Fall back to the dashboard key = "none".
  const activeSessionKey = chatTabs?.activeSessionKey || `agent:${agentId}:dashboard`

  const transformOutgoing = useCallback(
    (text: string, isFirstMessage: boolean) => {
      if (text.trim().startsWith('/')) {
        return text
      }
      const system = `<opencroft-system>Sent from OpenCroft space: ${spaceName} (${spaceSlug}). Selected node: ${selectedNodeId ?? 'none'}.</opencroft-system>`
      if (!isFirstMessage) {
        return `${system}\n${text}`
      }
      const { job, agent } = resolveJobForSession(activeSessionKey, sessions, agents)
      const ctx = job?.context.trim()
      if (!ctx && !agent?.instructions.length) {
        return `${system}\n${text}`
      }
      let prefix = system
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
    loadOpenclaw()
      .then((state) => {
        if (state.status === 'ok') {
          setExternalAgents(state.agents)
        } else {
          setExternalAgents([])
        }
      })
      .catch(() => {
        setExternalAgents([])
      })
  }, [])

  const externalById = useMemo(() => {
    const map = new Map<string, OpenclawAgent>()
    for (const ext of externalAgents) {
      map.set(ext.agentId, ext)
    }
    return map
  }, [externalAgents])

  const permanentlyDeleteSession = useCallback(
    (key: string) => {
      chatTabs?.closeTab(key)
      setSessions((prev) => {
        const next = prev.filter((s) => s.key !== key)
        persistSessions(next)
        return next
      })
      setExternalAgents((prev) =>
        prev.map((a) => ({
          ...a,
          sessions: a.sessions.filter((s) => s.key !== key),
          sessionCount: Math.max(0, a.sessionCount - (a.sessions.some((s) => s.key === key) ? 1 : 0)),
        })),
      )
      deleteSession({ data: key }).catch((err) => {
        console.error('Failed to delete OpenClaw session', key, err)
      })
    },
    [chatTabs],
  )

  const deleteLocalSessionEntry = useCallback(
    (key: string) => {
      chatTabs?.closeTab(key)
      setSessions((prev) => {
        const next = prev.filter((s) => s.key !== key)
        persistSessions(next)
        return next
      })
      forgetLocalSession({ data: key }).catch((err) => {
        console.error('Failed to delete local session', key, err)
      })
    },
    [chatTabs],
  )

  const createSession = useCallback(
    (agent: AgentNodeRef, job: AgentJobRef) => {
      // Always start a fresh session — a job can have many. The unique suffix
      // keeps each session (and its lazily-created ACP session, keyed by tabKey)
      // distinct; resolution reads the stored entry, so the suffix never has to
      // be parsed back out.
      const key = `agent:${slug(agent.name)}:${slug(job.name)}:${Date.now().toString(36)}`
      const sameJob = sessions.filter((s) => s.agentNodeId === agent.nodeId && s.jobNodeId === job.nodeId).length
      const title = sameJob === 0 ? job.name : `${job.name} ${sameJob + 1}`
      const entry: SessionEntry = {
        key,
        agentNodeId: agent.nodeId,
        agentName: agent.name,
        jobNodeId: job.nodeId,
        jobName: job.name,
        title,
        createdAt: Date.now(),
        backend: agent.backend,
      }
      setSessions((prev) => {
        const next = [...prev, entry]
        persistSessions(next)
        return next
      })
      setSessionPickerOpen(false)
      chatTabs?.selectSession(key)
    },
    [sessions, chatTabs],
  )

  const renameSession = useCallback(
    (key: string, title: string) => {
      const trimmed = title.trim()
      if (!trimmed) {
        return
      }
      setSessions((prev) => {
        const next = prev.map((s) => (s.key === key ? { ...s, title: trimmed } : s))
        persistSessions(next)
        return next
      })
      chatTabs?.updateTabMeta(key, { label: trimmed })
    },
    [chatTabs],
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
  const fallbackKey = `agent:${agentId}:dashboard`
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

  const sessionGroups = useMemo<AgentSessionGroup[]>(
    () =>
      agents.map((agent) => ({
        agent,
        sessions: agentExistingSessions(agent, externalById.get(slug(agent.name)), sessions).map((s) => ({
          key: s.key,
          title: s.title,
        })),
      })),
    [agents, externalById, sessions],
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
  const actionsRef = useRef({ openSession, createSession, deleteLocalSessionEntry, permanentlyDeleteSession })
  actionsRef.current = { openSession, createSession, deleteLocalSessionEntry, permanentlyDeleteSession }

  const listView = useMemo(
    () => (
      <AgentSessionList
        groups={sessionGroups}
        onOpenSession={(key) => actionsRef.current.openSession(key)}
        onDeleteSession={(agent, key) =>
          agent.backend === 'local'
            ? actionsRef.current.deleteLocalSessionEntry(key)
            : actionsRef.current.permanentlyDeleteSession(key)
        }
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
  }, [chatTabs, fallbackKey])

  const activeEntry = sessions.find((s) => s.key === activeSessionKey)
  if (activeEntry?.backend === 'local') {
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
        forceListMenu={sessionPickerOpen}
        onOpenSessions={openSessionsMenu}
      />
    )
  }
  return (
    <OpenclawAgentHost
      sessionKey={activeSessionKey}
      transformOutgoing={transformOutgoing}
      activeAgent={activeAgent}
      createButton={createButton}
      focused={focused}
      onFocusChange={onFocusChange}
      listView={listView}
      inspectorPage={inspectorPage}
      onBack={goToList}
      sessionTitle={activeEntry ? (activeEntry.title ?? activeEntry.jobName) : undefined}
      onRename={activeEntry ? handleRename : undefined}
      forceListMenu={sessionPickerOpen}
      onOpenSessions={openSessionsMenu}
    />
  )
}

interface ExistingSession {
  key: string
  title: string
}

function agentExistingSessions(
  agent: AgentNodeRef,
  externalAgent: OpenclawAgent | undefined,
  localSessions: SessionEntry[],
): ExistingSession[] {
  if (agent.backend === 'local') {
    return localSessions
      .filter((s) => s.agentNodeId === agent.nodeId)
      .map((s) => ({ key: s.key, title: s.title ?? s.jobName }))
  }
  return (externalAgent?.sessions ?? []).map((s) => ({ key: s.key, title: s.title ?? s.key.split(':').pop() ?? s.key }))
}
