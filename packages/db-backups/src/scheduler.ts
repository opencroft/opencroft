import { describeSchedule } from './schedule-description'
import {
  type BackupScheduleConfig,
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
  // The last schedule description reported, so a change is logged once rather
  // than every minute. Read per tick rather than once at startup because the
  // schedule can be switched on while the app runs, and a boot-time reading
  // would then be permanently stale — the same class of untrue-but-reassuring
  // statement this replaces.
  described?: string
}

const g = globalThis as Record<string, unknown>
if (!g.__DB_BACKUP_STATE__) {
  g.__DB_BACKUP_STATE__ = { inFlight: false } satisfies SchedulerState
}
const state = g.__DB_BACKUP_STATE__ as SchedulerState

function reportSchedule(config: BackupScheduleConfig): void {
  const described = describeSchedule(config)
  if (described === state.described) {
    return
  }
  state.described = described
  const line = `[db-backup-scheduler] schedule ${described}`
  // Disabled is warned rather than logged: it is the state in which this
  // subsystem silently does nothing, and it should not read like healthy
  // startup noise.
  if (config.enabled) {
    console.log(line)
  } else {
    console.warn(line)
  }
}

async function tick(): Promise<void> {
  if (state.inFlight) {
    return
  }
  const config = await getBackupScheduleConfig()
  reportSchedule(config)
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
  // Says only what is true at this point: a timer exists. Whether anything will
  // actually be backed up depends on the stored schedule, which is not read
  // here — the first tick reports that, and reports it again if it changes.
  console.log(`[db-backup-scheduler] polling every ${TICK_MS}ms`)
}
