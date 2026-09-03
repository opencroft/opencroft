'use client'

import { Moon, ShieldAlert } from 'lucide-react'
import { useEffect, useState, useTransition } from 'react'
import { Badge } from 'ui/badge'
import { Button } from 'ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/select'
import { Spinner } from 'ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'ui/table'

import type { AuditStatus } from '@/app/_authed/(mcp)/_server/audit'
import {
  type AuditQuery,
  clearAuditLog,
  getSleepMode,
  getYoloMode,
  listAuditEntries,
  listAuditTools,
  listLiveSessions,
  type LiveSessionRow,
  type McpAuditEntry,
  updateSleepMode,
  updateYoloMode,
} from '@/app/_authed/(settings)/_server/audit-actions'

const ALL = '__all__'

type StatusFilter = AuditStatus | 'all'

const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
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

function formatTime(iso: string) {
  return new Date(iso).toLocaleString()
}

function formatJson(body: string | null): string | null {
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

function PayloadBlock({ title, body }: { title: string; body: string | null }) {
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

function AuditRow({ entry, expanded, onToggle }: { entry: McpAuditEntry; expanded: boolean; onToggle: () => void }) {
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

export default function AuditSettings() {
  const [entries, setEntries] = useState<McpAuditEntry[]>([])
  const [tools, setTools] = useState<string[]>([])
  const [tool, setTool] = useState<string>(ALL)
  const [status, setStatus] = useState<StatusFilter>('all')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, startTransition] = useTransition()
  const [yoloEnabled, setYoloEnabled] = useState(false)
  const [yoloSource, setYoloSource] = useState<'env' | 'runtime'>('env')
  const [sleepEnabled, setSleepEnabled] = useState(false)
  const [sessions, setSessions] = useState<LiveSessionRow[]>([])

  const reload = (next: AuditQuery) => {
    setLoading(true)
    startTransition(async () => {
      const [rows, knownTools] = await Promise.all([listAuditEntries({ data: next }), listAuditTools()])
      setEntries(rows)
      setTools(knownTools)
      setLoading(false)
    })
  }

  useEffect(() => {
    reload({})
    getYoloMode().then(({ enabled, source }) => {
      setYoloEnabled(enabled)
      setYoloSource(source)
    })
  }, [])

  // Sessions and the sleep flag re-poll together: the flag can change
  // out-of-band (the marker file is touchable from outside the app), and the
  // list is only useful live — its whole job is answering "can I restart
  // now", which yesterday's snapshot cannot.
  useEffect(() => {
    let cancelled = false
    const poll = () => {
      listLiveSessions()
        .then((rows) => {
          if (!cancelled) {
            setSessions(rows)
          }
        })
        .catch(() => {})
      getSleepMode()
        .then(({ enabled }) => {
          if (!cancelled) {
            setSleepEnabled(enabled)
          }
        })
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, 2500)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const onToolChange = (value: string) => {
    setTool(value)
    reload({ tool: value === ALL ? undefined : value, status })
  }

  const onStatusChange = (value: string) => {
    const next = value as StatusFilter
    setStatus(next)
    reload({ tool: tool === ALL ? undefined : tool, status: next })
  }

  const onRefresh = () => {
    reload({ tool: tool === ALL ? undefined : tool, status })
  }

  const onClear = () => {
    setLoading(true)
    startTransition(async () => {
      await clearAuditLog()
      const rows = await listAuditEntries({ data: {} })
      setEntries(rows)
      setTools([])
      setTool(ALL)
      setLoading(false)
    })
  }

  const toggle = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }

  return (
    <div className='p-6 space-y-6'>
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
        <Select value={tool} onValueChange={onToolChange}>
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
        <Select value={status} onValueChange={onStatusChange}>
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
          <Moon className={`size-5 ${sleepEnabled ? 'text-amber-500' : 'text-muted-foreground'}`} />
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
        <button
          role='switch'
          aria-checked={sleepEnabled}
          onClick={() => {
            const next = !sleepEnabled
            startTransition(async () => {
              const info = await updateSleepMode({ data: next })
              setSleepEnabled(info.enabled)
            })
          }}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${sleepEnabled ? 'bg-amber-500' : 'bg-input'}`}
        >
          <span
            className={`pointer-events-none block size-5 rounded-full bg-background shadow ring-0 transition-transform ${sleepEnabled ? 'translate-x-5' : 'translate-x-0'}`}
          />
        </button>
      </div>

      <div className='rounded-lg border p-4 flex items-center justify-between gap-4'>
        <div className='flex items-center gap-3'>
          <ShieldAlert className={`size-5 ${yoloEnabled ? 'text-red-500' : 'text-muted-foreground'}`} />
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
        <button
          role='switch'
          aria-checked={yoloEnabled}
          onClick={() => {
            const next = !yoloEnabled
            startTransition(async () => {
              await updateYoloMode({ data: next })
              setYoloEnabled(next)
              setYoloSource('runtime')
            })
          }}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${yoloEnabled ? 'bg-red-500' : 'bg-input'}`}
        >
          <span
            className={`pointer-events-none block size-5 rounded-full bg-background shadow ring-0 transition-transform ${yoloEnabled ? 'translate-x-5' : 'translate-x-0'}`}
          />
        </button>
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
