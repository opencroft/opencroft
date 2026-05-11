'use client';

import { Briefcase, Menu, MessageSquare, Trash2, User, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { NodeCard } from '@/app/(dashboard)/_canvas/node-card';
import { useOverlayContent, useOverlayHeader } from '@/app/(dashboard)/_canvas/overlay-context';
import { deleteSession, loadOpenclaw, type OpenclawAgent, type OpenclawSession } from '@/app/(openclaw)/openclaw/actions';
import { AgentChat, AgentChatInput, useAgentSession } from '@/app/(openclaw)/openclaw/agent-chat';
import { slug } from '@/app/(server)/server/types';
import { type AgentNodeRef, type AgentJobRef, listAgentNodes } from '@/app/(space)/server/agents';
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
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

interface AiPanelProps {
  agentId: string;
  spaceName: string;
  spaceSlug: string;
  selectedNodeId: string | null;
  focused: boolean;
  onFocusChange: (focused: boolean) => void;
}

interface SessionEntry {
  key: string;
  agentNodeId: string;
  agentName: string;
  jobNodeId: string;
  jobName: string;
  createdAt: number;
}

const SESSIONS_STORAGE_KEY = 'opencroft.aiPanel.sessions';
const OPEN_TABS_KEY = 'opencroft.aiPanel.openTabs';

function loadStoredSessions(): SessionEntry[] {
  if (typeof window === 'undefined') {
    return [];
  }
  const raw = window.localStorage.getItem(SESSIONS_STORAGE_KEY);
  if (!raw) {
    return [];
  }
  const parsed = JSON.parse(raw) as SessionEntry[];
  return Array.isArray(parsed) ? parsed : [];
}

function loadOpenTabs(): string[] {
  if (typeof window === 'undefined') {
    return [];
  }
  const raw = window.localStorage.getItem(OPEN_TABS_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistOpenTabs(tabs: string[]) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(tabs));
}

function resolveJobForSession(sessionKey: string, sessions: SessionEntry[], agents: AgentNodeRef[]): { job: AgentJobRef | null; agent: AgentNodeRef | null } {
  const local = sessions.find((s) => s.key === sessionKey);
  if (local) {
    const agent = agents.find((a) => a.nodeId === local.agentNodeId);
    return { job: agent?.jobs.find((j) => j.nodeId === local.jobNodeId) ?? null, agent: agent ?? null };
  }
  const parts = sessionKey.split(':');
  if (parts.length < 3 || parts[0] !== 'agent') {
    return { job: null, agent: null };
  }
  const agentSlug = parts[1].trim().toLowerCase();
  const jobSlug = parts.slice(2).join(':').trim().toLowerCase();
  const agent = agents.find((a) => slug(a.name) === agentSlug);
  return { job: agent?.jobs.find((j) => slug(j.name) === jobSlug) ?? null, agent: agent ?? null };
}

function persistSessions(list: SessionEntry[]) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(list));
}

