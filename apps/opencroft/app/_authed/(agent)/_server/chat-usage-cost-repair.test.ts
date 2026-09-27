// The one-off data repairs of turns booked with their session's running
// total, run against rows shaped the way that bug wrote them. The repairs live
// only in their migrations, and they write through the ChatUsageCostRepair
// trail; these tests go with that table when it is dropped, while the
// migrations stay as history.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { chatUsageCostRepair, chatUsageTurn, db, migrationsFolder } from '@opencroft/db'
import { eq, sql } from 'drizzle-orm'

import { recordChatUsageTurn } from './chat-usage-store'

/**
 * Run one repair migration again over the rows a test recorded. It ran once
 * when the schema migrated, over an empty table; statement by statement, as
 * the migrator runs it.
 */
async function replayMigration(file: string): Promise<void> {
  const migration = readFileSync(join(migrationsFolder, file), 'utf8')
  for (const statement of migration.split('--> statement-breakpoint')) {
    await db.execute(sql.raw(statement))
  }
}

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

  await replayMigration('0040_repair_resumed_turn_cost.sql')

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
    .where(eq(chatUsageCostRepair.migration, '0040_repair_resumed_turn_cost'))
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

test('the follow-up repair re-books a running total under the first bound, and only one whose remainder is the turn’s own spend', async () => {
  // Every turn here is 62,500 input tokens: $0.25 at $4 per million, so the
  // amounts below are exact in binary and the checks need no epsilon.
  const usage = { totalTokens: 62_500, inputTokens: 62_500 }
  const record = (sessionId: string, amount: number, minute: number) =>
    recordChatUsageTurn({
      sessionId,
      usage,
      cost: { amount, currency: 'USD' },
      at: new Date(`2026-09-21T10:${String(minute).padStart(2, '0')}:00.000Z`),
    })
  // Two turns, then a reopening booked with the running total it had reached
  // (0.5 + 0.25): too small for the first repair's bound.
  await record('sess-missed', 0.25, 1)
  await record('sess-missed', 0.25, 2)
  await record('sess-missed', 0.75, 3)
  await record('sess-missed', 0.25, 4)
  // A turn the first repair already changed: it held the cumulative reading
  // 0.5, now kept only as its original amount. The reading after the next turn
  // is 0.75, so a later running total of 1.0 leaves 0.25, where the turns'
  // current costs alone would leave 0.5.
  await record('sess-missed-after-repair', 0.25, 1)
  const [repaired] = await db
    .select({ id: chatUsageTurn.id })
    .from(chatUsageTurn)
    .where(eq(chatUsageTurn.sessionId, 'sess-missed-after-repair'))
  assert.ok(repaired)
  // Written as the fixed engine booted, at 10:30: the earliest trail row from
  // the first repair, which is the instant 0041 treats as that boot.
  await db.insert(chatUsageCostRepair).values({
    turnId: repaired.id,
    migration: '0040_repair_resumed_turn_cost',
    originalAmount: 0.5,
    originalCurrency: 'USD',
    repairedAmount: 0.25,
    createdAt: new Date('2026-09-21T10:30:00.000Z'),
  })
  await record('sess-missed-after-repair', 0.25, 2)
  await record('sess-missed-after-repair', 1, 3)
  // Left alone: a first turn has no reading before it, and a cost above the
  // tokens whose remainder is not the turn's own spend is not a running total.
  await record('sess-missed-first', 0.75, 1)
  await record('sess-missed-other', 0.25, 1)
  await record('sess-missed-other', 0.375, 2)
  // Left alone as well: the same shape as the first session, recorded after
  // the fixed engine booted, which prices every turn as its own.
  await record('sess-missed-post-fix', 0.25, 41)
  await record('sess-missed-post-fix', 0.25, 42)
  await record('sess-missed-post-fix', 0.75, 43)

  await replayMigration('0041_repair_missed_running_total.sql')

  const costsOf = async (sessionId: string) =>
    (
      await db
        .select({ amount: chatUsageTurn.costAmount })
        .from(chatUsageTurn)
        .where(eq(chatUsageTurn.sessionId, sessionId))
        .orderBy(chatUsageTurn.createdAt)
    ).map((row) => row.amount)
  assert.deepEqual(await costsOf('sess-missed'), [0.25, 0.25, 0.25, 0.25])
  assert.deepEqual(await costsOf('sess-missed-after-repair'), [0.25, 0.25, 0.25])
  assert.deepEqual(await costsOf('sess-missed-first'), [0.75])
  assert.deepEqual(await costsOf('sess-missed-other'), [0.25, 0.375])
  assert.deepEqual(await costsOf('sess-missed-post-fix'), [0.25, 0.25, 0.75])

  const trail = await db
    .select({
      sessionId: chatUsageTurn.sessionId,
      originalAmount: chatUsageCostRepair.originalAmount,
      originalCurrency: chatUsageCostRepair.originalCurrency,
      repairedAmount: chatUsageCostRepair.repairedAmount,
    })
    .from(chatUsageCostRepair)
    .innerJoin(chatUsageTurn, eq(chatUsageCostRepair.turnId, chatUsageTurn.id))
    .where(eq(chatUsageCostRepair.migration, '0041_repair_missed_running_total'))
    .orderBy(chatUsageTurn.sessionId)
  assert.deepEqual(trail, [
    { sessionId: 'sess-missed', originalAmount: 0.75, originalCurrency: 'USD', repairedAmount: 0.25 },
    { sessionId: 'sess-missed-after-repair', originalAmount: 1, originalCurrency: 'USD', repairedAmount: 0.25 },
  ])
})
