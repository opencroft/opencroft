import {
  type BackupContents,
  type BackupFileInfo,
  type BackupScheduleConfig,
  type BackupStorageStats,
  createBackupFile,
  deleteBackupFile,
  describeBackupFile,
  getBackupScheduleConfig,
  getBackupStorageStats,
  listBackupFiles,
  pruneOldBackups,
  type RestoreResult,
  resetDatabase as resetDatabaseTables,
  restoreBackupFile,
  setBackupScheduleConfig,
} from '@opencroft/db-backups'
import { createServerFn } from '@tanstack/react-start'

import { adminOnly } from '@/app/_authed/(settings)/_server/admin-middleware'

export type { BackupContents, BackupFileInfo, BackupScheduleConfig, BackupStorageStats, RestoreResult }

// Backup & Restore's server functions. A backup holds the whole instance
// (every table, its secrets and the app data directory) and a restore or a
// reset replaces it, so every one of them is for an administrator only.

export const listBackups = createServerFn()
  .middleware([adminOnly])
  .handler(async (): Promise<BackupFileInfo[]> => listBackupFiles())

export const getBackupStats = createServerFn()
  .middleware([adminOnly])
  .handler(async (): Promise<BackupStorageStats> => getBackupStorageStats())

export const createBackupNow = createServerFn({ method: 'POST' })
  .middleware([adminOnly])
  .handler(async (): Promise<BackupFileInfo> => {
    const info = await createBackupFile()
    const schedule = await getBackupScheduleConfig()
    await pruneOldBackups(schedule.retentionDays, schedule.minRecentBackups)
    return info
  })

/**
 * What a backup holds, read before the user is asked to confirm a restore,
 * so the confirmation names what the file being restored carries.
 */
export const getBackupContents = createServerFn()
  .middleware([adminOnly])
  .inputValidator((filename: string) => filename)
  .handler(async ({ data: filename }): Promise<BackupContents> => describeBackupFile(filename))

export const restoreBackupNow = createServerFn({ method: 'POST' })
  .middleware([adminOnly])
  .inputValidator((filename: string) => filename)
  .handler(async ({ data: filename }): Promise<RestoreResult> => restoreBackupFile(filename))

export const deleteBackup = createServerFn({ method: 'POST' })
  .middleware([adminOnly])
  .inputValidator((filename: string) => filename)
  .handler(async ({ data: filename }): Promise<void> => {
    await deleteBackupFile(filename)
  })

export const resetDatabase = createServerFn({ method: 'POST' })
  .middleware([adminOnly])
  .handler(async (): Promise<void> => {
    await resetDatabaseTables()
  })

export const getBackupSchedule = createServerFn()
  .middleware([adminOnly])
  .handler(async (): Promise<BackupScheduleConfig> => getBackupScheduleConfig())

export const setBackupSchedule = createServerFn({ method: 'POST' })
  .middleware([adminOnly])
  .inputValidator(
    (
      data: Pick<
        BackupScheduleConfig,
        'enabled' | 'intervalValue' | 'intervalUnit' | 'retentionDays' | 'minRecentBackups'
      >,
    ) => data,
  )
  .handler(async ({ data }): Promise<BackupScheduleConfig> => setBackupScheduleConfig(data))
