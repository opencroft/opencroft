// ChatUsageTurn writes, against a real database.
//
// What only a database can get wrong is the round trip: that a recorded turn
// reads back with the counters it was given, that the optional halves (model,
// cost) degrade to their null spelling rather than blocking the write, and
// that the day bucket is UTC — the same day key UsageRollupDay groups by,
// so the two tables answer with one vocabulary.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { chatUsageTurn, db } from '@opencroft/db'
import { eq } from 'drizzle-orm'

import { recordChatUsageTurn, usageDay } from './chat-usage-store'

test('usageDay buckets by UTC calendar date', () => {
  assert.equal(usageDay(new Date('2026-09-16T00:00:30.000Z')), '2026-09-16')
  assert.equal(usageDay(new Date('2026-09-16T23:59:59.000Z')), '2026-09-16')
  // 23:59:59Z is 2026-09-17 in any positive-offset zone; the bucket must
  // not follow the server's local clock.
  assert.equal(usageDay(new Date('2026-09-17T00:00:00.000Z')), '2026-09-17')
})

test('a recorded turn reads back with its counters, model and cost', async () => {
  await recordChatUsageTurn({
    sessionId: 'sess-usage-1',
    adapterId: 'claude-subscription',
    model: 'claude-sonnet-5',
    usage: { totalTokens: 105_000, inputTokens: 4_000, outputTokens: 1_000, cacheReadTokens: 100_000 },
    cost: { amount: 0.42, currency: 'USD' },
    at: new Date('2026-09-16T10:00:00.000Z'),
  })
  const [row] = await db.select().from(chatUsageTurn).where(eq(chatUsageTurn.sessionId, 'sess-usage-1'))
  assert.ok(row)
  assert.equal(row.day, '2026-09-16')
  assert.equal(row.adapterId, 'claude-subscription')
  assert.equal(row.model, 'claude-sonnet-5')
  assert.equal(row.totalTokens, 105_000)
  assert.equal(row.cacheReadTokens, 100_000)
  assert.equal(row.costAmount, 0.42)
  assert.equal(row.costCurrency, 'USD')
})

test('a harness that reports only the total still records a row', async () => {
  await recordChatUsageTurn({
    sessionId: 'sess-usage-2',
    usage: { totalTokens: 500 },
    at: new Date('2026-09-16T10:00:00.000Z'),
  })
  const [row] = await db.select().from(chatUsageTurn).where(eq(chatUsageTurn.sessionId, 'sess-usage-2'))
  assert.ok(row)
  assert.equal(row.totalTokens, 500)
  assert.equal(row.model, null)
  assert.equal(row.costAmount, null)
  assert.equal(row.inputTokens, 0, 'an unreported counter stores as zero, never as an invented measurement')
})
