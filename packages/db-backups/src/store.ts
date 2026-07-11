import fs from 'node:fs/promises'
import path from 'node:path'

import { db, setting } from '@opencroft/db'
import { type Backup, createBackup, restoreBackup } from '@opencroft/db/backup'
import { eq } from 'drizzle-orm'

export type { Backup }

export interface BackupFileInfo {
  filename: string
  sizeBytes: number
  createdAt: string
}

function dataDir(...segments: string[]): string {
  const base = process.env.OPENCROFT_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(base, ...segments)
}

const BACKUPS_DIR = dataDir('backups')

const SAFE_FILENAME = /^[\w.-]+\.json$/

function isSafeFilename(filename: string): boolean {
  return SAFE_FILENAME.test(filename)
}

function backupFilePath(filename: string): string {
  if (!isSafeFilename(filename)) {
    throw new Error('Invalid backup filename')
  }
  return path.join(BACKUPS_DIR, filename)
}

function timestampForFilename(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

async function statInfo(filename: string): Promise<BackupFileInfo> {
  const stat = await fs.stat(path.join(BACKUPS_DIR, filename))
  return { filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() }
}

export async function listBackupFiles(): Promise<BackupFileInfo[]> {
  let entries: string[]
  try {
    entries = await fs.readdir(BACKUPS_DIR)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw err
  }
  const files = await Promise.all(entries.filter((name) => name.endsWith('.json')).map(statInfo))
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function createBackupFile(): Promise<BackupFileInfo> {
  await fs.mkdir(BACKUPS_DIR, { recursive: true })
  const backup = await createBackup(db)
  const filename = `backup-${timestampForFilename(backup.createdAt)}.json`
  await fs.writeFile(path.join(BACKUPS_DIR, filename), JSON.stringify(backup, null, 2))
  return statInfo(filename)
}

function isBackup(value: unknown): value is Backup {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Backup).formatVersion === 'number' &&
    typeof (value as Backup).tables === 'object'
  )
}

export async function saveUploadedBackup(backup: unknown, sourceName: string): Promise<BackupFileInfo> {
  if (!isBackup(backup)) {
    throw new Error('Not a valid backup file')
  }
  await fs.mkdir(BACKUPS_DIR, { recursive: true })
  const base = sourceName.replace(/\.json$/i, '').replace(/[^\w.-]/g, '_') || 'upload'
  const filename = `${base}-${Date.now()}.json`
  await fs.writeFile(path.join(BACKUPS_DIR, filename), JSON.stringify(backup, null, 2))
  return statInfo(filename)
}

export async function readBackupFileBuffer(filename: string): Promise<Buffer> {
  return fs.readFile(backupFilePath(filename))
}

export async function restoreBackupFile(filename: string): Promise<void> {
  const text = await fs.readFile(backupFilePath(filename), 'utf8')
  const backup = JSON.parse(text) as Backup
  await restoreBackup(db, backup)
}

export async function deleteBackupFile(filename: string): Promise<void> {
  await fs.unlink(backupFilePath(filename))
}

/** Deletes backups older than retentionDays, always keeping the minRecentBackups most recent ones. */
export async function pruneOldBackups(retentionDays: number, minRecentBackups = 1): Promise<BackupFileInfo[]> {
  if (retentionDays <= 0) {
    return []
  }
  const files = await listBackupFiles()
  const cutoff = Date.now() - retentionDays * 86_400_000
  const toDelete = files.slice(Math.max(1, minRecentBackups)).filter((f) => new Date(f.createdAt).getTime() < cutoff)
  await Promise.all(toDelete.map((f) => deleteBackupFile(f.filename)))
  return toDelete
}

export interface BackupStorageStats {
  totalBackupBytes: number
  backupCount: number
  diskTotalBytes: number
  diskFreeBytes: number
}

export async function getBackupStorageStats(): Promise<BackupStorageStats> {
  const files = await listBackupFiles()
  const totalBackupBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0)
  await fs.mkdir(BACKUPS_DIR, { recursive: true })
  const stat = await fs.statfs(BACKUPS_DIR)
  return {
    totalBackupBytes,
    backupCount: files.length,
    diskTotalBytes: stat.blocks * stat.bsize,
    diskFreeBytes: stat.bavail * stat.bsize,
  }
}

// ── Schedule config ──────────────────────────────────────────────────────

export type BackupScheduleUnit = 'minutes' | 'hours' | 'days'

export interface BackupScheduleConfig {
  enabled: boolean
  intervalValue: number
  intervalUnit: BackupScheduleUnit
  /** Delete backups older than this many days on each run. 0 disables retention. */
  retentionDays: number
  /** Always keep at least this many of the most recent backups, regardless of age. */
  minRecentBackups: number
  lastRunAt?: number
}

const BACKUP_SCHEDULE_SETTING_ID = 'backup-schedule'

const DEFAULT_BACKUP_SCHEDULE: BackupScheduleConfig = {
  enabled: false,
  intervalValue: 6,
  intervalUnit: 'hours',
  retentionDays: 0,
  minRecentBackups: 1,
}

export async function getBackupScheduleConfig(): Promise<BackupScheduleConfig> {
  const row = await db.query.setting.findFirst({ where: eq(setting.id, BACKUP_SCHEDULE_SETTING_ID) })
  if (!row) {
    return DEFAULT_BACKUP_SCHEDULE
  }
  return { ...DEFAULT_BACKUP_SCHEDULE, ...(JSON.parse(row.data) as Partial<BackupScheduleConfig>) }
}

export async function setBackupScheduleConfig(patch: Partial<BackupScheduleConfig>): Promise<BackupScheduleConfig> {
  const current = await getBackupScheduleConfig()
  const next = { ...current, ...patch }
  await db
    .insert(setting)
    .values({ id: BACKUP_SCHEDULE_SETTING_ID, data: JSON.stringify(next) })
    .onConflictDoUpdate({
      target: setting.id,
      set: { data: JSON.stringify(next), updatedAt: new Date() },
    })
  return next
}
