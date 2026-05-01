'use client';

import { Briefcase, ChevronRight, MessageSquare, Trash2, User } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useInspector } from '@/app/(dashboard)/_canvas/inspector-context';
import { useOverlayContent } from '@/app/(dashboard)/_canvas/overlay-context';
import { deleteSession, loadOpenclaw, type OpenclawAgent } from '@/app/(openclaw)/openclaw/actions';
import { AgentChat, AgentChatInput, useAgentSession } from '@/app/(openclaw)/openclaw/agent-chat';
import { slug } from '@/app/(server)/server/types';
import { type AgentNodeRef, type AgentJobRef, listAgentNodes } from '@/app/(space)/server/agents';
import { Separator } from '@/components/ui/separator';
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
  const chatParam = searchParams?.get('chat') ?? null;

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

  const contentNode = useMemo(() => {
    if (!showChat) {
      return null;
    }
    return <AgentChat session={session} agentAvatar={activeAgent?.avatar} agentName={activeAgent?.name} />;
  }, [showChat, session, activeAgent]);

  const inspectorNode = useMemo(() => {
    if (!showChat) {
      return null;
    }
    return (
      <AgentInspector
        agents={agents}
        externalByName={externalByName}
        externalAgents={unmatchedExternalAgents}
        sessions={sessions}
        activeSessionKey={activeSessionKey}
        onCreateSession={createSession}
        onSelectSession={setActiveSessionKey}
        onDeleteSession={removeSession}
      />
    );
  }, [showChat, agents, externalByName, unmatchedExternalAgents, sessions, activeSessionKey, createSession, removeSession]);

  useOverlayContent(contentNode);
  useInspector(inspectorNode);

  return (
    <AgentChatInput
      session={session}
      placeholder='Ask AI...'
      onSlashOpenChange={setSlashOpen}
      onFocus={() => onFocusChange(true)}
    />
  );
}

interface AgentInspectorProps {
  agents: AgentNodeRef[];
  externalByName: Map<string, OpenclawAgent>;
  externalAgents: OpenclawAgent[];
  sessions: SessionEntry[];
  activeSessionKey: string;
  onCreateSession: (agent: AgentNodeRef, job: AgentJobRef) => void;
  onSelectSession: (key: string) => void;
  onDeleteSession: (key: string) => void;
}

function AgentInspector({ agents, externalByName, externalAgents, sessions, activeSessionKey, onCreateSession, onSelectSession, onDeleteSession }: AgentInspectorProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <div className='flex flex-col h-full'>
      <div className='flex items-center gap-2 p-3'>
        <span className='text-sm font-semibold flex-1 truncate'>Agents</span>
      </div>
      <Separator />
      <div className='flex-1 min-h-0 overflow-y-auto flex flex-col gap-0.5 p-2'>
        {agents.length === 0 ? (
          <div className='px-2 py-1.5 text-xs text-muted-foreground italic'>No agents</div>
        ) : (
          agents.map((agent) => {
            const key = `${agent.spaceSlug}:${agent.nodeId}`;
            const isOpen = !collapsed.has(key);
            const agentSessions = sessions.filter((s) => s.agentNodeId === agent.nodeId);
            const matchedExternal = externalByName.get(agent.name.trim().toLowerCase()) ?? null;
            return (
              <AgentRow
                key={key}
                agent={agent}
                expanded={isOpen}
                sessions={agentSessions}
                externalAgent={matchedExternal}
                activeSessionKey={activeSessionKey}
                onToggle={() => toggle(key)}
                onCreateSession={onCreateSession}
                onSelectSession={onSelectSession}
                onDeleteSession={onDeleteSession}
              />
            );
          })
        )}
        {externalAgents.length > 0 ? (
          <>
            <div className='px-2 pt-3 pb-1 text-[10px] uppercase tracking-wide text-muted-foreground'>OpenClaw</div>
            {externalAgents.map((agent) => {
              const key = `external:${agent.agentId}`;
              return (
                <ExternalAgentRow
                  key={key}
                  agent={agent}
                  expanded={!collapsed.has(key)}
                  activeSessionKey={activeSessionKey}
                  onToggle={() => toggle(key)}
                  onSelectSession={onSelectSession}
                  onDeleteSession={onDeleteSession}
                />
              );
            })}
          </>
        ) : null}
      </div>
    </div>
  );
}

interface ExternalAgentRowProps {
  agent: OpenclawAgent;
  expanded: boolean;
  activeSessionKey: string;
  onToggle: () => void;
  onSelectSession: (key: string) => void;
  onDeleteSession: (key: string) => void;
}

