import fs from 'node:fs/promises'
import path from 'node:path'

import { db, setting } from '@opencroft/db'
import {
  type Backup,
  createBackup,
  type RestoreSummary,
  resetDatabase as resetAllTables,
  restoreBackup,
} from '@opencroft/db/backup'
import { eq } from 'drizzle-orm'

import {
  type ArchiveManifest,
  type ArchiveTrailer,
  extractBackupFiles,
  readArchiveManifest,
  readBackupArchive,
  writeBackupArchive,
} from './archive'
import { BACKUP_FILE_ROOTS } from './file-tree'

export type { ArchiveManifest, ArchiveTrailer, Backup }

/** `.zip` since format 2; `.json` is every backup taken before it. */
export type BackupFormat = 'zip' | 'json'

export interface BackupFileInfo {
  filename: string
  sizeBytes: number
  createdAt: string
  format: BackupFormat
}

function dataDir(...segments: string[]): string {
  const base = process.env.OPENCROFT_DATA_DIR || path.join(process.cwd(), 'data')
  return path.join(base, ...segments)
}

const BACKUPS_DIR = dataDir('backups')

const SAFE_FILENAME = /^[\w.-]+\.(zip|json)$/

function isSafeFilename(filename: string): boolean {
  return SAFE_FILENAME.test(filename) && !filename.includes('..')
}

function backupFilePath(filename: string): string {
  if (!isSafeFilename(filename)) {
    throw new Error('Invalid backup filename')
  }
  return path.join(BACKUPS_DIR, filename)
}

function formatOf(filename: string): BackupFormat {
  return filename.endsWith('.zip') ? 'zip' : 'json'
}

function timestampForFilename(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}

async function statInfo(filename: string): Promise<BackupFileInfo> {
  const stat = await fs.stat(path.join(BACKUPS_DIR, filename))
  return { filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString(), format: formatOf(filename) }
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
  const files = await Promise.all(
    entries.filter((name) => name.endsWith('.zip') || name.endsWith('.json')).map(statInfo),
  )
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function createBackupFile(): Promise<BackupFileInfo> {
  await fs.mkdir(BACKUPS_DIR, { recursive: true })
  const backup = await createBackup(db)
  const filename = `backup-${timestampForFilename(backup.createdAt)}.zip`
  // Written beside its final name and moved into place, so a crash or a full
  // disk mid-write leaves no half-archive for the list to offer as a restore.
  const partial = path.join(BACKUPS_DIR, `.${filename}.partial`)
  try {
    await writeBackupArchive(partial, { backup, dataDirectory: dataDir(), roots: BACKUP_FILE_ROOTS })
    await fs.rename(partial, path.join(BACKUPS_DIR, filename))
  } catch (err) {
    await fs.rm(partial, { force: true })
    throw err
  }
  return statInfo(filename)
}

function isLegacyBackup(value: unknown): value is Backup {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Backup).formatVersion === 'number' &&
    typeof (value as Backup).tables === 'object'
  )
}

/**
 * What a backup file says it holds, without applying any of it.
 *
 * A `.zip` answers from its manifest — the first member, so this does not
 * inflate the archive. A `.json` has no manifest, so the answer is derived
 * from the dump itself, which does mean reading it.
 */
export interface BackupContents {
  format: BackupFormat
  formatVersion: number
  createdAt: string
  tables: Record<string, number>
  totalRows: number
  /** Data-directory roots the file carries. Always empty for a `.json`. */
  fileRoots: string[]
}

export async function describeBackupFile(filename: string): Promise<BackupContents> {
  const file = backupFilePath(filename)
  if (formatOf(filename) === 'zip') {
    const manifest = await readArchiveManifest(file)
    return {
      format: 'zip',
      formatVersion: manifest.formatVersion,
      createdAt: manifest.createdAt,
      tables: manifest.database.tables,
      totalRows: manifest.database.totalRows,
      fileRoots: manifest.fileRoots,
    }
  }
  const backup = JSON.parse(await fs.readFile(file, 'utf8')) as Backup
  if (!isLegacyBackup(backup)) {
    throw new Error('Not a valid backup file')
  }
  const tables: Record<string, number> = {}
  let totalRows = 0
  for (const [name, rows] of Object.entries(backup.tables)) {
    tables[name] = rows.length
    totalRows += rows.length
  }
  return {
    format: 'json',
    formatVersion: backup.formatVersion,
    createdAt: backup.createdAt,
    tables,
    totalRows,
    fileRoots: [],
  }
}

export async function saveUploadedBackup(bytes: Buffer, sourceName: string): Promise<BackupFileInfo> {
  await fs.mkdir(BACKUPS_DIR, { recursive: true })
  const isZip = /\.zip$/i.test(sourceName)
  const base = sourceName.replace(/\.(zip|json)$/i, '').replace(/[^\w.-]/g, '_') || 'upload'
  const filename = `${base}-${Date.now()}.${isZip ? 'zip' : 'json'}`
  const target = path.join(BACKUPS_DIR, filename)
  const partial = `${target}.partial`
  await fs.writeFile(partial, bytes)
  try {
    // Validated before it is allowed to sit in the list looking restorable.
    if (isZip) {
      await readArchiveManifest(partial)
    } else if (!isLegacyBackup(JSON.parse(bytes.toString('utf8')))) {
      throw new Error('Not a valid backup file')
    }
  } catch (err) {
    await fs.rm(partial, { force: true })
    throw err instanceof Error ? err : new Error(String(err))
  }
  await fs.rename(partial, target)
  return statInfo(filename)
}

export async function readBackupFileBuffer(filename: string): Promise<Buffer> {
  return fs.readFile(backupFilePath(filename))
}

export interface RestoreResult extends RestoreSummary {
  /** Data-directory roots replaced from the archive. Empty for a `.json`. */
  restoredRoots: string[]
  filesWritten: number
}

/**
 * Apply a backup file: the database first, then the file roots.
 *
 * A `.zip` is READ AND VERIFIED IN FULL before any of it is applied, so a
 * damaged archive costs nothing. The database half then lands in one
 * transaction, and the file half replaces each root the archive declares.
 *
 * The two halves are not one transaction, and cannot be: the second is a
 * filesystem. The order is the one that fails better — a database restored
 * without its files is a running installation missing some App contents,
 * whereas files restored under a database that then refused them would be
 * contents belonging to instances that do not exist.
 */
export async function restoreBackupFile(filename: string): Promise<RestoreResult> {
  const file = backupFilePath(filename)
  if (formatOf(filename) === 'json') {
    const backup = JSON.parse(await fs.readFile(file, 'utf8')) as Backup
    const summary = await restoreBackup(db, backup)
    return { ...summary, restoredRoots: [], filesWritten: 0 }
  }
  const { backup, manifest, trailer } = await readBackupArchive(file)
  const summary = await restoreBackup(db, backup)
  const extracted = await extractBackupFiles(file, dataDir(), manifest, trailer)
  return { ...summary, restoredRoots: extracted.roots, filesWritten: extracted.files }
}

export async function deleteBackupFile(filename: string): Promise<void> {
  await fs.unlink(backupFilePath(filename))
}

/** Wipes every row from every table. Does not touch backup files or the data directory. */
export async function resetDatabase(): Promise<void> {
  await resetAllTables(db)
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
