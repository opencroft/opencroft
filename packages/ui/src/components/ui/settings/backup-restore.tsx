'use client'

import { Download, Plus, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'

import { Button } from 'ui/components/ui/button'
import { Progress } from 'ui/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/components/ui/select'
import { Spinner } from 'ui/components/ui/spinner'
import { Switch } from 'ui/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'ui/components/ui/table'
import { cn } from 'ui/lib/utils'

export interface BackupFileInfo {
  filename: string
  // ISO timestamp; formatted for display here.
  createdAt: string
  sizeBytes: number
}

export type BackupIntervalUnit = 'minutes' | 'hours' | 'days'

export interface BackupSchedule {
  enabled: boolean
  intervalValue: number
  intervalUnit: BackupIntervalUnit
  retentionDays: number
  minRecentBackups: number
  // Epoch milliseconds; formatted for display here.
  lastRunAt?: number
}

export interface BackupStorageStats {
  totalBackupBytes: number
  backupCount: number
  diskTotalBytes: number
  diskFreeBytes: number
}

export interface BackupRestoreProps {
  backups: BackupFileInfo[]
  // null while first loading: the storage card says so.
  stats: BackupStorageStats | null
  // null while first loading: the schedule editor says so.
  schedule: BackupSchedule | null
  // The schedule was changed beyond a keystroke -- a toggle, a unit choice,
  // or a field committed on blur. The host persists it and hands back the
  // saved schedule as the prop.
  onScheduleChange: (next: BackupSchedule) => void
  // First load of the list: the table shows its loading row.
  loading: boolean
  // Any act in flight: the header spinner and the inert actions.
  pending: boolean
  // The file a restore or delete is running against: that row's actions go
  // inert so the same backup cannot be acted on twice.
  busyFile?: string | null
  onRefresh: () => void
  // Create a backup now. Upload opens the host's file picker -- the file
  // itself never passes through this component.
  onCreate: () => void
  onUpload: () => void
  onDownload: (filename: string) => void
  // Restore and delete are destructive; confirmations are the host's.
  onRestore: (filename: string) => void
  onDelete: (filename: string) => void
  // Wipe every table. The most destructive act on the page, and alone in
  // its own section for exactly that reason.
  onReset: () => void
  className?: string
}

const UNIT_OPTIONS: { value: BackupIntervalUnit; label: string }[] = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
]

const UNIT_DAYS: Record<BackupIntervalUnit, number> = {
  minutes: 1 / 1440,
  hours: 1 / 24,
  days: 1,
}

function formatDate(iso: string) {
  const date = new Date(iso)
  const now = Date.now()
  const diffMin = Math.round((now - date.getTime()) / 60_000)
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

  if (diffMin < 1) {
    return 'Just now'
  }
  if (diffMin < 60) {
    return `${diffMin}m ago`
  }
  const today = new Date(now)
  if (date.toDateString() === today.toDateString()) {
    return `Today at ${time}`
  }
  const yesterday = new Date(now - 86_400_000)
  if (date.toDateString() === yesterday.toDateString()) {
    return `Yesterday at ${time}`
  }
  const day = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  return `${day} at ${time}`
}

function formatSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function predictRetentionUsage(schedule: BackupSchedule, backups: BackupFileInfo[]) {
  const intervalDays = Math.max(schedule.intervalValue, 1) * UNIT_DAYS[schedule.intervalUnit]
  const predictedCount = Math.max(
    Math.max(1, schedule.minRecentBackups),
    Math.ceil(schedule.retentionDays / intervalDays),
  )
  const recentSize = backups[0]?.sizeBytes ?? 0
  return { predictedCount, predictedBytes: predictedCount * recentSize }
}

function StorageCard({ stats }: { stats: BackupStorageStats | null }) {
  if (!stats) {
    return (
      <div className='rounded-lg border p-4 flex items-center justify-center text-sm text-muted-foreground'>
        <Spinner className='size-4 mr-2' /> Loading storage…
      </div>
    )
  }
  const diskUsedBytes = stats.diskTotalBytes - stats.diskFreeBytes
  const diskUsedPct = stats.diskTotalBytes > 0 ? (diskUsedBytes / stats.diskTotalBytes) * 100 : 0
  return (
    <div className='rounded-lg border p-4 space-y-2'>
      <div className='flex items-center justify-between text-sm'>
        <span className='font-medium'>Backup storage</span>
        <span className='text-muted-foreground'>
          {formatSize(stats.totalBackupBytes)} across {stats.backupCount} backup(s)
        </span>
      </div>
      <Progress value={diskUsedPct} />
      <div className='flex items-center justify-between text-xs text-muted-foreground'>
        <span>{formatSize(diskUsedBytes)} used on disk</span>
        <span>
          {formatSize(stats.diskFreeBytes)} free of {formatSize(stats.diskTotalBytes)}
        </span>
      </div>
    </div>
  )
}

