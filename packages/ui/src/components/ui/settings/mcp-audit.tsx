'use client'

import { useState } from 'react'

import { Badge } from 'ui/components/ui/badge'
import { Button } from 'ui/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/components/ui/select'
import { Spinner } from 'ui/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'ui/components/ui/table'
import { cn } from 'cn'

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
  // A query in flight: the header spinner and inert actions.
  pending: boolean
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

function formatTime(iso: string) {
  return new Date(iso).toLocaleString()
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

// The MCP call history: every tool invocation recorded, filterable by tool
// and status, each row expanding in place to the arguments, result and error
// it recorded.
//
// Presentation only: entries arrive as props, filters and actions leave as
// callbacks. Which row is expanded is this page's own state -- nobody
// elsewhere cares which row is open.
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
