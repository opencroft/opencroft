import type { BackupScheduleConfig } from './store'

// What the stored schedule actually means, in words.
//
// Its own module, and the import above is type-only (erased at runtime), so
// this can be exercised without pulling in the store — which opens the database
// on import. A line whose whole purpose is to be trustworthy should not be
// untestable because of what sits next to it.
//
// It exists because the previous log line said the backup scheduler had
// started while the schedule was disabled and nothing was ever written. That is
// how a two-week-old manual backup passed for a working automatic one, until an
// instance needed a restore point and did not have one.
export function describeSchedule(config: BackupScheduleConfig): string {
  if (!config.enabled) {
    return 'disabled — no automatic backups will be taken'
  }
  const unit = config.intervalValue === 1 ? config.intervalUnit.replace(/s$/, '') : config.intervalUnit
  const retention =
    config.retentionDays > 0
      ? `pruning after ${config.retentionDays} days, keeping at least ${config.minRecentBackups}`
      : `never pruned, so they accumulate (keeping at least ${config.minRecentBackups})`
  return `every ${config.intervalValue} ${unit}, ${retention}`
}
