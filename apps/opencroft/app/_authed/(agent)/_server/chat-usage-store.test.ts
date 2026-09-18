// ChatUsageTurn / ChatUsageTurnModel writes, against a real database.
//
// What only a database can get wrong is the round trip: that a recorded turn
// reads back with the counters it was given, that the optional halves (model,
// cost) degrade to their null spelling rather than blocking the write, that
// the day bucket is UTC — the same day key UsageRollupDay groups by, so the
// two tables answer with one vocabulary — and that the per-model table always
// ends up with at least one row, whether or not the harness reported a
// breakdown.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { chatUsageTurn, chatUsageTurnModel, db } from '@opencroft/db'
import { eq } from 'drizzle-orm'

import { deleteChatUsage, queryChatUsage, recordChatUsageTurn, usageDay } from './chat-usage-store'

/** The model rows a session's one recorded turn produced, reached the way a read does — through the turn. */
async function modelRowsOf(sessionId: string) {
  const [turn] = await db.select().from(chatUsageTurn).where(eq(chatUsageTurn.sessionId, sessionId))
  assert.ok(turn, `no turn row recorded for ${sessionId}`)
  return db.select().from(chatUsageTurnModel).where(eq(chatUsageTurnModel.turnId, turn.id))
}

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

test('with no reported breakdown, the turn synthesizes its own usage as its one model row', async () => {
  await recordChatUsageTurn({
    sessionId: 'sess-usage-3',
    adapterId: 'claude-subscription',
    model: 'claude-sonnet-5',
    usage: { totalTokens: 900, inputTokens: 700, outputTokens: 200 },
    at: new Date('2026-09-16T10:00:00.000Z'),
  })
  const modelRows = await modelRowsOf('sess-usage-3')
  assert.equal(modelRows.length, 1, 'no breakdown still means exactly one model row, never zero')
  assert.equal(modelRows[0].model, 'claude-sonnet-5')
  assert.equal(modelRows[0].totalTokens, 900)
  assert.equal(modelRows[0].inputTokens, 700)
})

test("a harness's per-model breakdown becomes one ChatUsageTurnModel row per model", async () => {
  await recordChatUsageTurn({
    sessionId: 'sess-usage-4',
    adapterId: 'claude-subscription',
    model: 'claude-sonnet-5',
    usage: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
    at: new Date('2026-09-16T10:00:00.000Z'),
    // The breakdown totals more than the turn row does -- subagents and
    // internal calls, which is the point of the table, not a discrepancy to
    // reconcile (see the ChatUsageTurnModel schema comment).
    quota: {
      tokenCount: { totalTokens: 100, inputTokens: 80, outputTokens: 20 },
      modelUsage: [
        { model: 'claude-sonnet-5', tokenCount: { totalTokens: 100, inputTokens: 80, outputTokens: 20 } },
        { model: 'claude-haiku-5', tokenCount: { totalTokens: 50, inputTokens: 40, outputTokens: 10 } },
      ],
    },
  })
  const modelRows = await modelRowsOf('sess-usage-4')
  assert.equal(modelRows.length, 2)
  const byModel = new Map(modelRows.map((row) => [row.model, row] as const))
  assert.equal(byModel.get('claude-sonnet-5')?.totalTokens, 100)
  assert.equal(byModel.get('claude-haiku-5')?.totalTokens, 50)
})

test('model grouping sums the breakdown, so a subagent model the turn row never named still shows up', async () => {
  await recordChatUsageTurn({
    sessionId: 'sess-usage-5',
    adapterId: 'claude-subscription',
    model: 'claude-sonnet-5',
    usage: { totalTokens: 100 },
    at: new Date('2026-09-18T10:00:00.000Z'),
    quota: {
      tokenCount: { totalTokens: 100 },
      modelUsage: [
        { model: 'claude-sonnet-5', tokenCount: { totalTokens: 100 } },
        { model: 'claude-haiku-5', tokenCount: { totalTokens: 40 } },
      ],
    },
  })
  const series = await queryChatUsage('model', { kind: 'custom', from: '2026-09-18', to: '2026-09-18' })
  const haiku = series.find((s) => s.key === 'claude-haiku-5')
  assert.ok(haiku, 'the subagent-only model gets its own series, even though no turn ever resolved to it')
  assert.equal(haiku.points[0].totalTokens, 40)
})

test('a reset removes the turns inside its period, their model rows with them, and nothing outside it', async () => {
  // Two turns either side of the window's edge, on days no other test here
  // records on, so the population this proves over is exactly these two.
  await recordChatUsageTurn({
    sessionId: 'sess-usage-6-inside',
    usage: { totalTokens: 10 },
    at: new Date('2026-08-02T10:00:00.000Z'),
  })
  await recordChatUsageTurn({
    sessionId: 'sess-usage-6-outside',
    usage: { totalTokens: 20 },
    at: new Date('2026-08-05T10:00:00.000Z'),
  })
  const [inside] = await db.select().from(chatUsageTurn).where(eq(chatUsageTurn.sessionId, 'sess-usage-6-inside'))
  assert.ok(inside)

  const removed = await deleteChatUsage({ kind: 'custom', from: '2026-08-01', to: '2026-08-03' })

  assert.equal(removed, 1, 'exactly the turn inside the window is counted')
  assert.equal(
    (await db.select().from(chatUsageTurn).where(eq(chatUsageTurn.sessionId, 'sess-usage-6-inside'))).length,
    0,
    'the turn inside the window is gone',
  )
  assert.equal(
    (await db.select().from(chatUsageTurnModel).where(eq(chatUsageTurnModel.turnId, inside.id))).length,
    0,
    'its model rows went with it — a model-grouped read has nothing orphaned to sum',
  )
  assert.equal((await modelRowsOf('sess-usage-6-outside')).length, 1, 'the turn past the edge, and its model row, stay')
})

test('a reset refuses a half-picked custom period rather than deleting to the edge of time', async () => {
  await assert.rejects(deleteChatUsage({ kind: 'custom', from: '2026-08-01' }))
  await assert.rejects(deleteChatUsage({ kind: 'custom' }))
})
