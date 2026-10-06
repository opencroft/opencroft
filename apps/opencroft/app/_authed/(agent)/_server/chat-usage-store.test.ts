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

import {
  chatUsageTurn,
  chatUsageTurnModel,
  db,
  groupChat,
  groupChatSlugAlias,
  groupChatThread,
  space,
} from '@opencroft/db'
import { eq } from 'drizzle-orm'

import {
  deleteChatUsage,
  queryChatUsage,
  queryChatUsageTokensBySession,
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

/**
 * A space with its own chat (at the space's slug, where a space's chat lives)
 * and one thread in it. Returns the space's id and the thread's session key —
 * the key a recorded turn is attributed to the space through.
 */
async function seedSpaceThread(slug: string): Promise<{ spaceId: string; sessionKey: string }> {
  const [row] = await db.insert(space).values({ slug, name: slug }).returning({ id: space.id })
  const [chat] = await db.insert(groupChat).values({ slug, name: slug, topic: slug }).returning({ id: groupChat.id })
  const sessionKey = `group-chat.${slug}.agent-a.thread-1`
  await db.insert(groupChatThread).values({ groupChatId: chat.id, agentNodeId: 'agent-a', sessionKey })
  return { spaceId: row.id, sessionKey }
}

/** The `spaceId` a session's one recorded turn was written with. */
async function spaceIdOfTurn(sessionId: string): Promise<string | null> {
  const [turn] = await db.select().from(chatUsageTurn).where(eq(chatUsageTurn.sessionId, sessionId))
  assert.ok(turn, `no turn row recorded for ${sessionId}`)
  return turn.spaceId
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
  const { spaceId, sessionKey } = await seedSpaceThread('space-model-grouping')
  await recordChatUsageTurn({
    sessionId: 'sess-usage-5',
    sessionKey,
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
  const series = await queryChatUsage(spaceId, 'model', { kind: 'custom', from: '2026-09-18', to: '2026-09-18' })
  const haiku = series.find((s) => s.key === 'claude-haiku-5')
  assert.ok(haiku, 'the subagent-only model gets its own series, even though no turn ever resolved to it')
  // A one-day window reads by the hour, so the turn sits in its 10:00 bucket.
  assert.equal(haiku.points.find((p) => p.date === '2026-09-18T10')?.totalTokens, 40)
})

test('a short window is bucketed by the hour, a long one by the day', async () => {
  // Two turns on one day no other test records on, hours apart.
  const { spaceId, sessionKey } = await seedSpaceThread('space-resolution')
  await recordChatUsageTurn({
    sessionId: 'sess-usage-7-early',
    sessionKey,
    usage: { totalTokens: 30 },
    at: new Date('2026-08-10T03:30:00.000Z'),
  })
  await recordChatUsageTurn({
    sessionId: 'sess-usage-7-late',
    sessionKey,
    usage: { totalTokens: 50 },
    at: new Date('2026-08-10T21:05:00.000Z'),
  })

  const [hourly] = await queryChatUsage(spaceId, 'all', { kind: 'custom', from: '2026-08-10', to: '2026-08-10' })
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

  const [daily] = await queryChatUsage(spaceId, 'all', { kind: 'custom', from: '2026-08-08', to: '2026-08-14' })
  assert.deepEqual(
    daily.points.map((p) => p.date),
    ['2026-08-08', '2026-08-09', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14'],
    'a week is past the hourly limit, so it reads by the day',
  )
  assert.equal(daily.points[2].totalTokens, 80, 'and both turns fold into their day')
})

test("a reset removes the space's turns inside its period, their model rows with them, and nothing else", async () => {
  // Turns on days no other test here records on, so the population this
  // proves over is exactly these four: the space's own either side of the
  // window's edge, and inside the window another space's and an unattributed one.
  const { spaceId, sessionKey } = await seedSpaceThread('space-reset')
  const other = await seedSpaceThread('space-reset-other')
  await recordChatUsageTurn({
    sessionId: 'sess-usage-6-inside',
    sessionKey,
    usage: { totalTokens: 10 },
    at: new Date('2026-08-02T10:00:00.000Z'),
  })
  await recordChatUsageTurn({
    sessionId: 'sess-usage-6-outside',
    sessionKey,
    usage: { totalTokens: 20 },
    at: new Date('2026-08-05T10:00:00.000Z'),
  })
  await recordChatUsageTurn({
    sessionId: 'sess-usage-6-other-space',
    sessionKey: other.sessionKey,
    usage: { totalTokens: 30 },
    at: new Date('2026-08-02T11:00:00.000Z'),
  })
  await recordChatUsageTurn({
    sessionId: 'sess-usage-6-no-space',
    usage: { totalTokens: 40 },
    at: new Date('2026-08-02T12:00:00.000Z'),
  })
  const [inside] = await db.select().from(chatUsageTurn).where(eq(chatUsageTurn.sessionId, 'sess-usage-6-inside'))
  assert.ok(inside)

  const removed = await deleteChatUsage(spaceId, { kind: 'custom', from: '2026-08-01', to: '2026-08-03' })

  assert.equal(removed, 1, "exactly the space's turn inside the window is counted")
  assert.equal((await modelRowsOf('sess-usage-6-other-space')).length, 1, "another space's turn stays")
  assert.equal((await modelRowsOf('sess-usage-6-no-space')).length, 1, 'an unattributed turn stays')
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
  const { spaceId } = await seedSpaceThread('space-reset-half-picked')
  await assert.rejects(deleteChatUsage(spaceId, { kind: 'custom', from: '2026-08-01' }))
  await assert.rejects(deleteChatUsage(spaceId, { kind: 'custom' }))
})

test('a turn is recorded in the space its thread belongs to, and a session with no thread in none', async () => {
  const { spaceId, sessionKey } = await seedSpaceThread('space-attribution')
  await recordChatUsageTurn({ sessionId: 'sess-space-thread', sessionKey, usage: { totalTokens: 1 } })
  await recordChatUsageTurn({
    sessionId: 'sess-space-unknown-key',
    sessionKey: 'group-chat.no-such-chat.agent-a.thread-1',
    usage: { totalTokens: 1 },
  })
  await recordChatUsageTurn({ sessionId: 'sess-space-no-key', usage: { totalTokens: 1 } })

  assert.equal(await spaceIdOfTurn('sess-space-thread'), spaceId)
  assert.equal(await spaceIdOfTurn('sess-space-unknown-key'), null)
  assert.equal(await spaceIdOfTurn('sess-space-no-key'), null)
})

test("a turn recorded after the space's chat was renamed away from the space's slug still lands in the space", async () => {
  const { spaceId, sessionKey } = await seedSpaceThread('space-chat-rename')
  // What a chat rename leaves behind: the chat at its new slug, the old slug as
  // the chat's alias, and the thread's key moved onto the new slug.
  const [thread] = await db.select().from(groupChatThread).where(eq(groupChatThread.sessionKey, sessionKey))
  const renamedKey = 'group-chat.space-chat-rename-team.agent-a.thread-1'
  await db.update(groupChat).set({ slug: 'space-chat-rename-team' }).where(eq(groupChat.id, thread.groupChatId))
  await db.insert(groupChatSlugAlias).values({ slug: 'space-chat-rename', groupChatId: thread.groupChatId })
  await db.update(groupChatThread).set({ sessionKey: renamedKey }).where(eq(groupChatThread.id, thread.id))

  await recordChatUsageTurn({ sessionId: 'sess-space-chat-rename', sessionKey: renamedKey, usage: { totalTokens: 1 } })

  assert.equal(await spaceIdOfTurn('sess-space-chat-rename'), spaceId)
})

test('the space is fixed when the turn is recorded: deleting its thread later leaves it in place', async () => {
  const { spaceId, sessionKey } = await seedSpaceThread('space-fixed')
  await recordChatUsageTurn({
    sessionId: 'sess-space-fixed',
    sessionKey,
    usage: { totalTokens: 70 },
    at: new Date('2026-07-20T10:00:00.000Z'),
  })
  await db.delete(groupChatThread).where(eq(groupChatThread.sessionKey, sessionKey))

  assert.equal(await spaceIdOfTurn('sess-space-fixed'), spaceId)
  const [all] = await queryChatUsage(spaceId, 'all', { kind: 'custom', from: '2026-07-20', to: '2026-07-20' })
  assert.equal(all.points.find((p) => p.date === '2026-07-20T10')?.totalTokens, 70)
})

test("a space's usage reads only its own turns, whatever the grouping", async () => {
  // One day no other test records on: a turn in each of two spaces and one
  // in none, so each space's total is exactly its own turn.
  const first = await seedSpaceThread('space-read-first')
  const second = await seedSpaceThread('space-read-second')
  const at = new Date('2026-07-10T10:00:00.000Z')
  await recordChatUsageTurn({
    sessionId: 'sess-read-first',
    sessionKey: first.sessionKey,
    usage: { totalTokens: 100 },
    at,
  })
  await recordChatUsageTurn({
    sessionId: 'sess-read-second',
    sessionKey: second.sessionKey,
    model: 'model-b',
    usage: { totalTokens: 7 },
    cost: { amount: 0.5, currency: 'USD' },
    at,
  })
  await recordChatUsageTurn({ sessionId: 'sess-read-none', usage: { totalTokens: 1_000 }, at })

  const period = { kind: 'custom', from: '2026-07-10', to: '2026-07-10' } as const
  const totalOf = (series: { points: { totalTokens: number }[] }[]) =>
    series.flatMap((s) => s.points).reduce((sum, p) => sum + p.totalTokens, 0)

  assert.equal(totalOf(await queryChatUsage(first.spaceId, 'all', period)), 100)
  assert.equal(totalOf(await queryChatUsage(second.spaceId, 'all', period)), 7)
  const byAgent = await queryChatUsage(second.spaceId, 'agent', period)
  assert.deepEqual(
    byAgent.map((s) => s.key),
    ['agent-a'],
  )
  const byModel = await queryChatUsage(second.spaceId, 'model', period)
  assert.deepEqual(
    byModel.map((s) => [s.key, totalOf([s]), s.points.find((p) => p.cost !== undefined)?.cost]),
    [['model-b', 7, 0.5]],
  )
  assert.equal(
    (await queryChatUsage(first.spaceId, 'model', period)).flatMap((s) => s.points).some((p) => p.cost !== undefined),
    false,
    "the other space's cost is not in this one",
  )
})

test("a turn's tokens and a session's account include what its subagents spent", async () => {
  const key = 'agent:thread-usage:chat-x:dev:usage-key-subagents'
  // The turn's own usage is the main loop; its breakdown adds a subagent.
  await recordChatUsageTurn({
    sessionId: 'sess-subagents',
    sessionKey: key,
    model: 'claude-opus-5-5',
    usage: { totalTokens: 100, inputTokens: 100 },
    quota: {
      tokenCount: { totalTokens: 100, inputTokens: 100 },
      modelUsage: [
        { model: 'claude-opus-5-5', tokenCount: { totalTokens: 100, inputTokens: 100 } },
        { model: 'claude-haiku-4-5', tokenCount: { totalTokens: 50, outputTokens: 30, cacheReadTokens: 20 } },
      ],
    },
    at: new Date('2026-09-26T11:00:00.000Z'),
  })
  // No breakdown: the turn's own usage is all there is.
  await recordChatUsageTurn({
    sessionId: 'sess-subagents',
    sessionKey: key,
    usage: { totalTokens: 10, inputTokens: 10 },
    at: new Date('2026-09-26T11:05:00.000Z'),
  })

  assert.deepEqual(
    (await queryChatUsageTurnsBySessionKey(key)).map((turn) => turn.tokens),
    [
      { input: 100, output: 30, cacheRead: 20, cacheWrite: 0, total: 150 },
      { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, total: 10 },
    ],
  )
  assert.deepEqual(await queryChatUsageTokensBySession('sess-subagents'), {
    total: 160,
    input: 110,
    output: 30,
    cacheRead: 20,
    cacheWrite: 0,
  })
  assert.equal(await queryChatUsageTokensBySession('sess-subagents-none'), undefined, 'no turn, no account')
})
