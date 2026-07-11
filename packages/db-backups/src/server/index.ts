import { createServerFn } from '@tanstack/react-start'

import {
  type Backup,
  type BackupFileInfo,
  type BackupScheduleConfig,
  type BackupStorageStats,
  createBackupFile,
  deleteBackupFile,
  getBackupScheduleConfig,
  getBackupStorageStats,
  listBackupFiles,
  pruneOldBackups,
  restoreBackupFile,
  saveUploadedBackup,
  setBackupScheduleConfig,
} from '../store'

export type { Backup, BackupFileInfo, BackupScheduleConfig, BackupStorageStats }

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

export const restoreBackupNow = createServerFn({ method: 'POST' })
  .inputValidator((filename: string) => filename)
  .handler(async ({ data: filename }): Promise<void> => {
    await restoreBackupFile(filename)
  })

export const deleteBackup = createServerFn({ method: 'POST' })
  .inputValidator((filename: string) => filename)
  .handler(async ({ data: filename }): Promise<void> => {
    await deleteBackupFile(filename)
  })

export const uploadBackup = createServerFn({ method: 'POST' })
  .inputValidator((data: { filename: string; backup: unknown }) => data)
  .handler(async ({ data }): Promise<BackupFileInfo> => {
    return saveUploadedBackup(data.backup, data.filename)
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
