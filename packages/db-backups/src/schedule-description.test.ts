// The wording of the one line most people will ever read about whether backups
// are happening. Tested because the previous line was reassuring and untrue.
import assert from 'node:assert/strict'
import test from 'node:test'

import { describeSchedule } from './schedule-description'

const base = {
  enabled: true,
  intervalValue: 6,
  intervalUnit: 'hours' as const,
  retentionDays: 30,
  minRecentBackups: 1,
}

test('a disabled schedule says nothing will be backed up', () => {
  // The failure this exists to prevent: a reader checking whether backups run
  // must not be able to come away reassured when they do not.
  const line = describeSchedule({ ...base, enabled: false })
  assert.match(line, /disabled/)
  assert.match(line, /no automatic backups will be taken/)
})

test('a disabled schedule does not describe an interval it will never honour', () => {
  // The stored interval survives being switched off, so the config still says
  // "6 hours" here. Repeating it would read as though backups were being taken
  // every 6 hours — the same lie as the line this replaced, in a new costume.
  // Asserting on the cadence phrasing rather than on the digit: any wording
  // that states a recurrence is the bug, and a stray digit elsewhere is not.
  const line = describeSchedule({ ...base, enabled: false })
  assert.doesNotMatch(line, /every\s/)
  assert.doesNotMatch(line, /\bhours?\b|\bdays?\b|\bminutes?\b/)
})

test('an enabled schedule states its interval', () => {
  assert.match(describeSchedule(base), /every 6 hours/)
})

test('an interval of one is singular', () => {
  // Only the three units the type actually permits — a case the type forbids
  // proves nothing about behaviour anyone can reach.
  assert.match(describeSchedule({ ...base, intervalValue: 1, intervalUnit: 'minutes' }), /every 1 minute,/)
  assert.match(describeSchedule({ ...base, intervalValue: 1, intervalUnit: 'hours' }), /every 1 hour,/)
  assert.match(describeSchedule({ ...base, intervalValue: 1, intervalUnit: 'days' }), /every 1 day,/)
})

test('retention is stated when it prunes', () => {
  const line = describeSchedule({ ...base, retentionDays: 30, minRecentBackups: 3 })
  assert.match(line, /pruning after 30 days/)
  assert.match(line, /keeping at least 3/)
})

test('no retention says backups accumulate, rather than staying silent', () => {
  // retentionDays: 0 is the default and means "never prune". Left unsaid, an
  // instance quietly grows a backup directory forever.
  const line = describeSchedule({ ...base, retentionDays: 0 })
  assert.match(line, /never pruned/)
  assert.match(line, /accumulate/)
})

test('the default configuration reports as disabled', () => {
  // Mirrors DEFAULT_BACKUP_SCHEDULE in store.ts: a fresh instance has no
  // schedule row and therefore takes no backups.
  const line = describeSchedule({
    enabled: false,
    intervalValue: 6,
    intervalUnit: 'hours',
    retentionDays: 0,
    minRecentBackups: 1,
  })
  assert.match(line, /disabled/)
})