// The schedule editor. Keystrokes live in a draft here; a toggle, a unit
// choice, or a field committed on blur leaves as onScheduleChange, and the
// saved schedule arrives back as the prop -- so an in-flight save and a
// half-typed number never fight over the same field.
function ScheduleCard({
  schedule,
  backups,
  onScheduleChange,
}: {
  schedule: BackupSchedule | null
  backups: BackupFileInfo[]
  onScheduleChange: (next: BackupSchedule) => void
}) {
  const [draft, setDraft] = useState<BackupSchedule | null>(schedule)

  useEffect(() => {
    setDraft(schedule)
  }, [schedule])

  if (!draft) {
    return (
      <div className='rounded-lg border p-4 flex items-center justify-center text-sm text-muted-foreground'>
        <Spinner className='size-4 mr-2' /> Loading schedule…
      </div>
    )
  }

  const save = (next: BackupSchedule) => onScheduleChange(next)

  const prediction = predictRetentionUsage(draft, backups)

  return (
    <div className='rounded-lg border p-4 space-y-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <div className='text-sm font-medium'>Scheduled backups</div>
          <div className='text-xs text-muted-foreground'>
            Automatically create a backup on a recurring interval.
            {draft.lastRunAt && ` Last run ${formatDate(new Date(draft.lastRunAt).toISOString())}.`}
          </div>
        </div>
        <Switch
          checked={draft.enabled}
          onCheckedChange={() => save({ ...draft, enabled: !draft.enabled })}
          aria-label='Toggle scheduled backups'
          className='shrink-0'
        />
      </div>

      <div className='flex items-center gap-2 text-sm'>
        <span className='text-muted-foreground'>Every</span>
        <input
          type='number'
          min={1}
          value={draft.intervalValue}
          onChange={(e) => setDraft({ ...draft, intervalValue: Math.max(1, Number(e.target.value) || 1) })}
          onBlur={() => save(draft)}
          className='w-20 rounded-md border bg-background px-2 py-1'
          aria-label='Interval value'
        />
        <Select
          value={draft.intervalUnit}
          onValueChange={(value) => save({ ...draft, intervalUnit: value as BackupIntervalUnit })}
        >
          <SelectTrigger className='w-32' aria-label='Interval unit'>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {UNIT_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className='space-y-1 border-t pt-3'>
        <div className='flex items-center gap-2 text-sm'>
          <span className='text-muted-foreground'>Delete backups older than</span>
          <input
            type='number'
            min={0}
            value={draft.retentionDays}
            onChange={(e) => setDraft({ ...draft, retentionDays: Math.max(0, Number(e.target.value) || 0) })}
            onBlur={() => save(draft)}
            className='w-20 rounded-md border bg-background px-2 py-1'
            aria-label='Retention days'
          />
          <span className='text-muted-foreground'>days (0 = keep forever)</span>
        </div>
        <div className='flex items-center gap-2 text-sm'>
          <span className='text-muted-foreground'>Always keep at least</span>
          <input
            type='number'
            min={1}
            value={draft.minRecentBackups}
            onChange={(e) => setDraft({ ...draft, minRecentBackups: Math.max(1, Number(e.target.value) || 1) })}
            onBlur={() => save(draft)}
            className='w-20 rounded-md border bg-background px-2 py-1'
            aria-label='Minimum recent backups'
          />
          <span className='text-muted-foreground'>most recent backup(s)</span>
        </div>
        {draft.retentionDays > 0 && (
          <div className='text-xs text-muted-foreground'>
            At every {draft.intervalValue} {draft.intervalUnit}, keeping {draft.retentionDays} days of backups
            predicts ~{prediction.predictedCount} backup(s) (~{formatSize(prediction.predictedBytes)}), based on the
            most recent backup's size.
          </div>
        )}
      </div>
    </div>
  )
}

// The Backup & Restore page. Snapshots of everything -- settings, secrets,
// spaces, the MCP audit log -- and what keeps them:
//
//   - What the backups cost: the storage card, and how the disk they live on
//     stands.
//   - What keeps arriving: the schedule editor. Its retention prediction is
//     stated in the schedule's own words, so the numbers a reader reasons
//     with are the numbers the scheduler keeps.
//   - The one act that cannot be walked back from inside the app: wiping
//     every table. Alone in a destructive section of its own, reached
//     deliberately, never read as the same gesture as a restore.
//   - The backups themselves: rows that download, restore and delete.
//
// Presentation only: backups, stats and the schedule arrive as props, every
// act leaves as a callback, and the file picker, the confirmations and the
// toasts stay with the host.
export function BackupRestore({
  backups,
  stats,
  schedule,
  onScheduleChange,
  loading,
  pending,
  busyFile,
  onRefresh,
  onCreate,
  onUpload,
  onDownload,
  onRestore,
  onDelete,
  onReset,
  className,
}: BackupRestoreProps) {
  return (
    <div className={cn('p-6 space-y-6', className)}>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h1 className='text-2xl font-bold flex items-center gap-2'>
            Backup &amp; Restore
            {pending && <Spinner className='size-5 text-muted-foreground' />}
          </h1>
          <p className='text-sm text-muted-foreground'>
            Snapshots of settings, secrets, spaces, and the MCP audit log.
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button variant='outline' size='sm' onClick={onRefresh} disabled={pending}>
            <RefreshCw /> Refresh
          </Button>
          <Button variant='outline' size='sm' onClick={onCreate} disabled={pending}>
            <Plus /> Create backup
          </Button>
          <Button variant='outline' size='sm' onClick={onUpload} disabled={pending}>
            <Upload /> Upload
          </Button>
        </div>
      </div>

      <StorageCard stats={stats} />

      <ScheduleCard schedule={schedule} backups={backups} onScheduleChange={onScheduleChange} />

      <div className='rounded-lg border border-destructive/50 p-4 flex items-center justify-between gap-4'>
        <div>
          <div className='text-sm font-medium text-destructive'>Danger zone</div>
          <div className='text-xs text-muted-foreground'>
            Permanently wipe every table (settings, secrets, spaces, MCP audit log). Back up first.
          </div>
        </div>
        <Button variant='destructive' size='sm' onClick={onReset} disabled={pending}>
          <Trash2 /> Reset database
        </Button>
      </div>

      <div className='rounded-lg border'>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Created</TableHead>
              <TableHead>Filename</TableHead>
              <TableHead className='w-24'>Size</TableHead>
              <TableHead className='w-56 text-right'>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={4} className='py-12'>
                  <div className='flex items-center justify-center gap-2 text-sm text-muted-foreground'>
                    <Spinner /> Loading backups…
                  </div>
                </TableCell>
              </TableRow>
            ) : backups.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className='text-center text-sm text-muted-foreground py-8'>
                  No backups yet.
                </TableCell>
              </TableRow>
            ) : (
              backups.map((backup) => (
                <TableRow key={backup.filename}>
                  <TableCell className='whitespace-nowrap text-sm'>{formatDate(backup.createdAt)}</TableCell>
                  <TableCell className='font-mono text-xs'>{backup.filename}</TableCell>
                  <TableCell className='text-xs text-muted-foreground'>{formatSize(backup.sizeBytes)}</TableCell>
                  <TableCell>
                    <div className='flex items-center justify-end gap-1'>
                      <Button
                        variant='ghost'
                        size='icon'
                        aria-label={`Download ${backup.filename}`}
                        onClick={() => onDownload(backup.filename)}
                      >
                        <Download />
                      </Button>
                      <Button
                        variant='ghost'
                        size='icon'
                        aria-label={`Restore ${backup.filename}`}
                        disabled={busyFile === backup.filename}
                        onClick={() => onRestore(backup.filename)}
                      >
                        <RotateCcw />
                      </Button>
                      <Button
                        variant='ghost'
                        size='icon'
                        aria-label={`Delete ${backup.filename}`}
                        disabled={busyFile === backup.filename}
                        onClick={() => onDelete(backup.filename)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
