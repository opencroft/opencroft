'use client'

import {
  type BackupContents,
  type BackupFileInfo,
  type BackupScheduleConfig,
  type BackupStorageStats,
  createBackupNow,
  deleteBackup,
  getBackupContents,
  getBackupSchedule,
  getBackupStats,
  listBackups,
  resetDatabase,
  restoreBackupNow,
  setBackupSchedule,
} from '@opencroft/db-backups/server'
import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { BackupRestore } from 'ui/settings/backup-restore'

// The page is the kit's BackupRestore; what stays here is everything that
// touches the world: the backup server, the file picker, the confirmations
// and the toasts.

/**
 * What the confirmation says, read out of the file rather than written here.
 *
 * The literal this replaces named "settings, secrets, spaces, and the MCP
 * audit log" — the four tables a backup carried in 2026-07 — and went on
 * saying exactly that after backups started carrying twenty-five tables and
 * the app data directory. A sentence about what is at stake has to come from
 * the thing at stake.
 */
function describeRestore(filename: string, contents: BackupContents): string {
  const tableNames = Object.keys(contents.tables)
  const lines = [
    `Restore "${filename}"?`,
    '',
    `Database: ${contents.totalRows.toLocaleString()} rows across ${tableNames.length} tables, replacing what is there now.`,
  ]
  if (contents.fileRoots.length > 0) {
    lines.push(`Files: ${contents.fileRoots.join(', ')} — each replaced in full, not merged.`)
  } else {
    lines.push('Files: none. This backup carries no app storage.')
  }
  // The one consequence that is not visible in the lists above: rows pointing
  // at a table this file replaces go with it, whether or not the file carries
  // them.
  if (tableNames.includes('Space') && !tableNames.includes('SpaceGraph')) {
    lines.push('', 'This backup predates graphs being rows: restoring it DELETES every graph and App instance.')
  }
  if (contents.format === 'json') {
    lines.push('', `Old format (version ${contents.formatVersion}).`)
  }
  lines.push('', 'This cannot be undone. Continue?')
  return lines.join('\n')
}

export default function BackupSettings() {
  const [backups, setBackups] = useState<BackupFileInfo[]>([])
  const [stats, setStats] = useState<BackupStorageStats | null>(null)
  const [schedule, setSchedule] = useState<BackupScheduleConfig | null>(null)
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
    getBackupSchedule().then(setSchedule)
  }, [])

  function handleScheduleChange(next: BackupScheduleConfig) {
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
        // The bytes go up untouched: an archive is not something the browser
        // can parse into an object first, and a .json need not be either.
        const response = await fetch('/api/backup-upload', {
          method: 'POST',
          headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' },
          body: file,
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(body?.error || `Upload failed (${response.status})`)
        }
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
    setBusyFile(filename)
    startTransition(async () => {
      try {
        // Reading the file is also the first check that it IS one: a damaged
        // archive fails here, before anything has been replaced.
        const contents = await getBackupContents({ data: filename })
        if (!confirm(describeRestore(filename, contents))) {
          setBusyFile(null)
          return
        }
        const result = await restoreBackupNow({ data: filename })
        const restoredRows = Object.values(result.restored).reduce((sum, count) => sum + count, 0)
        toast.success(`Restored ${restoredRows.toLocaleString()} rows and ${result.filesWritten} files — reloading…`)
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
        'This permanently deletes every row of every table — settings, secrets, spaces and their graphs, App instances, group chats, accounts, the MCP audit log. App storage on disk is NOT touched. This cannot be undone. Consider creating a backup first. Continue?',
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
    <>
      <BackupRestore
        backups={backups}
        stats={stats}
        schedule={schedule}
        onScheduleChange={handleScheduleChange}
        loading={loading}
        pending={pending}
        busyFile={busyFile}
        onRefresh={refresh}
        onCreate={handleCreate}
        onUpload={handleUploadClick}
        onDownload={handleDownload}
        onRestore={handleRestore}
        onDelete={handleDelete}
        onReset={handleReset}
      />
      <input
        ref={fileInput}
        type='file'
        accept='.zip,.json,application/zip,application/json'
        className='hidden'
        onChange={handleUploadFile}
      />
    </>
  )
}