export function AiPanel({ agentId, spaceName, spaceSlug, selectedNodeId, focused, onFocusChange }: AiPanelProps) {
  const [slashOpen, setSlashOpen] = useState(false);
  const [agents, setAgents] = useState<AgentNodeRef[]>([]);
  const [externalAgents, setExternalAgents] = useState<OpenclawAgent[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeSessionKey, setActiveSessionKey] = useState<string>(`agent:${agentId}:dashboard`);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const chatParam = searchParams?.get('chat') ?? null;
  useEffect(() => {
    setSessions(loadStoredSessions());
    setOpenTabs(loadOpenTabs());
  }, []);

  useEffect(() => {
    if (!chatParam) {
      return;
    }
    setActiveSessionKey(chatParam);
  }, [chatParam]);

  const transformOutgoing = useCallback((text: string, isFirstMessage: boolean) => {
    if (text.trim().startsWith('/')) {
      return text;
    }
    const system = `<opencroft-system>Sent from OpenCroft space: ${spaceName} (${spaceSlug}). Selected node: ${selectedNodeId ?? 'none'}.</opencroft-system>`;
    if (!isFirstMessage) {
      return `${system}\n${text}`;
    }
    const { job, agent } = resolveJobForSession(activeSessionKey, sessions, agents);
    const ctx = job?.context.trim();
    if (!ctx && !agent?.instructions.length) {
      return `${system}\n${text}`;
    }
    let prefix = system;
    if (ctx) {
      prefix += `\n<opencroft-task>${ctx}</opencroft-task>`;
    }
    for (const instr of agent?.instructions ?? []) {
      const trimmed = instr.instruction.trim();
      if (trimmed) {
        prefix += `\n<opencroft-instruction>${trimmed}</opencroft-instruction>`;
      }
    }
    return `${prefix}\n${text}`;
  }, [spaceName, spaceSlug, selectedNodeId, activeSessionKey, sessions, agents]);

  const session = useAgentSession(activeSessionKey, transformOutgoing);

  useEffect(() => {
    if (!focused) {
      return;
    }
    listAgentNodes().then(setAgents);
    loadOpenclaw().then((state) => {
      if (state.status === 'ok') {
        setExternalAgents(state.agents);
      } else {
        setExternalAgents([]);
      }
    }).catch(() => {
      setExternalAgents([]);
    });
  }, [focused]);

  const externalByName = useMemo(() => {
    const map = new Map<string, OpenclawAgent>();
    for (const ext of externalAgents) {
      map.set(ext.name.trim().toLowerCase(), ext);
    }
    return map;
  }, [externalAgents]);

  const unmatchedExternalAgents = useMemo(() => {
    const localNames = new Set(agents.map((a) => a.name.trim().toLowerCase()));
    return externalAgents.filter((a) => !localNames.has(a.name.trim().toLowerCase()));
  }, [agents, externalAgents]);

  const closeTab = useCallback((key: string) => {
    setOpenTabs((prev) => {
      const next = prev.filter((k) => k !== key);
      persistOpenTabs(next);
      return next;
    });
    setActiveSessionKey((current) => {
      if (current !== key) {
        return current;
      }
      const parts = current.split(':');
      if (parts.length >= 3 && parts[0] === 'agent') {
        return `agent:${parts[1]}:dashboard`;
      }
      return `agent:${agentId}:dashboard`;
    });
  }, [agentId]);

  const permanentlyDeleteSession = useCallback((key: string) => {
    // Close tab if open
    setOpenTabs((prev) => {
      const next = prev.filter((k) => k !== key);
      persistOpenTabs(next);
      return next;
    });
    // Remove from local session entries
    setSessions((prev) => {
      const next = prev.filter((s) => s.key !== key);
      persistSessions(next);
      return next;
    });
    // Remove from external agents
    setExternalAgents((prev) => prev.map((a) => ({
      ...a,
      sessions: a.sessions.filter((s) => s.key !== key),
      sessionCount: Math.max(0, a.sessionCount - (a.sessions.some((s) => s.key === key) ? 1 : 0)),
    })));
    setActiveSessionKey((current) => {
      if (current !== key) {
        return current;
      }
      const parts = current.split(':');
      if (parts.length >= 3 && parts[0] === 'agent') {
        return `agent:${parts[1]}:dashboard`;
      }
      return `agent:${agentId}:dashboard`;
    });
    deleteSession(key).catch((err) => {
      console.error('Failed to delete OpenClaw session', key, err);
    });
  }, [agentId]);

  const createSession = useCallback((agent: AgentNodeRef, job: AgentJobRef) => {
    const key = `agent:${slug(agent.name)}:${slug(job.name)}`;
    const entry: SessionEntry = {
      key,
      agentNodeId: agent.nodeId,
      agentName: agent.name,
      jobNodeId: job.nodeId,
      jobName: job.name,
      createdAt: Date.now(),
    };
    setSessions((prev) => {
      if (prev.some((s) => s.key === key)) {
        return prev;
      }
      const next = [...prev, entry];
      persistSessions(next);
      return next;
    });
    setOpenTabs((prev) => {
      if (prev.includes(key)) {
        return prev;
      }
      const next = [...prev, key];
      persistOpenTabs(next);
      return next;
    });
    setActiveSessionKey(key);
  }, []);

  const openTab = useCallback((key: string) => {
    setOpenTabs((prev) => {
      if (prev.includes(key)) {
        return prev;
      }
      const next = [...prev, key];
      persistOpenTabs(next);
      return next;
    });
  }, []);

  const selectAgent = useCallback((agentNode: AgentNodeRef) => {
    if (agentNode.jobs.length > 0) {
      createSession(agentNode, agentNode.jobs[0]);
    } else {
      const key = `agent:${slug(agentNode.name)}:dashboard`;
      openTab(key);
      setActiveSessionKey(key);
    }
  }, [createSession, openTab]);

  const selectExternalAgent = useCallback((extAgent: OpenclawAgent) => {
    if (extAgent.sessions.length > 0) {
      const key = extAgent.sessions[0].key;
      openTab(key);
      setActiveSessionKey(key);
    } else {
      const key = `agent:${extAgent.name}:dashboard`;
      openTab(key);
      setActiveSessionKey(key);
    }
  }, [openTab]);

  const showChat = focused && !slashOpen;

  const activeAgent = useMemo(() => {
    const local = sessions.find((s) => s.key === activeSessionKey);
    if (local) {
      return agents.find((a) => a.nodeId === local.agentNodeId);
    }
    const parts = activeSessionKey.split(':');
    if (parts.length < 3 || parts[0] !== 'agent') {
      return undefined;
    }
    const agentSlug = parts[1].trim().toLowerCase();
    return agents.find((a) => slug(a.name) === agentSlug);
  }, [sessions, agents, activeSessionKey]);


  const headerSessions = useMemo(() => {
    // Only show sessions that are in the openTabs list
    // Build ALL sessions across all agents for lookup
    const allSessions: SessionItem[] = [];
    const seen = new Set<string>();

    for (const agent of agents) {
      const own = sessions.filter((s) => s.agentNodeId === agent.nodeId);
      const ext = externalByName.get(agent.name.trim().toLowerCase()) ?? null;
      const groups = buildSessionGroups(agent, own, ext);
      for (const job of agent.jobs) {
        const list = groups.byJob.get(job.nodeId);
        if (!list) {
          continue;
        }
        for (const item of list) {
          if (!seen.has(item.key)) {
            seen.add(item.key);
            allSessions.push(item);
          }
        }
      }
      for (const item of groups.pet) {
        if (!seen.has(item.key)) {
          seen.add(item.key);
          allSessions.push(item);
        }
      }
    }

    for (const extAgent of unmatchedExternalAgents) {
      for (const s of extAgent.sessions) {
        if (seen.has(s.key)) {
          continue;
        }
        seen.add(s.key);
        allSessions.push({
          key: s.key,
          label: s.title ?? shortSessionKey(s.key),
          subtitle: s.lastMessage ?? undefined,
          agentName: extAgent.name,
          agentAvatar: null,
        });
      }
    }

    // Filter to only open tabs, preserving tab order
    const tabSet = new Set(openTabs);
    const openSessionItems = allSessions.filter((s) => tabSet.has(s.key));

    // Also include tabs that don't match any known session (e.g. dashboard tabs)
    const knownKeys = new Set(openSessionItems.map((s) => s.key));
    for (const tabKey of openTabs) {
      if (!knownKeys.has(tabKey)) {
        // Parse the key to get agent info
        const parts = tabKey.split(':');
        const agentSlug = parts.length >= 2 ? parts[1] : '';
        const agent = agents.find((a) => slug(a.name) === agentSlug);
        openSessionItems.push({
          key: tabKey,
          label: parts[parts.length - 1] ?? tabKey,
          agentName: agent?.name,
          agentAvatar: agent?.avatar,
        });
      }
    }

    return openSessionItems;
  }, [agents, sessions, externalByName, unmatchedExternalAgents, openTabs]);

  const headerNode = useMemo(() => {
    if (!showChat) {
      return null;
    }
    return (
      <NodeCard selected className='pointer-events-auto px-2 py-1.5'>
        <SessionHeader
          activeAgent={activeAgent}
          allAgents={agents}
          externalAgents={unmatchedExternalAgents}
          sessions={headerSessions}
          activeSessionKey={activeSessionKey}
          onSelectSession={(key) => {
            openTab(key); setActiveSessionKey(key);
          }}
          onCloseSession={closeTab}
          onPermanentlyDeleteSession={permanentlyDeleteSession}
          onCreateSession={createSession}
          onSelectAgent={selectAgent}
          existingSessionsByAgent={externalByName}
          onSelectExternalAgent={selectExternalAgent}
        />
      </NodeCard>
    );
  }, [showChat, activeAgent, agents, unmatchedExternalAgents, externalByName, headerSessions, activeSessionKey, createSession, closeTab, openTab, selectAgent, selectExternalAgent, permanentlyDeleteSession]);

  const contentNode = useMemo(() => {
    if (!showChat) {
      return null;
    }
    return <AgentChat session={session} agentAvatar={activeAgent?.avatar} agentName={activeAgent?.name} />;
  }, [showChat, session, activeAgent]);

  useOverlayHeader(headerNode);
  useOverlayContent(contentNode);

  return (
    <AgentChatInput
      session={session}
      placeholder='Ask AI...'
      onSlashOpenChange={setSlashOpen}
      onFocus={() => onFocusChange(true)}
    />
  );
}

