'use client'

import { useLocation } from '@tanstack/react-router'
import { Briefcase, MessageSquare, Plus, Trash2, User } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from 'ui/dropdown-menu'

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
  const chatTabs = useChatTabsMaybe()
  const searchParams = new URLSearchParams(useLocation({ select: (l) => l.searchStr }))
  const chatParam = searchParams.get('chat') ?? null

  // Set fallback key for chat tabs context
  useEffect(() => {
    if (chatTabs) {
      chatTabs.setFallbackKey(`agent:${agentId}:dashboard`)
    }
  }, [agentId, chatTabs])

  useEffect(() => {
    setSessions(loadStoredSessions())
  }, [])

  // Sync active session from chat param
  useEffect(() => {
    if (!chatParam || !chatTabs) {
      return
    }
    chatTabs.setActiveKey(chatParam)
  }, [chatParam, chatTabs])

  // Determine active session key
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

  const unmatchedExternalAgents = useMemo(() => {
    const localSlugs = new Set(agents.map((a) => slug(a.name)))
    return externalAgents.filter((a) => !localSlugs.has(a.agentId))
  }, [agents, externalAgents])

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
      const key = `agent:${slug(agent.name)}:${slug(job.name)}`
      // Reuse the tab only when it matches the agent's current backend; a tab
      // from a previous backend is replaced. The live ACP session (for local)
      // is established lazily by LocalAgentHost on mount, not here.
      const existing = sessions.find((s) => s.key === key)
      if (existing && existing.backend === agent.backend) {
        chatTabs?.selectSession(key)
        return
      }
      const entry: SessionEntry = {
        key,
        agentNodeId: agent.nodeId,
        agentName: agent.name,
        jobNodeId: job.nodeId,
        jobName: job.name,
        createdAt: Date.now(),
        backend: agent.backend,
      }
      setSessions((prev) => {
        const next = [...prev.filter((s) => s.key !== key), entry]
        persistSessions(next)
        return next
      })
      chatTabs?.selectSession(key)
    },
    [sessions, chatTabs],
  )

  const selectExternalAgent = useCallback(
    (extAgent: OpenclawAgent) => {
      if (extAgent.sessions.length > 0) {
        const key = extAgent.sessions[0].key
        chatTabs?.selectSession(key)
      } else {
        const key = `agent:${extAgent.name}:dashboard`
        chatTabs?.selectSession(key)
      }
    },
    [chatTabs],
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

  // Update active tab metadata when agent/session info changes
  useEffect(() => {
    if (!chatTabs || !activeSessionKey) {
      return
    }
    const parts = activeSessionKey.split(':')
    const jobSlug = parts.length >= 3 ? parts.slice(2).join(':') : undefined
    const label = activeAgent
      ? jobSlug && jobSlug !== 'dashboard'
        ? `${activeAgent.name}: ${jobSlug}`
        : activeAgent.name
      : (parts[parts.length - 1] ?? activeSessionKey)
    chatTabs.updateTabMeta(activeSessionKey, {
      label,
      agentName: activeAgent?.name,
      agentAvatar: activeAgent?.avatar,
    })
  }, [activeSessionKey, activeAgent, chatTabs])

  const createButton = useMemo(
    () => (
      <CreateChatMenu
        allAgents={agents}
        externalAgents={unmatchedExternalAgents}
        existingSessionsByAgent={externalById}
        localSessions={sessions}
        onCreateSession={createSession}
        onOpenSession={(key) => chatTabs?.selectSession(key)}
        onDeleteSession={permanentlyDeleteSession}
        onDeleteLocalSession={deleteLocalSessionEntry}
        onSelectExternalAgent={selectExternalAgent}
      />
    ),
    [
      agents,
      unmatchedExternalAgents,
      externalById,
      sessions,
      createSession,
      permanentlyDeleteSession,
      deleteLocalSessionEntry,
      selectExternalAgent,
      chatTabs,
    ],
  )

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
    />
  )
}

interface ExistingSession {
  key: string
  title: string
}

interface CreateChatMenuProps {
  allAgents: AgentNodeRef[]
  externalAgents: OpenclawAgent[]
  existingSessionsByAgent: Map<string, OpenclawAgent>
  localSessions: SessionEntry[]
  onCreateSession: (agent: AgentNodeRef, job: AgentJobRef) => void
  onOpenSession: (key: string) => void
  onDeleteSession: (key: string) => void
  onDeleteLocalSession: (key: string) => void
  onSelectExternalAgent: (agent: OpenclawAgent) => void
}

