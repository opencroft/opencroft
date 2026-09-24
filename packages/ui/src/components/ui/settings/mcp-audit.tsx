'use client'

import { Moon, ShieldAlert } from 'lucide-react'
import { useState } from 'react'

import { Badge } from 'ui/components/ui/badge'
import { Button } from 'ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/components/ui/select'
import { Spinner } from 'ui/components/ui/spinner'
import { Switch } from 'ui/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'ui/components/ui/table'
import { cn } from 'ui/lib/utils'

export type AuditStatus = 'auto-approved' | 'approved' | 'rejected' | 'error'
export type AuditStatusFilter = AuditStatus | 'all'

export interface McpAuditEntry {
  id: string
  // ISO timestamp; formatted for display here.
  createdAt: string
  tool: string
  status: AuditStatus
  durationMs: number
  // Raw JSON or plain text, shown only in the expanded row, pretty-printed
  // when it parses.
  args?: string | null
  result?: string | null
  error?: string | null
}

export interface McpAuditSession {
  key: string
  title?: string
  status: 'idle' | 'working' | 'waiting' | (string & {})
  queuedMessages: number
  // Epoch milliseconds; formatted for display here.
  lastActivityAt: number
}

// Work a tool or an action started for a caller and did not wait for.
export interface McpAuditBackgroundTask {
  id: string
  // One line saying what the task is, in the caller's own terms.
  summary: string
  // What started it -- a tool, or an action of an app or a node -- and which
  // one (remote_script, deploy).
  kind: 'tool' | 'app-action' | 'node-action'
  name: string
  // Where the work runs, which is what decides whether a restart of the
  // server ends it: in the server (the default for everything), or detached on
  // its node by the background task runner (experimental), which outlives one.
  runner: 'in-process' | 'background-task-runner'
  // What it runs against: a terminal target, a node id, an app address.
  target: string
  // The calling session's key; null for a caller with no session.
  session: string | null
  agent: string | null
  state: 'running' | 'completed' | 'failed' | 'stopped'
  // Why it ended the way it did. Shown only when that was not completion.
  reason?: string | null
  // Epoch milliseconds; formatted for display here. A running task's time so
  // far is measured against the reader's clock.
  startedAt: number
  finishedAt?: number | null
}

export interface McpAuditProps {
  entries: McpAuditEntry[]
  // The tools known to have been invoked; feeds the tool filter.
  tools: string[]
  // Current filter values. tool undefined means all tools.
  tool?: string
  status: AuditStatusFilter
  onToolChange: (tool: string | undefined) => void
  onStatusChange: (status: AuditStatusFilter) => void
  // The reader asked for the log again, or for all of it to be thrown away.
  // Clearing is destructive; any confirmation is the host's.
  onRefresh: () => void
  onClear: () => void
  // First load of the log: the table shows its loading row.
  loading: boolean
  // Any query or mode change in flight: the header spinner and inert actions.
  pending: boolean
  // Sleep mode holds all agent deliveries: running turns finish, new messages
  // enqueue and are kept, nothing is delivered until the instance wakes.
  sleepEnabled: boolean
  onToggleSleep: () => void
  // YOLO mode skips all MCP tool approvals. Where the flag came from, when it
  // is on, is part of what the page says -- an env setting and a runtime
  // override do not survive a restart the same way.
  yoloEnabled: boolean
  yoloSource?: 'env' | 'runtime'
  onToggleYolo: () => void
  // The sessions that are not offline -- what makes this page answer
  // "can I restart now".
  sessions: McpAuditSession[]
  // The same question asked of the work sessions leave behind: every
  // background task still running, and what ended recently -- a sessionless
  // caller's too, which no session above accounts for. Null until the host
  // has read it once, and drawn as not read yet: an unread list must never
  // pass for "nothing is running".
  backgroundTasks: McpAuditBackgroundTask[] | null
  // Why the list could not be read. Set, it replaces the list and its count,
  // for the same reason.
  backgroundTasksError?: string | null
  className?: string
}

const ALL = '__all__'

const STATUS_OPTIONS: { value: AuditStatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'auto-approved', label: 'Auto-approved' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'error', label: 'Error' },
]

const STATUS_BADGE: Record<
  AuditStatus,
  { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }
> = {
  'auto-approved': { label: 'auto', variant: 'secondary' },
  approved: { label: 'approved', variant: 'default' },
  rejected: { label: 'rejected', variant: 'outline' },
  error: { label: 'error', variant: 'destructive' },
}

// The page's own badge vocabulary, so a tone means one thing on it: running
// wears what a working session wears, failed what an errored call wears, and
// the two quiet outcomes stay quiet -- completed filled, stopped outlined, so
// they still tell apart.
const TASK_BADGE: Record<McpAuditBackgroundTask['state'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
  running: 'default',
  completed: 'secondary',
  failed: 'destructive',
  stopped: 'outline',
}