function shortSessionKey(key: string): string {
  const parts = key.split(':');
  return parts[parts.length - 1] ?? key;
}

interface SessionItem {
  key: string;
  label: string;
  subtitle?: string;
  agentName?: string;
  agentAvatar?: string | null;
}

function buildSessionGroups(agent: AgentNodeRef, sessions: SessionEntry[], externalAgent: OpenclawAgent | null) {
  const jobsByName = new Map<string, AgentJobRef>();
  for (const job of agent.jobs) {
    jobsByName.set(job.name.trim().toLowerCase(), job);
  }
  const byJob = new Map<string, SessionItem[]>();
  const pet: SessionItem[] = [];
  const seen = new Set<string>();

  for (const s of sessions) {
    seen.add(s.key);
    const job = agent.jobs.find((j) => j.nodeId === s.jobNodeId);
    const item: SessionItem = { key: s.key, label: job?.name ?? s.jobName, agentName: agent.name, agentAvatar: agent.avatar };
    if (job) {
      const list = byJob.get(job.nodeId) ?? [];
      list.push(item);
      byJob.set(job.nodeId, list);
    } else {
      pet.push(item);
    }
  }

  if (externalAgent) {
    const agentNameKey = agent.name.trim().toLowerCase();
    for (const s of externalAgent.sessions) {
      if (seen.has(s.key)) {
        continue;
      }
      const parsed = parseOpenclawSessionKey(s.key);
      const matchedJob = parsed && parsed.agentName.trim().toLowerCase() === agentNameKey
        ? jobsByName.get(parsed.jobName.trim().toLowerCase())
        : undefined;
      const item: SessionItem = {
        key: s.key,
        label: s.title ?? matchedJob?.name ?? parsed?.jobName ?? shortSessionKey(s.key),
        subtitle: s.lastMessage ?? undefined,
        agentName: agent.name,
        agentAvatar: agent.avatar,
      };
      if (matchedJob) {
        const list = byJob.get(matchedJob.nodeId) ?? [];
        list.push(item);
        byJob.set(matchedJob.nodeId, list);
      } else {
        pet.push(item);
      }
    }
  }

  return { byJob, pet };
}

