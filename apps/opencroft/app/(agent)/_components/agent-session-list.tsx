'use client'

import { Briefcase, MessageSquare, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { AgentAvatar } from 'ui/agent-avatar'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from 'ui/dialog'
import { Input } from 'ui/input'

import type { AgentJobRef, AgentNodeRef } from '@/app/(space)/_server/agents'

export interface AgentSessionSummary {
  key: string
  title: string
}

export interface AgentSessionGroup {
  agent: AgentNodeRef
  sessions: AgentSessionSummary[]
}

interface AgentSessionListProps {
  groups: AgentSessionGroup[]
  onOpenSession: (key: string) => void
  onDeleteSession: (agent: AgentNodeRef, key: string) => void
  onCreateSession: (agent: AgentNodeRef, job: AgentJobRef) => void
}

// Searchable agents → their existing sessions list. Each agent has a + that
// opens a dialog of its jobs to start a new session; each session can be
// deleted. Shared by the chat inspector's first page and the Ask-AI input menu.
export function AgentSessionList({ groups, onOpenSession, onDeleteSession, onCreateSession }: AgentSessionListProps) {
  const [query, setQuery] = useState('')
  const [jobsFor, setJobsFor] = useState<AgentNodeRef | null>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return groups
    }
    return groups
      .map((group) => {
        if (group.agent.name.toLowerCase().includes(q)) {
          return group
        }
        const sessions = group.sessions.filter((s) => s.title.toLowerCase().includes(q))
        return sessions.length > 0 ? { ...group, sessions } : null
      })
      .filter((group): group is AgentSessionGroup => group !== null)
  }, [groups, query])

  return (
    // Content-sized (no self scroll/grow): the embedding container — the inspector
    // ScrollArea or the command-bar menu's ScrollArea — owns scrolling. A nested
    // overflow + flex-1 inside Radix ScrollArea oscillates its ResizeObserver into
    // a "Maximum update depth exceeded" loop.
    <div className='flex flex-col'>
      <div className='relative px-2 pt-2'>
        <Search className='pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground' />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder='Search agents…'
          className='h-8 pl-7 text-sm'
        />
      </div>
      <div className='p-2'>
        {filtered.length === 0 ? (
          <div className='px-2 py-6 text-center text-xs text-muted-foreground'>No agents</div>
        ) : (
          filtered.map((group) => (
            <div key={group.agent.nodeId} className='mb-2 min-w-0'>
              <div className='flex items-center gap-2 px-1 py-1'>
                <AgentAvatar avatar={group.agent.avatar} name={group.agent.name} size='md' />
                <span className='min-w-0 flex-1 truncate text-xs font-medium'>{group.agent.name}</span>
                <button
                  type='button'
                  onClick={() => setJobsFor(group.agent)}
                  className='inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
                  aria-label={`New session with ${group.agent.name}`}
                  title='New session'
                >
                  <Plus className='size-4' />
                </button>
              </div>
              <div className='flex flex-col gap-0.5 pl-7'>
                {group.sessions.length === 0 ? (
                  <div className='px-1 py-0.5 text-xs text-muted-foreground'>No sessions</div>
                ) : (
                  group.sessions.map((session) => (
                    <div key={session.key} className='group flex min-w-0 items-center gap-1'>
                      <button
                        type='button'
                        onClick={() => onOpenSession(session.key)}
                        className='flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-1 text-left text-sm hover:bg-accent/50'
                      >
                        <MessageSquare className='size-3.5 shrink-0 text-muted-foreground' />
                        <span className='truncate'>{session.title}</span>
                      </button>
                      <button
                        type='button'
                        onClick={() => onDeleteSession(group.agent, session.key)}
                        className='inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-colors hover:bg-muted hover:text-destructive group-hover:opacity-100'
                        aria-label='Delete session'
                      >
                        <Trash2 className='size-3' />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <Dialog open={jobsFor !== null} onOpenChange={(open) => !open && setJobsFor(null)}>
        <DialogContent className='max-w-sm'>
          <DialogHeader>
            <DialogTitle>New session{jobsFor ? ` · ${jobsFor.name}` : ''}</DialogTitle>
          </DialogHeader>
          <div className='flex flex-col gap-1'>
            {jobsFor && jobsFor.jobs.length === 0 ? (
              <div className='px-1 py-2 text-sm text-muted-foreground'>No jobs available for this agent.</div>
            ) : (
              jobsFor?.jobs.map((job) => (
                <button
                  key={job.nodeId}
                  type='button'
                  onClick={() => {
                    onCreateSession(jobsFor, job)
                    setJobsFor(null)
                  }}
                  className='flex items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-accent'
                >
                  <Briefcase className='size-4 shrink-0 text-muted-foreground' />
                  <span className='truncate'>{job.name}</span>
                </button>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
