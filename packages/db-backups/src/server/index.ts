import { createServerFn } from '@tanstack/react-start'

import {
  type Backup,
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
} from '../store'

export type { Backup, BackupContents, BackupFileInfo, BackupScheduleConfig, BackupStorageStats, RestoreResult }

export const listBackups = createServerFn().handler(async (): Promise<BackupFileInfo[]> => {
  return listBackupFiles()
})

export const getBackupStats = createServerFn().handler(async (): Promise<BackupStorageStats> => {
  return getBackupStorageStats()
})

export const createBackupNow = createServerFn({ method: 'POST' }).handler(async (): Promise<BackupFileInfo> => {
  const info = await createBackupFile()
  const schedule = await getBackupScheduleConfig()
  await pruneOldBackups(schedule.retentionDays, schedule.minRecentBackups)
  return info
})

/**
 * What a backup holds, read before the user is asked to confirm a restore.
 *
 * The confirmation used to name four tables from a string literal, and went on
 * naming them after the backup started carrying twenty-five and the app data
 * directory. What it says now comes out of the file being restored.
 */
export const getBackupContents = createServerFn()
  .inputValidator((filename: string) => filename)
  .handler(async ({ data: filename }): Promise<BackupContents> => {
    return describeBackupFile(filename)
  })

export const restoreBackupNow = createServerFn({ method: 'POST' })
  .inputValidator((filename: string) => filename)
  .handler(async ({ data: filename }): Promise<RestoreResult> => {
    return restoreBackupFile(filename)
  })

export const deleteBackup = createServerFn({ method: 'POST' })
  .inputValidator((filename: string) => filename)
  .handler(async ({ data: filename }): Promise<void> => {
    await deleteBackupFile(filename)
  })

export const resetDatabase = createServerFn({ method: 'POST' }).handler(async (): Promise<void> => {
  await resetDatabaseTables()
})

export const getBackupSchedule = createServerFn().handler(async (): Promise<BackupScheduleConfig> => {
  return getBackupScheduleConfig()
})

export const setBackupSchedule = createServerFn({ method: 'POST' })
  .inputValidator(
    (
      data: Pick<
        BackupScheduleConfig,
        'enabled' | 'intervalValue' | 'intervalUnit' | 'retentionDays' | 'minRecentBackups'
      >,
    ) => data,
  )
  .handler(async ({ data }): Promise<BackupScheduleConfig> => {
    return setBackupScheduleConfig(data)
  })
