'use client';

import { Briefcase, Check, MessageSquare, Plus, User, X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { NodeCard } from '@/app/(dashboard)/_canvas/node-card';
import { useOverlayContent, useOverlayHeader } from '@/app/(dashboard)/_canvas/overlay-context';
import { deleteSession, loadOpenclaw, type OpenclawAgent } from '@/app/(openclaw)/openclaw/actions';
import { AgentChat, AgentChatInput, useAgentSession } from '@/app/(openclaw)/openclaw/agent-chat';
import { slug } from '@/app/(server)/server/types';
import { type AgentNodeRef, type AgentJobRef, listAgentNodes } from '@/app/(space)/server/agents';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

interface AiPanelProps {
  agentId: string;
  spaceName: string;
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

export function AiPanel({ agentId, spaceName, selectedNodeId, focused, onFocusChange }: AiPanelProps) {
  const [slashOpen, setSlashOpen] = useState(false);
  const [agents, setAgents] = useState<AgentNodeRef[]>([]);
  const [externalAgents, setExternalAgents] = useState<OpenclawAgent[]>([]);
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [activeSessionKey, setActiveSessionKey] = useState<string>(`agent:${agentId}:dashboard`);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const chatParam = searchParams?.get('chat') ?? null;
  const agentParam = searchParams?.get('agent') ?? null;

  useEffect(() => {
    setSessions(loadStoredSessions());
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
    const system = `<opencroft-system>Sent from OpenCroft space: ${spaceName}. Selected node: ${selectedNodeId ?? 'none'}.</opencroft-system>`;
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
  }, [spaceName, selectedNodeId, activeSessionKey, sessions, agents]);

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

  const removeSession = useCallback((key: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.key !== key);
      persistSessions(next);
      return next;
    });
    setExternalAgents((prev) => prev.map((a) => ({
      ...a,
      sessions: a.sessions.filter((s) => s.key !== key),
      sessionCount: Math.max(0, a.sessionCount - (a.sessions.some((s) => s.key === key) ? 1 : 0)),
    })));
    setActiveSessionKey((current) => (current === key ? `agent:${agentId}:dashboard` : current));
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
    setActiveSessionKey(key);
  }, []);

  const selectAgent = useCallback((agentNode: AgentNodeRef) => {
    // If the agent has jobs, create a session with the first job; otherwise fall back to the dashboard key
    if (agentNode.jobs.length > 0) {
      createSession(agentNode, agentNode.jobs[0]);
    } else {
      setActiveSessionKey(`agent:${slug(agentNode.name)}:dashboard`);
    }
  }, [createSession]);

  const selectExternalAgent = useCallback((extAgent: OpenclawAgent) => {
    // Switch to the first session of the external agent, or keep the key pattern
    if (extAgent.sessions.length > 0) {
      setActiveSessionKey(extAgent.sessions[0].key);
    } else {
      setActiveSessionKey(`agent:${extAgent.name}:dashboard`);
    }
  }, []);

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

  const activeAgentSlug = useMemo(() => {
    const parts = activeSessionKey.split(':');
    if (parts.length < 3 || parts[0] !== 'agent') {
      return null;
    }
    return parts[1].trim().toLowerCase();
  }, [activeSessionKey]);

  useEffect(() => {
    if (!showChat || !activeAgentSlug || !pathname) {
      return;
    }
    if (agentParam === activeAgentSlug) {
      return;
    }
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('agent', activeAgentSlug);
    router.replace(`${pathname}?${params.toString()}`);
  }, [showChat, activeAgentSlug, agentParam, pathname, router, searchParams]);

  const headerSessions = useMemo(() => {
    if (!activeAgent) {
      return [] as SessionItem[];
    }
    const own = sessions.filter((s) => s.agentNodeId === activeAgent.nodeId);
    const groups = buildSessionGroups(activeAgent, own, externalByName.get(activeAgent.name.trim().toLowerCase()) ?? null);
    const flat: SessionItem[] = [];
    for (const job of activeAgent.jobs) {
      const list = groups.byJob.get(job.nodeId);
      if (!list) {
        continue;
      }
      flat.push(...list);
    }
    flat.push(...groups.pet);
    return flat;
  }, [activeAgent, sessions, externalByName]);

  const headerNode = useMemo(() => {
    if (!showChat || !activeAgent) {
      return null;
    }
    return (
      <NodeCard selected className='pointer-events-auto px-2 py-1.5'>
        <SessionHeader
          agent={activeAgent}
          allAgents={agents}
          externalAgents={unmatchedExternalAgents}
          sessions={headerSessions}
          activeSessionKey={activeSessionKey}
          onSelectSession={setActiveSessionKey}
          onCreateSession={createSession}
          onDeleteSession={removeSession}
          onSelectAgent={selectAgent}
          onSelectExternalAgent={selectExternalAgent}
        />
      </NodeCard>
    );
  }, [showChat, activeAgent, agents, unmatchedExternalAgents, headerSessions, activeSessionKey, createSession, removeSession, selectAgent, selectExternalAgent]);

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
    const item: SessionItem = { key: s.key, label: job?.name ?? s.jobName };
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
  agent: AgentNodeRef;
  allAgents: AgentNodeRef[];
  externalAgents: OpenclawAgent[];
  sessions: SessionItem[];
  activeSessionKey: string;
  onSelectSession: (key: string) => void;
  onCreateSession: (agent: AgentNodeRef, job: AgentJobRef) => void;
  onDeleteSession: (key: string) => void;
  onSelectAgent: (agent: AgentNodeRef) => void;
  onSelectExternalAgent: (agent: OpenclawAgent) => void;
}