const TASK_KIND: Record<McpAuditBackgroundTask['kind'], string> = {
  tool: 'tool',
  'app-action': 'app action',
  'node-action': 'node action',
}

// Said on every row, because it is the half of "can I restart now" the state
// does not answer: a restart fails what runs in the server and leaves what
// runs on a node running.
const TASK_RUNNER: Record<McpAuditBackgroundTask['runner'], string> = {
  'in-process': 'in the server',
  'background-task-runner': 'on its node',
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString()
}

// In the units the chat's own task card uses, so a task reads the same here
// as in the session that started it.
function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
  }
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

// How long it ran, or has been running. An ended task with no end recorded
// has nothing honest to measure, so it gets no line rather than a guess.
function taskDuration(task: McpAuditBackgroundTask, now: number): string | null {
  if (task.state === 'running') {
    return `${formatDuration(now - task.startedAt)} so far`
  }
  if (typeof task.finishedAt !== 'number') {
    return null
  }
  return `took ${formatDuration(task.finishedAt - task.startedAt)}`
}

function formatJson(body: string | null | undefined): string | null {
  if (!body) {
    return null
  }
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

function StatusBadge({ status }: { status: AuditStatus }) {
  const cfg = STATUS_BADGE[status] ?? { label: status, variant: 'outline' as const }
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>
}

function PayloadBlock({ title, body }: { title: string; body: string | null | undefined }) {
  const formatted = formatJson(body)
  if (!formatted) {
    return null
  }
  return (
    <div className='space-y-1'>
      <div className='text-xs font-medium text-muted-foreground'>{title}</div>
      <pre className='text-xs whitespace-pre-wrap break-all bg-muted/50 rounded-md p-2 max-h-60 overflow-auto font-mono'>
        {formatted}
      </pre>
    </div>
  )
}

function AuditRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: McpAuditEntry
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <>
      <TableRow className='cursor-pointer' onClick={onToggle}>
        <TableCell className='whitespace-nowrap text-xs text-muted-foreground'>{formatTime(entry.createdAt)}</TableCell>
        <TableCell className='font-mono text-xs'>{entry.tool}</TableCell>
        <TableCell>
          <StatusBadge status={entry.status} />
        </TableCell>
        <TableCell className='text-xs text-muted-foreground'>{entry.durationMs}ms</TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={4} className='bg-muted/20'>
            <div className='space-y-3 p-2'>
              <PayloadBlock title='Arguments' body={entry.args} />
              <PayloadBlock title='Result' body={entry.result} />
              <PayloadBlock title='Error' body={entry.error} />
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}

