import {
  type BackupScheduleUnit,
  createBackupFile,
  getBackupScheduleConfig,
  pruneOldBackups,
  setBackupScheduleConfig,
} from './store'

const TICK_MS = 60_000

const UNIT_MS: Record<BackupScheduleUnit, number> = {
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
}

interface SchedulerState {
  inFlight: boolean
}

const g = globalThis as Record<string, unknown>
if (!g.__DB_BACKUP_STATE__) {
  g.__DB_BACKUP_STATE__ = { inFlight: false } satisfies SchedulerState
}
const state = g.__DB_BACKUP_STATE__ as SchedulerState

async function tick(): Promise<void> {
  if (state.inFlight) {
    return
  }
  const config = await getBackupScheduleConfig()
  if (!config.enabled) {
    return
  }
  const intervalMs = Math.max(1, config.intervalValue) * UNIT_MS[config.intervalUnit]
  const now = Date.now()
  if (config.lastRunAt && now - config.lastRunAt < intervalMs) {
    return
  }
  state.inFlight = true
  try {
    await createBackupFile()
    await pruneOldBackups(config.retentionDays, config.minRecentBackups)
    await setBackupScheduleConfig({ lastRunAt: Date.now() })
  } catch (err) {
    console.error('[db-backup-scheduler] backup failed', err)
  } finally {
    state.inFlight = false
  }
}

interface SchedulerHandle {
  timer: NodeJS.Timeout
}

const globalForScheduler = globalThis as unknown as { __DB_BACKUP_SCHEDULER__?: SchedulerHandle }

export function startDbBackupScheduler(): void {
  if (globalForScheduler.__DB_BACKUP_SCHEDULER__) {
    return
  }
  const timer = setInterval(() => {
    tick().catch((err) => {
      console.error('[db-backup-scheduler] tick failed', err)
    })
  }, TICK_MS)
  globalForScheduler.__DB_BACKUP_SCHEDULER__ = { timer }
  console.log(`[db-backup-scheduler] started (tick every ${TICK_MS}ms)`)
}