function SessionHeader({ agent, allAgents, externalAgents, sessions, activeSessionKey, onSelectSession, onCreateSession, onDeleteSession, onSelectAgent, onSelectExternalAgent }: SessionHeaderProps) {
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);

  return (
    <div className='flex w-full items-center gap-2'>
      <Popover open={agentPickerOpen} onOpenChange={setAgentPickerOpen}>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex items-center gap-2 shrink-0 rounded-md px-1 py-0.5 hover:bg-accent/50 transition-colors cursor-pointer'
            aria-label='Select agent'
          >
            {agent.avatar ? (
              <img src={agent.avatar} alt='' className='size-5 shrink-0 rounded-full object-cover' />
            ) : (
              <User className='size-5 shrink-0' />
            )}
            <span className='text-sm font-semibold truncate max-w-40'>{agent.name}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[260px] p-0'>
          <AgentSelector
            agents={allAgents}
            externalAgents={externalAgents}
            activeAgentId={agent.nodeId}
            onSelect={(a) => {
              onSelectAgent(a);
              setAgentPickerOpen(false);
            }}
            onSelectExternal={(a) => {
              onSelectExternalAgent(a);
              setAgentPickerOpen(false);
            }}
          />
        </PopoverContent>
      </Popover>
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
            <MessageSquare className='size-3.5 shrink-0' />
            <span className='truncate max-w-32'>{s.label}</span>
            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                onDeleteSession(s.key);
              }}
              className='size-4 inline-flex items-center justify-center rounded-sm hover:bg-muted hover:text-destructive'
              aria-label='Delete session'
            >
              <X className='size-3' />
            </button>
          </div>
        ))}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant='ghost' size='icon' className='size-7 shrink-0' aria-label='New session'>
            <Plus className='size-4' />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end'>
          <DropdownMenuLabel>New session</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {agent.jobs.length === 0 ? (
            <DropdownMenuItem disabled>No jobs connected</DropdownMenuItem>
          ) : (
            agent.jobs.map((job) => (
              <DropdownMenuItem key={job.nodeId} onSelect={() => onCreateSession(agent, job)}>
                <Briefcase className='size-3.5 shrink-0' />
                <span className='truncate'>{job.name}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface AgentSelectorProps {
  agents: AgentNodeRef[];
  externalAgents: OpenclawAgent[];
  activeAgentId: string;
  onSelect: (agent: AgentNodeRef) => void;
  onSelectExternal: (agent: OpenclawAgent) => void;
}

function AgentSelector({ agents, externalAgents, activeAgentId, onSelect, onSelectExternal }: AgentSelectorProps) {
  const localGrouped = useMemo(() => {
    const map = new Map<string, AgentNodeRef[]>();
    for (const agent of agents) {
      const key = agent.spaceName;
      const list = map.get(key) ?? [];
      list.push(agent);
      map.set(key, list);
    }
    return map;
  }, [agents]);

  return (
    <Command>
      <CommandInput placeholder='Find agent…' autoFocus />
      <CommandList>
        <CommandEmpty>No agents found.</CommandEmpty>
        {Array.from(localGrouped.entries()).map(([spaceName, items]) => (
          <CommandGroup key={spaceName} heading={spaceName}>
            {items.map((agent) => {
              const isActive = agent.nodeId === activeAgentId;
              return (
                <CommandItem
                  key={agent.nodeId}
                  value={`${spaceName} ${agent.name}`}
                  onSelect={() => onSelect(agent)}
                >
                  {agent.avatar ? (
                    <img src={agent.avatar} alt='' className='size-4 shrink-0 rounded-full object-cover' />
                  ) : (
                    <User className='size-4 shrink-0' />
                  )}
                  <span className='truncate'>{agent.name}</span>
                  {isActive && <Check className='size-3.5 shrink-0 ml-auto text-primary' />}
                </CommandItem>
              );
            })}
          </CommandGroup>
        ))}
        {externalAgents.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading='OpenClaw'>
              {externalAgents.map((agent) => (
                <CommandItem
                  key={agent.agentId}
                  value={`OpenClaw ${agent.name}`}
                  onSelect={() => onSelectExternal(agent)}
                >
                  <User className='size-4 shrink-0' />
                  <span className='truncate'>{agent.name}</span>
                  {agent.isDefault && (
                    <span className='ml-auto text-[10px] uppercase tracking-wide text-muted-foreground'>default</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  );
}
