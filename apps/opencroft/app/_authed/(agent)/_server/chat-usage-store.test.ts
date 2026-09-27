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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { chatUsageCostRepair, chatUsageTurn, chatUsageTurnModel, db, migrationsFolder } from '@opencroft/db'
import { eq, sql } from 'drizzle-orm'

import {
  deleteChatUsage,
  queryChatUsage,
  queryChatUsageTurnsBySessionKey,
  recordChatUsageTurn,
  usageDay,
} from './chat-usage-store'

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

test("a session key gathers a thread's turns across its session ids, oldest first, from `since` on", async () => {
  const key = 'agent:thread-usage:chat-x:dev:usage-key-1'
  // The same thread, reopened under a new session id between turns.
  await recordChatUsageTurn({
    sessionId: 'sess-key-a',
    sessionKey: key,
    usage: { totalTokens: 300, inputTokens: 200, outputTokens: 100 },
    cost: { amount: 0.03, currency: 'USD' },
    at: new Date('2026-09-26T10:05:00.000Z'),
  })
  await recordChatUsageTurn({
    sessionId: 'sess-key-b',
    sessionKey: key,
    usage: { totalTokens: 50 },
    at: new Date('2026-09-26T10:10:00.000Z'),
  })
  await recordChatUsageTurn({
    sessionId: 'sess-key-a',
    sessionKey: key,
    usage: { totalTokens: 1_000, inputTokens: 900, outputTokens: 60, cacheReadTokens: 40 },
    cost: { amount: 0.1, currency: 'USD' },
    at: new Date('2026-09-26T10:00:00.000Z'),
  })
  // Another thread, and a keyless session: neither is this thread's.
  await recordChatUsageTurn({
    sessionId: 'sess-key-c',
    sessionKey: 'agent:thread-usage:chat-x:dev:usage-key-2',
    usage: { totalTokens: 7 },
    at: new Date('2026-09-26T10:07:00.000Z'),
  })
  await recordChatUsageTurn({
    sessionId: 'sess-key-a',
    usage: { totalTokens: 9 },
    at: new Date('2026-09-26T10:08:00.000Z'),
  })

  const all = await queryChatUsageTurnsBySessionKey(key)
  assert.deepEqual(
    all.map((turn) => [turn.endedAt.toISOString(), turn.tokens.total, turn.cost?.amount ?? null]),
    [
      ['2026-09-26T10:00:00.000Z', 1_000, 0.1],
      ['2026-09-26T10:05:00.000Z', 300, 0.03],
      ['2026-09-26T10:10:00.000Z', 50, null],
    ],
  )
  assert.deepEqual(all[0]?.tokens, { input: 900, output: 60, cacheRead: 40, cacheWrite: 0, total: 1_000 })

  // `since` is inclusive: a turn that ended at that instant counts.
  const since = await queryChatUsageTurnsBySessionKey(key, new Date('2026-09-26T10:05:00.000Z'))
  assert.deepEqual(
    since.map((turn) => turn.tokens.total),
    [300, 50],
  )
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
  // A one-day window reads by the hour, so the turn sits in its 10:00 bucket.
  assert.equal(haiku.points.find((p) => p.date === '2026-09-18T10')?.totalTokens, 40)
})