function agentExistingSessions(
  agent: AgentNodeRef,
  externalAgent: OpenclawAgent | undefined,
  localSessions: SessionEntry[],
): ExistingSession[] {
  if (agent.backend === 'local') {
    return localSessions.filter((s) => s.agentNodeId === agent.nodeId).map((s) => ({ key: s.key, title: s.jobName }))
  }
  return (externalAgent?.sessions ?? []).map((s) => ({ key: s.key, title: s.title ?? s.key.split(':').pop() ?? s.key }))
}

function CreateChatMenu({
  allAgents,
  externalAgents,
  existingSessionsByAgent,
  localSessions,
  onCreateSession,
  onOpenSession,
  onDeleteSession,
  onDeleteLocalSession,
  onSelectExternalAgent,
}: CreateChatMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type='button'
          className='flex items-center justify-center size-7 shrink-0 rounded-md hover:bg-accent/50 transition-colors cursor-pointer'
          aria-label='New chat'
        >
          <Plus className='size-4' />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='w-[260px]'>
        <DropdownMenuLabel>Agents</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {allAgents.map((agent) => (
          <AgentMenuItem
            key={agent.nodeId}
            agent={agent}
            existingSessions={agentExistingSessions(
              agent,
              existingSessionsByAgent.get(slug(agent.name)),
              localSessions,
            )}
            onCreateSession={onCreateSession}
            onOpenSession={onOpenSession}
            onDeleteSession={agent.backend === 'local' ? onDeleteLocalSession : onDeleteSession}
          />
        ))}
        {externalAgents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>OpenClaw</DropdownMenuLabel>
            {externalAgents.map((agent) => (
              <DropdownMenuItem key={agent.agentId} onSelect={() => onSelectExternalAgent(agent)}>
                <User className='size-4 shrink-0' />
                <span className='truncate'>{agent.name}</span>
                {agent.isDefault && (
                  <span className='ml-auto text-[10px] uppercase tracking-wide text-muted-foreground'>default</span>
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface AgentMenuItemProps {
  agent: AgentNodeRef
  existingSessions: ExistingSession[]
  onCreateSession: (agent: AgentNodeRef, job: AgentJobRef) => void
  onOpenSession: (key: string) => void
  onDeleteSession: (key: string) => void
}

function AgentMenuItem({
  agent,
  existingSessions,
  onCreateSession,
  onOpenSession,
  onDeleteSession,
}: AgentMenuItemProps) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {agent.avatar ? (
          <img src={agent.avatar} alt='' className='size-4 shrink-0 rounded-full object-cover' />
        ) : (
          <User className='size-4 shrink-0' />
        )}
        <span className='truncate'>{agent.name}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className='w-[260px]'>
        {/* Existing sessions */}
        {existingSessions.length > 0 && (
          <>
            <DropdownMenuLabel>Existing sessions</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {existingSessions.slice(0, 10).map((s) => (
              <div key={s.key} className='flex items-center gap-1 px-2 py-1.5'>
                <button
                  type='button'
                  className='flex-1 min-w-0 flex items-center gap-1.5 text-sm rounded-sm px-1 py-0.5 hover:bg-accent/50 cursor-pointer text-left'
                  onClick={() => onOpenSession(s.key)}
                >
                  <MessageSquare className='size-3.5 shrink-0' />
                  <span className='truncate'>{s.title}</span>
                </button>
                <button
                  type='button'
                  className='size-6 inline-flex items-center justify-center rounded-sm hover:bg-muted hover:text-destructive shrink-0 cursor-pointer'
                  onClick={() => onDeleteSession(s.key)}
                  aria-label='Delete session'
                >
                  <Trash2 className='size-3' />
                </button>
              </div>
            ))}
            <DropdownMenuSeparator />
          </>
        )}
        {/* New session */}
        <DropdownMenuLabel>New session</DropdownMenuLabel>
        {agent.jobs.length === 0 ? (
          <DropdownMenuItem disabled>No jobs available</DropdownMenuItem>
        ) : (
          agent.jobs.map((job) => (
            <DropdownMenuItem key={job.nodeId} onSelect={() => onCreateSession(agent, job)}>
              <Briefcase className='size-3.5 shrink-0' />
              <span className='truncate'>{job.name}</span>
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}