function parseOpenclawSessionKey(key: string): { agentName: string; jobName: string } | null {
  const parts = key.split(':');
  if (parts.length < 3 || parts[0] !== 'agent') {
    return null;
  }
  return { agentName: parts[1], jobName: parts.slice(2).join(':') };
}

interface SessionHeaderProps {
  activeAgent: AgentNodeRef | undefined;
  allAgents: AgentNodeRef[];
  externalAgents: OpenclawAgent[];
  existingSessionsByAgent: Map<string, OpenclawAgent>;
  sessions: SessionItem[];
  activeSessionKey: string;
  onSelectSession: (key: string) => void;
  onCloseSession: (key: string) => void;
  onPermanentlyDeleteSession: (key: string) => void;
  onCreateSession: (agent: AgentNodeRef, job: AgentJobRef) => void;
  onSelectAgent: (agent: AgentNodeRef) => void;
  onSelectExternalAgent: (agent: OpenclawAgent) => void;
}

function SessionHeader({ activeAgent, allAgents, externalAgents, existingSessionsByAgent, sessions, activeSessionKey, onSelectSession, onCloseSession, onPermanentlyDeleteSession, onCreateSession, onSelectAgent, onSelectExternalAgent }: SessionHeaderProps) {
  return (
    <div className='flex w-full items-center gap-2'>
      {/* Left: Menu button with dropdown showing all agents */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type='button'
            className='flex items-center justify-center size-7 shrink-0 rounded-md hover:bg-accent/50 transition-colors cursor-pointer'
            aria-label='Agent menu'
          >
            <Menu className='size-4' />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='start' className='w-[260px]'>
          <DropdownMenuLabel>Agents</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {allAgents.map((agent) => (
            <AgentMenuItem
              key={agent.nodeId}
              agent={agent}
              isActive={activeAgent?.nodeId === agent.nodeId}
              existingSessions={existingSessionsByAgent.get(agent.name.trim().toLowerCase())?.sessions ?? []}
              onSelect={onSelectAgent}
              onCreateSession={onCreateSession}
              onOpenSession={onSelectSession}
              onDeleteSession={onPermanentlyDeleteSession}
            />
          ))}
          {externalAgents.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>OpenClaw</DropdownMenuLabel>
              {externalAgents.map((agent) => (
                <DropdownMenuItem
                  key={agent.agentId}
                  onSelect={() => onSelectExternalAgent(agent)}
                >
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

      {/* Right: Session tabs with agent avatars */}
      <div className='flex-1 min-w-0 flex items-center gap-1 overflow-x-auto overflow-y-hidden whitespace-nowrap'>
        {sessions.map((s) => (
          <div
            key={s.key}
            role='button'
            tabIndex={0}
            onClick={() => onSelectSession(s.key)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSelectSession(s.key);
              }
            }}
            className={cn(
              'group shrink-0 inline-flex items-center gap-1.5 h-7 rounded-md pl-2 pr-1 text-xs cursor-pointer transition-colors outline-hidden',
              s.key === activeSessionKey
                ? 'bg-background/50 text-foreground'
                : 'bg-accent text-accent-foreground',
            )}
          >
            {s.agentAvatar ? (
              <img src={s.agentAvatar} alt='' className='size-3.5 shrink-0 rounded-full object-cover' />
            ) : (
              <User className='size-3.5 shrink-0' />
            )}
            <span className='truncate max-w-32'>{s.label}</span>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                onCloseSession(s.key);
              }}
              className='size-4 inline-flex items-center justify-center rounded-sm hover:bg-muted hover:text-destructive'
              aria-label='Close session'
            >
              <X className='size-3' />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface AgentMenuItemProps {
  agent: AgentNodeRef;
  isActive: boolean;
  existingSessions: OpenclawSession[];
  onSelect: (agent: AgentNodeRef) => void;
  onCreateSession: (agent: AgentNodeRef, job: AgentJobRef) => void;
  onOpenSession: (key: string) => void;
  onDeleteSession: (key: string) => void;
}

function AgentMenuItem({ agent, isActive, existingSessions, onSelect, onCreateSession, onOpenSession, onDeleteSession }: AgentMenuItemProps) {
  if (agent.jobs.length === 0 && existingSessions.length === 0) {
    return (
      <DropdownMenuItem onSelect={() => onSelect(agent)}>
        {agent.avatar ? (
          <img src={agent.avatar} alt='' className='size-4 shrink-0 rounded-full object-cover' />
        ) : (
          <User className='size-4 shrink-0' />
        )}
        <span className='truncate'>{agent.name}</span>
      </DropdownMenuItem>
    );
  }

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
                  <span className='truncate'>{s.title ?? s.key.split(':').pop() ?? s.key}</span>
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
  );
}