test('a short window is bucketed by the hour, a long one by the day', async () => {
  // Two turns on one day no other test records on, hours apart.
  await recordChatUsageTurn({
    sessionId: 'sess-usage-7-early',
    usage: { totalTokens: 30 },
    at: new Date('2026-08-10T03:30:00.000Z'),
  })
  await recordChatUsageTurn({
    sessionId: 'sess-usage-7-late',
    usage: { totalTokens: 50 },
    at: new Date('2026-08-10T21:05:00.000Z'),
  })

  const [hourly] = await queryChatUsage('all', { kind: 'custom', from: '2026-08-10', to: '2026-08-10' })
  assert.deepEqual(
    hourly.points.map((p) => p.date),
    Array.from({ length: 24 }, (_, h) => `2026-08-10T${String(h).padStart(2, '0')}`),
    'one bounded day is 24 hourly buckets, zero-filled, in UTC',
  )
  assert.deepEqual(
    hourly.points.filter((p) => p.totalTokens > 0).map((p) => [p.date, p.totalTokens]),
    [
      ['2026-08-10T03', 30],
      ['2026-08-10T21', 50],
    ],
    'each turn lands in the hour it ended, cut from its own timestamp',
  )

  const [daily] = await queryChatUsage('all', { kind: 'custom', from: '2026-08-08', to: '2026-08-14' })
  assert.deepEqual(
    daily.points.map((p) => p.date),
    ['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'],
    'a week is past the hourly limit, so it reads by the day',
  )
  assert.equal(daily.points[2].totalTokens, 80, 'and both turns fold into their day')
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

// The data repair for turns booked with their session's running total, run
// against rows shaped the way the bug wrote them. It runs once when the schema
// migrates, over an empty table here, so it is replayed over these rows by hand.
test('the running-total repair books each inflated turn its own increment, and leaves an unrecoverable one unpriced', async () => {
  // Every turn is 100 in / 100 out: far below a dollar of spend, so any
  // figure over the repair's bound can only be a running total.
  const usage = { totalTokens: 200, inputTokens: 100, outputTokens: 100 }
  const record = (sessionId: string, amount: number, minute: number) =>
    recordChatUsageTurn({
      sessionId,
      usage,
      cost: { amount, currency: 'USD' },
      at: new Date(`2026-09-20T10:${String(minute).padStart(2, '0')}:00.000Z`),
    })
  // Two increments, then two reopenings, each booked with the running total
  // it had reached: 0.5, then 0.75 + 0.25 = 1.
  await record('sess-repair', 0.25, 1)
  await record('sess-repair', 0.25, 2)
  await record('sess-repair', 0.75, 3)
  await record('sess-repair', 0.25, 4)
  await record('sess-repair', 1.5, 5)
  // A running total with nothing recorded before it, and one that does not
  // follow from what was (the harness restarted its count in between): the
  // turn's own share of either cannot be recovered.
  await record('sess-repair-unknown', 40, 1)
  await record('sess-repair-restarted', 0.25, 1)
  await record('sess-repair-restarted', 20, 2)

  // Statement by statement, as the migrator runs it.
  const migration = readFileSync(join(migrationsFolder, '0040_repair_resumed_turn_cost.sql'), 'utf8')
  for (const statement of migration.split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement))
  }

  const costsOf = (sessionId: string) =>
    db
      .select({ amount: chatUsageTurn.costAmount, currency: chatUsageTurn.costCurrency })
      .from(chatUsageTurn)
      .where(eq(chatUsageTurn.sessionId, sessionId))
      .orderBy(chatUsageTurn.createdAt)
  assert.deepEqual(await costsOf('sess-repair'), [
    { amount: 0.25, currency: 'USD' },
    { amount: 0.25, currency: 'USD' },
    { amount: 0.25, currency: 'USD' },
    { amount: 0.25, currency: 'USD' },
    { amount: 0.5, currency: 'USD' },
  ])
  assert.deepEqual(await costsOf('sess-repair-unknown'), [{ amount: null, currency: null }])
  assert.deepEqual(await costsOf('sess-repair-restarted'), [
    { amount: 0.25, currency: 'USD' },
    { amount: null, currency: null },
  ])
  const [tokens] = await db
    .select({ input: chatUsageTurn.inputTokens, output: chatUsageTurn.outputTokens })
    .from(chatUsageTurn)
    .where(eq(chatUsageTurn.sessionId, 'sess-repair-unknown'))
  assert.deepEqual(tokens, { input: 100, output: 100 }, 'tokens are not touched')

  // Every change, and only the changes, left its trail: what the turn held and
  // what it holds now, under the migration that did it.
  const trail = await db
    .select({
      sessionId: chatUsageTurn.sessionId,
      migration: chatUsageCostRepair.migration,
      originalAmount: chatUsageCostRepair.originalAmount,
      originalCurrency: chatUsageCostRepair.originalCurrency,
      repairedAmount: chatUsageCostRepair.repairedAmount,
      current: chatUsageTurn.costAmount,
    })
    .from(chatUsageCostRepair)
    .innerJoin(chatUsageTurn, eq(chatUsageCostRepair.turnId, chatUsageTurn.id))
    .orderBy(chatUsageTurn.sessionId, chatUsageTurn.createdAt)
  const migration0040 = '0040_repair_resumed_turn_cost'
  assert.deepEqual(trail, [
    {
      sessionId: 'sess-repair',
      migration: migration0040,
      originalAmount: 0.75,
      originalCurrency: 'USD',
      repairedAmount: 0.25,
      current: 0.25,
    },
    {
      sessionId: 'sess-repair',
      migration: migration0040,
      originalAmount: 1.5,
      originalCurrency: 'USD',
      repairedAmount: 0.5,
      current: 0.5,
    },
    {
      sessionId: 'sess-repair-restarted',
      migration: migration0040,
      originalAmount: 20,
      originalCurrency: 'USD',
      repairedAmount: null,
      current: null,
    },
    {
      sessionId: 'sess-repair-unknown',
      migration: migration0040,
      originalAmount: 40,
      originalCurrency: 'USD',
      repairedAmount: null,
      current: null,
    },
  ])
})