function TaskRow({ task, now }: { task: McpAuditBackgroundTask; now: number }) {
  const duration = taskDuration(task, now)
  // Completion needs no explanation and running has not ended; any other
  // ending is the one a reader asks "why" of.
  const reason = task.state === 'failed' || task.state === 'stopped' ? task.reason : null
  return (
    <TableRow>
      <TableCell className='whitespace-normal'>
        <div className='text-sm'>{task.summary}</div>
        <div className='text-xs text-muted-foreground'>
          {TASK_KIND[task.kind] ?? task.kind} <span className='font-mono'>{task.name}</span> ·{' '}
          {TASK_RUNNER[task.runner] ?? task.runner}
        </div>
        {reason && (
          <div className={cn('text-xs', task.state === 'failed' ? 'text-destructive' : 'text-muted-foreground')}>
            {reason}
          </div>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={TASK_BADGE[task.state] ?? 'outline'}>{task.state}</Badge>
      </TableCell>
      <TableCell className='whitespace-normal break-all font-mono text-xs'>{task.target || '—'}</TableCell>
      <TableCell className='whitespace-normal'>
        <div className='text-sm'>{task.agent ?? 'no agent'}</div>
        {task.session ? (
          <div className='text-xs text-muted-foreground font-mono break-all'>{task.session}</div>
        ) : (
          <div className='text-xs text-muted-foreground'>no session</div>
        )}
      </TableCell>
      <TableCell className='text-xs text-muted-foreground'>
        <div>{formatTime(new Date(task.startedAt).toISOString())}</div>
        {duration && <div>{duration}</div>}
      </TableCell>
    </TableRow>
  )
}

// The background tasks, drawn like the session table above them and for the
// same question. Running work leads -- it is what the count counts and what a
// restart would meet -- and the rest keeps the order the host gave. The list
// can hold nothing in three ways, and each is drawn differently, because only
// one of them means nothing is running: not read yet, could not be read, and
// read empty.
function BackgroundTasksCard({ tasks, error }: { tasks: McpAuditBackgroundTask[] | null; error?: string | null }) {
  // Read at render: a running task's time moves as often as the host redraws,
  // which a polling host does on every poll.
  const now = Date.now()
  const running = tasks ? tasks.filter((task) => task.state === 'running') : []
  const ended = tasks ? tasks.filter((task) => task.state !== 'running') : []
  return (
    <div className='rounded-lg border'>
      <div className='flex items-center justify-between gap-4 px-4 py-3 border-b'>
        <div>
          <div className='text-sm font-medium'>Background tasks</div>
          <div className='text-xs text-muted-foreground'>
            Work tools and actions started and did not wait for: everything still running, and what ended
            recently. Most of it runs in the server, and a restart fails it; a command on the background task
            runner (experimental) runs on its node and outlives a restart.
          </div>
        </div>
        {error ? (
          <Badge variant='destructive'>unknown</Badge>
        ) : tasks ? (
          <Badge variant={running.length > 0 ? 'default' : 'secondary'}>{running.length} running</Badge>
        ) : null}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead className='w-28'>State</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Caller</TableHead>
            <TableHead className='w-44'>Started</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {error ? (
            <TableRow>
              <TableCell colSpan={5} className='whitespace-normal text-center py-6'>
                <div className='text-sm text-destructive'>
                  Background tasks could not be read — whether anything is running is unknown.
                </div>
                <div className='text-xs text-muted-foreground font-mono break-all'>{error}</div>
              </TableCell>
            </TableRow>
          ) : !tasks ? (
            <TableRow>
              <TableCell colSpan={5} className='py-6'>
                <div className='flex items-center justify-center gap-2 text-sm text-muted-foreground'>
                  <Spinner /> Reading background tasks…
                </div>
              </TableCell>
            </TableRow>
          ) : tasks.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className='text-center text-sm text-muted-foreground py-6'>
                No background tasks — nothing detached is running.
              </TableCell>
            </TableRow>
          ) : (
            [...running, ...ended].map((task) => <TaskRow key={task.id} task={task} now={now} />)
          )}
        </TableBody>
      </Table>
    </div>
  )
}

// The MCP audit page. Three answers on one page:
//
//   - What did the tools do -- the log itself, filterable by tool and status,
//     each row expanding in place to the arguments, result and error it
//     recorded.
//   - Is it safe to restart -- the live session table, and under it the
//     background tasks: the work sessions leave behind, sessionless callers'
//     included. Their whole job is answering "can I restart now", which a
//     snapshot cannot, so the host keeps them live and this only draws what
//     arrives.
//   - Two instance-wide modes, drawn as different things because they are:
//     sleep mode (amber) holds deliveries but keeps them, YOLO mode (red)
//     skips approvals and cannot be taken back for what already ran.
//
// Presentation only: entries, sessions, tasks and mode flags arrive as
// props, filters and toggles leave as callbacks, and the polling that keeps
// the live parts live stays with the host. Which rows are expanded is this
// page's own state -- nobody elsewhere cares which row is open.
export function McpAudit({
  entries,
  tools,
  tool,
  status,
  onToolChange,
  onStatusChange,
  onRefresh,
  onClear,
  loading,
  pending,
  sleepEnabled,
  onToggleSleep,
  yoloEnabled,
  yoloSource,
  onToggleYolo,
  sessions,
  backgroundTasks,
  backgroundTasksError,
  className,
}: McpAuditProps) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const toggle = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  return (
    <div className={cn('p-6 space-y-6', className)}>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h1 className='text-2xl font-bold flex items-center gap-2'>
            MCP audit
            {pending && <Spinner className='size-5 text-muted-foreground' />}
          </h1>
          <p className='text-sm text-muted-foreground'>Every MCP tool invocation is recorded automatically.</p>
        </div>
        <div className='flex items-center gap-2'>
          <Button variant='outline' size='sm' onClick={onRefresh} disabled={pending}>
            Refresh
          </Button>
          <Button variant='ghost' size='sm' onClick={onClear} disabled={pending || entries.length === 0}>
            Clear
          </Button>
        </div>
      </div>

      <div className='flex items-center gap-3'>
        <Select
          value={tool ?? ALL}
          items={[{ value: ALL, label: 'All tools' }, ...tools.map((name) => ({ value: name, label: name }))]}
          onValueChange={(value) => {
            if (value !== null) {
              onToolChange(value === ALL ? undefined : value)
            }
          }}
        >
          <SelectTrigger className='w-64'>
            <SelectValue placeholder='Tool' />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All tools</SelectItem>
            {tools.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={status}
          items={STATUS_OPTIONS}
          onValueChange={(value) => {
            if (value !== null) {
              onStatusChange(value as AuditStatusFilter)
            }
          }}
        >
          <SelectTrigger className='w-48'>
            <SelectValue placeholder='Status' />
          </SelectTrigger>
          <SelectContent>
            {STATUS_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='rounded-lg border p-4 flex items-center justify-between gap-4'>
        <div className='flex items-center gap-3'>
          <Moon className={`size-5 ${sleepEnabled ? 'text-amber-500' : 'text-muted-foreground'}`} aria-hidden='true' />
          <div>
            <div className='text-sm font-medium'>
              Sleep Mode
              {sleepEnabled && (
                <Badge variant='outline' className='ml-2 border-amber-500 text-amber-500'>
                  ASLEEP
                </Badge>
              )}
            </div>
            <div className='text-xs text-muted-foreground'>
              Hold all agent deliveries. Running turns finish, new messages enqueue and are kept, nothing is
              delivered until the instance wakes. Survives a restart — that is the point: raise it, wait for
              everyone below to go idle, restart calmly, then switch it off to deliver what accumulated.
            </div>
          </div>
        </div>
        <Switch
          checked={sleepEnabled}
          onCheckedChange={onToggleSleep}
          aria-label='Toggle sleep mode'
          className='shrink-0 data-checked:bg-amber-500'
        />
      </div>

      <div className='rounded-lg border p-4 flex items-center justify-between gap-4'>
        <div className='flex items-center gap-3'>
          <ShieldAlert className={`size-5 ${yoloEnabled ? 'text-red-500' : 'text-muted-foreground'}`} aria-hidden='true' />
          <div>
            <div className='text-sm font-medium'>
              YOLO Mode
              {yoloEnabled && (
                <Badge variant='destructive' className='ml-2'>
                  ACTIVE
                </Badge>
              )}
            </div>
            <div className='text-xs text-muted-foreground'>
              Skip all MCP tool approvals. Agents execute without confirmation.
              {yoloSource === 'env' && ' (set via OPENCROFT_YOLO_MODE env)'}
              {yoloSource === 'runtime' && ' (runtime override, resets on restart)'}
            </div>
          </div>
        </div>
        <Switch
          checked={yoloEnabled}
          onCheckedChange={onToggleYolo}
          aria-label='Toggle YOLO mode'
          className='shrink-0 data-checked:bg-red-500'
        />
      </div>

      <div className='rounded-lg border'>
        <div className='flex items-center justify-between px-4 py-3 border-b'>
          <div>
            <div className='text-sm font-medium'>Active sessions</div>
            <div className='text-xs text-muted-foreground'>
              Every session that is not offline. Safe to restart when nothing is working or waiting and no
              queue is left you would rather deliver first{sleepEnabled ? ' — deliveries are currently held' : ''}.
            </div>
          </div>
          <Badge variant={sessions.some((s) => s.status !== 'idle') ? 'default' : 'secondary'}>
            {sessions.filter((s) => s.status !== 'idle').length} busy / {sessions.length} live
          </Badge>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Session</TableHead>
              <TableHead className='w-28'>State</TableHead>
              <TableHead className='w-24'>Queued</TableHead>
              <TableHead className='w-44'>Last activity</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className='text-center text-sm text-muted-foreground py-6'>
                  No live sessions — nothing is running.
                </TableCell>
              </TableRow>
            ) : (
              sessions.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>
                    <div className='text-sm'>{row.title || row.key}</div>
                    {row.title && <div className='text-xs text-muted-foreground font-mono'>{row.key}</div>}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={row.status === 'working' ? 'default' : row.status === 'waiting' ? 'destructive' : 'outline'}
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className={row.queuedMessages > 0 ? 'font-medium' : 'text-muted-foreground'}>
                    {row.queuedMessages}
                  </TableCell>
                  <TableCell className='text-xs text-muted-foreground'>
                    {formatTime(new Date(row.lastActivityAt).toISOString())}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <BackgroundTasksCard tasks={backgroundTasks} error={backgroundTasksError} />

      <div className='rounded-lg border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className='w-48'>Time</TableHead>
              <TableHead>Tool</TableHead>
              <TableHead className='w-28'>Status</TableHead>
              <TableHead className='w-24'>Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={4} className='py-12'>
                  <div className='flex items-center justify-center gap-2 text-sm text-muted-foreground'>
                    <Spinner /> Loading audit log…
                  </div>
                </TableCell>
              </TableRow>
            ) : entries.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className='text-center text-sm text-muted-foreground py-8'>
                  No MCP calls recorded yet.
                </TableCell>
              </TableRow>
            ) : (
              entries.map((entry) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  expanded={expandedId === entry.id}
                  onToggle={() => toggle(entry.id)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
