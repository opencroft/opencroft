import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { getUsageRollupConfig, listRollupRowsForDay, setUsageRollupConfig } from './store'
import { collectRollupRows, dueDeliveryDay, runUsageRollupTick } from './tick'
import type { RollupRow } from './types'

function row(overrides: Partial<RollupRow> = {}): RollupRow {
  return {
    day: '2026-08-14',
    agent: 'bob',
    model: 'claude-sonnet-5',
    requests: 10,
    rawInputTokens: 20,
    cacheWriteTokens: 30,
    cacheReadTokens: 40,
    outputTokens: 50,
    coldPrimeRequests: 0,
    coldPrimeTokens: 0,
    ...overrides,
  }
}

test('dueDeliveryDay withholds delivery before the configured UTC hour', () => {
  const now = new Date('2026-08-14T09:00:00.000Z')
  assert.equal(dueDeliveryDay(now, 12, undefined), null)
})

test('dueDeliveryDay delivers once the UTC hour has passed and today was not already delivered', () => {
  const now = new Date('2026-08-14T13:00:00.000Z')
  assert.equal(dueDeliveryDay(now, 12, undefined), '2026-08-14')
})

test('dueDeliveryDay does not re-deliver the same day twice', () => {
  const now = new Date('2026-08-14T18:00:00.000Z')
  assert.equal(dueDeliveryDay(now, 12, '2026-08-14'), null)
})

test('dueDeliveryDay delivers again once a new day has started', () => {
  const now = new Date('2026-08-15T13:00:00.000Z')
  assert.equal(dueDeliveryDay(now, 12, '2026-08-14'), '2026-08-15')
})

test('collectRollupRows merges rows returned by multiple containers', async () => {
  const rows = await collectRollupRows(
    {
      containerNames: ['agent-container', 'agent-container-2'],
      execInContainer: async (containerName) =>
        JSON.stringify([row({ agent: containerName === 'agent-container' ? 'bob' : 'dave', requests: 5 })]),
    },
    '2026-08-13',
  )
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.map((r) => r.agent).sort(), ['bob', 'dave'])
})

test('collectRollupRows sums a bucket reported by more than one container', async () => {
  const rows = await collectRollupRows(
    {
      containerNames: ['a', 'b'],
      execInContainer: async () => JSON.stringify([row({ requests: 5, cacheReadTokens: 100 })]),
    },
    '2026-08-13',
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].requests, 10)
  assert.equal(rows[0].cacheReadTokens, 200)
})

test('collectRollupRows skips a container whose exec fails, keeping the rest', async () => {
  const rows = await collectRollupRows(
    {
      containerNames: ['broken', 'ok'],
      execInContainer: async (containerName) => {
        if (containerName === 'broken') {
          throw new Error('exec timed out')
        }
        return JSON.stringify([row({ agent: 'erin' })])
      },
    },
    '2026-08-13',
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].agent, 'erin')
})

test('collectRollupRows skips a container that returns unparseable output', async () => {
  const rows = await collectRollupRows(
    {
      containerNames: ['flaky'],
      execInContainer: async () => 'not json',
    },
    '2026-08-13',
  )
  assert.deepEqual(rows, [])
})

test('runUsageRollupTick persists rows and reports a pending delivery once due', async () => {
  await setUsageRollupConfig({ enabled: true, deliverAfterHour: 12, lastDeliveredDay: undefined })
  const now = new Date('2026-08-14T13:00:00.000Z')
  const result = await runUsageRollupTick({
    containerNames: ['agent-container'],
    execInContainer: async () => JSON.stringify([row({ day: '2026-08-14', requests: 42 })]),
    now,
  })
  assert.equal(result.rowsUpserted, 1)
  assert.ok(result.pendingDelivery)
  assert.equal(result.pendingDelivery?.day, '2026-08-14')
  assert.match(result.pendingDelivery?.message ?? '', /42/)

  const stored = await listRollupRowsForDay('2026-08-14')
  assert.equal(stored.length, 1)
  assert.equal(stored[0].requests, 42)
})

test('runUsageRollupTick reports no pending delivery before the configured hour', async () => {
  await setUsageRollupConfig({ enabled: true, deliverAfterHour: 12, lastDeliveredDay: undefined })
  const result = await runUsageRollupTick({
    containerNames: ['agent-container'],
    execInContainer: async () => JSON.stringify([row({ day: '2026-08-14' })]),
    now: new Date('2026-08-14T05:00:00.000Z'),
  })
  assert.equal(result.pendingDelivery, null)
})

test('runUsageRollupTick skips scanning entirely when disabled, not just the chat message', async () => {
  await setUsageRollupConfig({ enabled: false, lastDeliveredDay: undefined })
  let execCalls = 0
  const result = await runUsageRollupTick({
    containerNames: ['agent-container'],
    execInContainer: async () => {
      execCalls += 1
      return JSON.stringify([row({ day: '2026-08-14', agent: 'disabled-check' })])
    },
    now: new Date('2026-08-14T13:00:00.000Z'),
  })
  assert.equal(execCalls, 0)
  assert.equal(result.scannedContainers, 0)
  assert.equal(result.rowsUpserted, 0)
  assert.equal(result.pendingDelivery, null)
  const stored = await listRollupRowsForDay('2026-08-14')
  assert.ok(!stored.some((r) => r.agent === 'disabled-check'))
  const config = await getUsageRollupConfig()
  assert.equal(config.enabled, false)
})

test('a second tick for the same day upserts the same row instead of duplicating it', async () => {
  await setUsageRollupConfig({ enabled: true })
  const now = new Date('2026-08-14T13:00:00.000Z')
  await runUsageRollupTick({
    containerNames: ['agent-container'],
    execInContainer: async () => JSON.stringify([row({ day: '2026-08-14', agent: 'frank', requests: 1 })]),
    now,
  })
  await runUsageRollupTick({
    containerNames: ['agent-container'],
    execInContainer: async () => JSON.stringify([row({ day: '2026-08-14', agent: 'frank', requests: 7 })]),
    now,
  })
  const stored = await listRollupRowsForDay('2026-08-14')
  const frank = stored.filter((r) => r.agent === 'frank')
  assert.equal(frank.length, 1)
  assert.equal(frank[0].requests, 7)
})
