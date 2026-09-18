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
import { useEffect, useRef, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { BackupRestore } from 'ui/settings/backup-restore'

// The page is the kit's BackupRestore; what stays here is everything that
// touches the world: the backup server, the file picker, the confirmations
// and the toasts.

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
      <input ref={fileInput} type='file' accept='application/json' className='hidden' onChange={handleUploadFile} />
    </>
  )
}
