import assert from 'node:assert/strict'
import test from 'node:test'

import { computeDueRuleIds, computeNextRunAt, type ScheduleRule } from './event-scheduler'

function rule(overrides: Partial<ScheduleRule> = {}): ScheduleRule {
  return { id: 'r1', enabled: true, mode: 'cron', cron: '*/30 * * * *', ...overrides }
}

// Window (windowStart, now] — a rule is due when its cron's next occurrence
// strictly after windowStart has already passed by now.

test('computeDueRuleIds fires a rule whose slot falls inside the window', () => {
  const windowStart = new Date('2026-07-23T04:00:00.000Z').getTime()
  const now = new Date('2026-07-23T04:00:10.000Z').getTime()
  const due = computeDueRuleIds([rule({ cron: '*/30 * * * *' })], windowStart, now)
  // wait, */30 * * * * has no slot in (04:00:00, 04:00:10] — this rule should NOT be due
  assert.deepEqual(due, [])
})

test('computeDueRuleIds fires a rule exactly at the window boundary', () => {
  const windowStart = new Date('2026-07-23T03:59:50.000Z').getTime()
  const now = new Date('2026-07-23T04:00:00.000Z').getTime()
  // */30 * * * * fires at :00 and :30 — 04:00:00 is inside (03:59:50, 04:00:00]
  const due = computeDueRuleIds([rule({ cron: '*/30 * * * *' })], windowStart, now)
  assert.deepEqual(due, ['r1'])
})

test('computeDueRuleIds ignores a disabled rule even if its slot is due', () => {
  const windowStart = new Date('2026-07-23T03:59:50.000Z').getTime()
  const now = new Date('2026-07-23T04:00:00.000Z').getTime()
  const due = computeDueRuleIds([rule({ enabled: false, cron: '*/30 * * * *' })], windowStart, now)
  assert.deepEqual(due, [])
})

test('computeDueRuleIds treats an invalid cron expression as never due, not a crash', () => {
  const windowStart = Date.now() - 120_000
  const now = Date.now()
  const due = computeDueRuleIds([rule({ cron: 'not a cron' })], windowStart, now)
  assert.deepEqual(due, [])
})

test('computeDueRuleIds returns every rule due in the same window', () => {
  const windowStart = new Date('2026-07-23T03:59:50.000Z').getTime()
  const now = new Date('2026-07-23T04:00:00.000Z').getTime()
  const due = computeDueRuleIds(
    [rule({ id: 'a', cron: '*/30 * * * *' }), rule({ id: 'b', cron: '0 * * * *' }), rule({ id: 'c', cron: '15 * * * *' })],
    windowStart,
    now,
  )
  assert.deepEqual(due.sort(), ['a', 'b'])
})

// ── computeNextRunAt ─────────────────────────────────────────────────────

test('computeNextRunAt returns the next occurrence strictly after now', () => {
  const now = new Date('2026-07-23T04:03:00.000Z').getTime()
  const next = computeNextRunAt('*/30 * * * *', now)
  assert.equal(next, new Date('2026-07-23T04:30:00.000Z').getTime())
})

test('computeNextRunAt returns undefined for an invalid expression, not a crash', () => {
  assert.equal(computeNextRunAt('not a cron', Date.now()), undefined)
})
