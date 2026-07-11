'use client'

import {
  type BackupFileInfo,
  type BackupScheduleConfig,
  type BackupStorageStats,
  createBackupNow,
  deleteBackup,
  getBackupSchedule,
  getBackupStats,
  listBackups,
  resetDatabase,
  restoreBackupNow,
  setBackupSchedule,
  uploadBackup,
} from '@opencroft/db-backups/server'
import { Download, Plus, RefreshCw, RotateCcw, Trash2, Upload } from 'lucide-react'
import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Button } from 'ui/button'
import { Progress } from 'ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from 'ui/select'
import { Spinner } from 'ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from 'ui/table'

const UNIT_OPTIONS: { value: BackupScheduleConfig['intervalUnit']; label: string }[] = [
  { value: 'minutes', label: 'minutes' },
  { value: 'hours', label: 'hours' },
  { value: 'days', label: 'days' },
]

const UNIT_DAYS: Record<BackupScheduleConfig['intervalUnit'], number> = {
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

function predictRetentionUsage(schedule: BackupScheduleConfig, backups: BackupFileInfo[]) {
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

function ScheduleCard({ backups }: { backups: BackupFileInfo[] }) {
  const [schedule, setSchedule] = useState<BackupScheduleConfig | null>(null)
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    getBackupSchedule().then(setSchedule)
  }, [])

  function save(next: BackupScheduleConfig) {
    setSchedule(next)
    startTransition(async () => {
      const saved = await setBackupSchedule({
        data: {
          enabled: next.enabled,
          intervalValue: next.intervalValue,
          intervalUnit: next.intervalUnit,
          retentionDays: next.retentionDays,
          minRecentBackups: next.minRecentBackups,
        },
      })
      setSchedule(saved)
    })
  }

  if (!schedule) {
    return (
      <div className='rounded-lg border p-4 flex items-center justify-center text-sm text-muted-foreground'>
        <Spinner className='size-4 mr-2' /> Loading schedule…
      </div>
    )
  }

  const prediction = predictRetentionUsage(schedule, backups)

  return (
    <div className='rounded-lg border p-4 space-y-4'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <div className='text-sm font-medium'>Scheduled backups</div>
          <div className='text-xs text-muted-foreground'>
            Automatically create a backup on a recurring interval.
            {schedule.lastRunAt && ` Last run ${formatDate(new Date(schedule.lastRunAt).toISOString())}.`}
          </div>
        </div>
        <button
          role='switch'
          aria-checked={schedule.enabled}
          onClick={() => save({ ...schedule, enabled: !schedule.enabled })}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${schedule.enabled ? 'bg-primary' : 'bg-input'}`}
        >
          <span
            className={`pointer-events-none block size-5 rounded-full bg-background shadow ring-0 transition-transform ${schedule.enabled ? 'translate-x-5' : 'translate-x-0'}`}
          />
        </button>
      </div>

      <div className='flex items-center gap-2 text-sm'>
        <span className='text-muted-foreground'>Every</span>
        <input
          type='number'
          min={1}
          value={schedule.intervalValue}
          onChange={(e) => setSchedule({ ...schedule, intervalValue: Math.max(1, Number(e.target.value) || 1) })}
          onBlur={() => save(schedule)}
          className='w-20 rounded-md border bg-background px-2 py-1'
        />
        <Select
          value={schedule.intervalUnit}
          onValueChange={(value) => save({ ...schedule, intervalUnit: value as BackupScheduleConfig['intervalUnit'] })}
        >
          <SelectTrigger className='w-32'>
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
        {pending && <Spinner className='size-4 text-muted-foreground' />}
      </div>

      <div className='space-y-1 border-t pt-3'>
        <div className='flex items-center gap-2 text-sm'>
          <span className='text-muted-foreground'>Delete backups older than</span>
          <input
            type='number'
            min={0}
            value={schedule.retentionDays}
            onChange={(e) => setSchedule({ ...schedule, retentionDays: Math.max(0, Number(e.target.value) || 0) })}
            onBlur={() => save(schedule)}
            className='w-20 rounded-md border bg-background px-2 py-1'
          />
          <span className='text-muted-foreground'>days (0 = keep forever)</span>
        </div>
        <div className='flex items-center gap-2 text-sm'>
          <span className='text-muted-foreground'>Always keep at least</span>
          <input
            type='number'
            min={1}
            value={schedule.minRecentBackups}
            onChange={(e) => setSchedule({ ...schedule, minRecentBackups: Math.max(1, Number(e.target.value) || 1) })}
            onBlur={() => save(schedule)}
            className='w-20 rounded-md border bg-background px-2 py-1'
          />
          <span className='text-muted-foreground'>most recent backup(s)</span>
        </div>
        {schedule.retentionDays > 0 && (
          <div className='text-xs text-muted-foreground'>
            At every {schedule.intervalValue} {schedule.intervalUnit}, keeping {schedule.retentionDays} days of backups
            predicts ~{prediction.predictedCount} backup(s) (~{formatSize(prediction.predictedBytes)}), based on the
            most recent backup's size.
          </div>
        )}
      </div>
    </div>
  )
}

export default function BackupSettings() {
  const [backups, setBackups] = useState<BackupFileInfo[]>([])
  const [stats, setStats] = useState<BackupStorageStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [busyFile, setBusyFile] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const fileInput = useRef<HTMLInputElement>(null)

  function refresh() {
    setLoading(true)
    startTransition(async () => {
      const [list, storage] = await Promise.all([listBackups(), getBackupStats()])
      setBackups(list)
      setStats(storage)
      setLoading(false)
    })
  }

  useEffect(() => {
    refresh()
  }, [])

  function handleCreate() {
    startTransition(async () => {
      try {
        await createBackupNow()
        toast.success('Backup created')
        refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    })
  }

  function handleUploadClick() {
    fileInput.current?.click()
  }

  async function handleUploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) {
      return
    }
    startTransition(async () => {
      try {
        const backup = JSON.parse(await file.text())
        await uploadBackup({ data: { filename: file.name, backup } })
        toast.success('Backup uploaded')
        refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    })
  }

  function handleDownload(filename: string) {
    window.location.href = `/api/backup/${encodeURIComponent(filename)}`
  }

  function handleRestore(filename: string) {
    if (
      !confirm(
        `Restoring "${filename}" replaces ALL existing data (settings, secrets, spaces, and the MCP audit log). This cannot be undone. Continue?`,
      )
    ) {
      return
    }
    setBusyFile(filename)
    startTransition(async () => {
      try {
        await restoreBackupNow({ data: filename })
        toast.success('Backup restored — reloading…')
        window.location.reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
        setBusyFile(null)
      }
    })
  }

  function handleDelete(filename: string) {
    if (!confirm(`Delete backup "${filename}"? This cannot be undone.`)) {
      return
    }
    setBusyFile(filename)
    startTransition(async () => {
      try {
        await deleteBackup({ data: filename })
        toast.success('Backup deleted')
        refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      } finally {
        setBusyFile(null)
      }
    })
  }

  function handleReset() {
    if (
      !confirm(
        'This permanently deletes ALL data — settings, secrets, spaces, and the MCP audit log — from every table. This cannot be undone. Consider creating a backup first. Continue?',
      )
    ) {
      return
    }
    startTransition(async () => {
      try {
        await resetDatabase()
        toast.success('Database reset — reloading…')
        window.location.reload()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err))
      }
    })
  }

  return (
    <div className='p-6 space-y-6'>
      <div className='flex items-center justify-between gap-4'>
        <div>
          <h1 className='text-2xl font-bold flex items-center gap-2'>
            Backup & Restore
            {pending && <Spinner className='size-5 text-muted-foreground' />}
          </h1>
          <p className='text-sm text-muted-foreground'>
            Snapshots of settings, secrets, spaces, and the MCP audit log.
          </p>
        </div>
        <div className='flex items-center gap-2'>
          <Button variant='outline' size='sm' onClick={refresh} disabled={pending}>
            <RefreshCw /> Refresh
          </Button>
          <Button variant='outline' size='sm' onClick={handleCreate} disabled={pending}>
            <Plus /> Create backup
          </Button>
          <Button variant='outline' size='sm' onClick={handleUploadClick} disabled={pending}>
            <Upload /> Upload
          </Button>
        </div>
      </div>

      <StorageCard stats={stats} />

      <ScheduleCard backups={backups} />

      <div className='rounded-lg border border-destructive/50 p-4 flex items-center justify-between gap-4'>
        <div>
          <div className='text-sm font-medium text-destructive'>Danger zone</div>
          <div className='text-xs text-muted-foreground'>
            Permanently wipe every table (settings, secrets, spaces, MCP audit log). Back up first.
          </div>
        </div>
        <Button variant='destructive' size='sm' onClick={handleReset} disabled={pending}>
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
                      <Button variant='ghost' size='icon' onClick={() => handleDownload(backup.filename)}>
                        <Download />
                      </Button>
                      <Button
                        variant='ghost'
                        size='icon'
                        disabled={busyFile === backup.filename}
                        onClick={() => handleRestore(backup.filename)}
                      >
                        <RotateCcw />
                      </Button>
                      <Button
                        variant='ghost'
                        size='icon'
                        disabled={busyFile === backup.filename}
                        onClick={() => handleDelete(backup.filename)}
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

      <input ref={fileInput} type='file' accept='application/json' className='hidden' onChange={handleUploadFile} />
    </div>
  )
}