function ExternalAgentRow({ agent, expanded, activeSessionKey, onToggle, onSelectSession, onDeleteSession }: ExternalAgentRowProps) {
  return (
    <div className='flex flex-col'>
      <SidebarItem
        icon={<User className='size-4 shrink-0' />}
        label={agent.name}
        subtitle={agent.isDefault ? 'default' : undefined}
        active={false}
        onClick={onToggle}
        chevron={<ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />}
      />
      {expanded ? (
        <div className='flex flex-col gap-0.5 pl-4 py-1'>
          {agent.sessions.length === 0 ? (
            <div className='px-2 py-1 text-xs text-muted-foreground italic'>No sessions</div>
          ) : (
            agent.sessions.map((s) => (
              <SidebarItem
                key={s.key}
                icon={<MessageSquare className='size-3.5 shrink-0' />}
                label={s.title ?? shortSessionKey(s.key)}
                subtitle={s.lastMessage ?? undefined}
                active={s.key === activeSessionKey}
                onClick={() => onSelectSession(s.key)}
                onDelete={() => onDeleteSession(s.key)}
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function shortSessionKey(key: string): string {
  const parts = key.split(':');
  return parts[parts.length - 1] ?? key;
}

interface AgentRowProps {
  agent: AgentNodeRef;
  expanded: boolean;
  sessions: SessionEntry[];
  externalAgent: OpenclawAgent | null;
  activeSessionKey: string;
  onToggle: () => void;
  onCreateSession: (agent: AgentNodeRef, job: AgentJobRef) => void;
  onSelectSession: (key: string) => void;
  onDeleteSession: (key: string) => void;
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

function AgentRow({ agent, expanded, sessions, externalAgent, activeSessionKey, onToggle, onCreateSession, onSelectSession, onDeleteSession }: AgentRowProps) {
  const groups = buildSessionGroups(agent, sessions, externalAgent);
  return (
    <div className='flex flex-col'>
      <SidebarItem
        icon={agent.avatar ? (
          <img src={agent.avatar} alt='' className='size-4 shrink-0 rounded-full object-cover' />
        ) : (
          <User className='size-4 shrink-0' />
        )}
        label={agent.name}
        subtitle={agent.spaceName}
        active={false}
        onClick={onToggle}
        chevron={<ChevronRight className={cn('size-3 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} />}
      />
      {expanded ? (
        <div className='flex flex-col gap-0.5 pl-4 py-1'>
          {agent.jobs.length === 0 ? (
            <div className='px-2 py-1 text-xs text-muted-foreground italic'>No jobs connected</div>
          ) : (
            agent.jobs.map((job) => {
              const jobSessions = groups.byJob.get(job.nodeId) ?? [];
              return (
                <div key={job.nodeId} className='flex flex-col gap-0.5'>
                  <SidebarItem
                    icon={<Briefcase className='size-3.5 shrink-0' />}
                    label={job.name}
                    active={false}
                    onClick={() => onCreateSession(agent, job)}
                  />
                  {jobSessions.length > 0 ? (
                    <div className='flex flex-col gap-0.5 pl-4'>
                      {jobSessions.map((s) => (
                        <SidebarItem
                          key={s.key}
                          icon={<MessageSquare className='size-3.5 shrink-0' />}
                          label={s.label}
                          subtitle={s.subtitle}
                          active={s.key === activeSessionKey}
                          onClick={() => onSelectSession(s.key)}
                          onDelete={() => onDeleteSession(s.key)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
          {groups.pet.length > 0 ? (
            <>
              <div className='px-2 pt-2 pb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground'>Pet Project</div>
              {groups.pet.map((s) => (
                <SidebarItem
                  key={s.key}
                  icon={<MessageSquare className='size-3.5 shrink-0' />}
                  label={s.label}
                  subtitle={s.subtitle}
                  active={s.key === activeSessionKey}
                  onClick={() => onSelectSession(s.key)}
                  onDelete={() => onDeleteSession(s.key)}
                />
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

interface SidebarItemProps {
  icon: React.ReactNode;
  label: string;
  subtitle?: string;
  active: boolean;
  chevron?: React.ReactNode;
  onClick: () => void;
  onDelete?: () => void;
}

function SidebarItem({ icon, label, subtitle, active, chevron, onClick, onDelete }: SidebarItemProps) {
  return (
    <div
      role='button'
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-hidden transition-colors cursor-pointer',
        'hover:bg-accent hover:text-accent-foreground',
        active && 'bg-accent text-accent-foreground font-medium',
      )}
    >
      {icon}
      <span className='flex-1 min-w-0 truncate'>{label}</span>
      {subtitle ? (
        <span className='text-[10px] font-mono text-muted-foreground truncate max-w-24'>{subtitle}</span>
      ) : null}
      {onDelete ? (
        <button
          type='button'
          onClick={(e) => {
            e.stopPropagation(); onDelete();
          }}
          className='opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity'
          aria-label='Delete session'
        >
          <Trash2 className='size-3.5 shrink-0' />
        </button>
      ) : null}
      {chevron}
    </div>
  );
}
