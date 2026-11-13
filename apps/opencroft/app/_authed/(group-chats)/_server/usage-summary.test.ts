// Spend summaries as extensions read them, on a throwaway database: which
// threads' turns a reader may sum, the period bounds, the groupings, and how
// cost is carried when turns are unpriced or priced in different currencies.
// Turns are written through the usage store's own recorder, so the space and
// token columns are the ones a real turn end produces.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, groupChat, groupChatMember, groupChatThread, space, user } from '@opencroft/db'
import type { SessionCost } from 'agent-client/types'
import { eq } from 'drizzle-orm'

import { recordChatUsageTurn } from '@/app/_authed/(agent)/_server/chat-usage-store'
import { createHost, usageForCaller } from '@/app/_authed/(extension-runtime)/_server/host'
import { senderThreadsByIds } from '@/app/_authed/(group-chats)/_server/model'
import { moveThreadBetweenLists } from '@/app/_authed/(group-chats)/_server/thread-archive'
import { usageSummary } from './usage-summary'

const EXTENSION = 'acme.usage-summary'
const SYSTEM_ID = 'system.ext.acme.usage-summary'
// Builds the host once, which is what registers the extension's system identity.
const host = createHost(EXTENSION)

const SINCE = '2026-03-01T00:00:00.000Z'

async function makeChat(label: string, slug?: string): Promise<{ id: string; slug: string }> {
  const id = crypto.randomUUID()
  const [chat] = await db
    .insert(groupChat)
    .values({ slug: slug ?? `${label}-${id}`, name: `${label} ${id}`, topic: label })
    .returning()
  assert.ok(chat)
  return { id: chat.id, slug: chat.slug }
}

async function makePerson(): Promise<string> {
  const id = `person-${crypto.randomUUID()}`
  await db.insert(user).values({ id, name: id, email: `${id}@example.test` })
  return id
}

async function letIn(chatId: string, member: { userId: string } | { systemId: string }): Promise<void> {
  await db
    .insert(groupChatMember)
    .values(
      'userId' in member
        ? { groupChatId: chatId, principalType: 'user', userId: member.userId }
        : { groupChatId: chatId, principalType: 'system', systemId: member.systemId },
    )
}

async function makeThread(
  chatId: string,
  agentNodeId = 'agent-alice',
): Promise<{ id: string; sessionKey: string; ref: string }> {
  const sessionKey = `group-chat.usage-${crypto.randomUUID()}`
  const [thread] = await db
    .insert(groupChatThread)
    .values({ groupChatId: chatId, agentNodeId, sessionKey, title: 'spend' })
    .returning()
  assert.ok(thread)
  // The `ref` every thread row of the API carries, which the `thread` grouping keys on.
  const [row] = await senderThreadsByIds([thread.id])
  assert.ok(row)
  return { id: thread.id, sessionKey, ref: row.thread.ref }
}

/** One finished turn of the thread's session, recorded as a turn end records it. */
async function spend(sessionKey: string, at: string, total: number, cost?: SessionCost): Promise<void> {
  await recordChatUsageTurn({
    sessionId: `session-${crypto.randomUUID()}`,
    sessionKey,
    at: new Date(at),
    usage: {
      totalTokens: total,
      inputTokens: total - 3,
      outputTokens: 1,
      cacheReadTokens: 1,
      cacheWriteTokens: 1,
    },
    cost,
  })
}

const personReader = (userId: string) => ({ kind: 'user', userId }) as const
const totals = (rows: readonly { key: string; tokens: { total: number } }[]) =>
  rows.map((row) => [row.key, row.tokens.total])

// ── who reads what ──────────────────────────────────────────────────────

test("a person's summary of their chat adds up that chat's turns in the period, and another chat refuses", async () => {
  const mine = await makeChat('mine')
  const theirs = await makeChat('theirs')
  const person = await makePerson()
  await letIn(mine.id, { userId: person })
  await letIn(theirs.id, { userId: await makePerson() })
  const first = await makeThread(mine.id)
  const second = await makeThread(mine.id)
  const outside = await makeThread(theirs.id)
  await spend(first.sessionKey, '2026-02-28T23:59:59.999Z', 1000)
  await spend(first.sessionKey, '2026-03-01T00:00:00.000Z', 10)
  await spend(first.sessionKey, '2026-03-02T12:00:00.000Z', 20)
  await spend(second.sessionKey, '2026-03-03T00:00:00.000Z', 40)
  await spend(second.sessionKey, '2026-03-04T00:00:00.000Z', 5000)
  await spend(outside.sessionKey, '2026-03-02T00:00:00.000Z', 7)

  const rows = await usageSummary(personReader(person), {
    scope: { chat: mine.slug },
    since: SINCE,
    until: '2026-03-04T00:00:00.000Z',
    groupBy: 'thread',
  })
  assert.deepEqual(totals(rows), [
    [second.ref, 40],
    [first.ref, 30],
  ])
  assert.deepEqual(rows[1], {
    key: first.ref,
    tokens: { input: 24, output: 2, cacheRead: 2, cacheWrite: 2, total: 30 },
    cost: null,
    pricedTurns: 0,
    turns: 2,
  })

  await assert.rejects(
    () => usageSummary(personReader(person), { scope: { chat: theirs.slug }, since: SINCE, groupBy: 'chat' }),
    /Not available/,
  )
})

test("under the extension's own identity only the granted chats' threads count, whatever the scope", async () => {
  const granted = await makeChat('granted')
  const other = await makeChat('not-granted')
  await letIn(granted.id, { systemId: SYSTEM_ID })
  await letIn(other.id, { userId: await makePerson() })
  const agent = `agent-${crypto.randomUUID()}`
  const seen = await makeThread(granted.id, agent)
  const unseen = await makeThread(other.id, agent)
  await spend(seen.sessionKey, '2026-03-02T00:00:00.000Z', 11)
  await spend(unseen.sessionKey, '2026-03-02T00:00:00.000Z', 900)

  assert.deepEqual(totals(await host.usage.summary({ scope: { agent }, since: SINCE, groupBy: 'chat' })), [
    [granted.id, 11],
  ])
  await assert.rejects(
    () => host.usage.summary({ scope: { chat: other.id }, since: SINCE, groupBy: 'chat' }),
    /Not available/,
  )
  await assert.rejects(
    () => host.usage.summary({ scope: { chat: 'no-such-chat' }, since: SINCE, groupBy: 'chat' }),
    /Not available/,
  )
})

test('an action reads as its calling person, and refuses once the call has ended', async () => {
  const mine = await makeChat('called')
  const granted = await makeChat('called-granted')
  const person = await makePerson()
  await letIn(mine.id, { userId: person })
  await letIn(granted.id, { systemId: SYSTEM_ID })
  const agent = `agent-${crypto.randomUUID()}`
  await spend((await makeThread(mine.id, agent)).sessionKey, '2026-03-02T00:00:00.000Z', 3)
  await spend((await makeThread(granted.id, agent)).sessionKey, '2026-03-02T00:00:00.000Z', 4)

  const called = usageForCaller(EXTENSION, { person: { id: person, name: person, avatarUrl: null } })
  assert.deepEqual(totals(await called.api.summary({ scope: { agent }, since: SINCE, groupBy: 'chat' })), [
    [mine.id, 3],
  ])
  called.end()
  await assert.rejects(
    () => called.api.summary({ scope: { agent }, since: SINCE, groupBy: 'chat' }),
    /action call that has ended/,
  )

  const nobody = usageForCaller(EXTENSION, undefined)
  assert.deepEqual(totals(await nobody.api.summary({ scope: { agent }, since: SINCE, groupBy: 'chat' })), [
    [granted.id, 4],
  ])
})

test('an agent reads the chats it is a member of', async () => {
  const agentNodeId = `agent-${crypto.randomUUID()}`
  const member = await makeChat('agent-member')
  const elsewhere = await makeChat('agent-elsewhere')
  await db.insert(groupChatMember).values({ groupChatId: member.id, principalType: 'agent', agentNodeId })
  await spend((await makeThread(member.id, agentNodeId)).sessionKey, '2026-03-02T00:00:00.000Z', 6)
  await spend((await makeThread(elsewhere.id, agentNodeId)).sessionKey, '2026-03-02T00:00:00.000Z', 60)

  const rows = await usageSummary(
    { kind: 'agent', agentNodeId },
    { scope: { agent: agentNodeId }, since: SINCE, groupBy: 'agent' },
  )
  assert.deepEqual(totals(rows), [[agentNodeId, 6]])
})

// ── what counts ─────────────────────────────────────────────────────────

test("an archived thread's spend counts, and a deleted thread's does not", async () => {
  const chat = await makeChat('lifecycle')
  const person = await makePerson()
  await letIn(chat.id, { userId: person })
  const archived = await makeThread(chat.id)
  const deleted = await makeThread(chat.id)
  await spend(archived.sessionKey, '2026-03-02T00:00:00.000Z', 8)
  await spend(deleted.sessionKey, '2026-03-02T00:00:00.000Z', 80)
  await moveThreadBetweenLists({ id: archived.id, groupChatId: chat.id, sessionKey: archived.sessionKey }, true)
  await db.delete(groupChatThread).where(eq(groupChatThread.id, deleted.id))
  const [stored] = await db
    .select({ archivedAt: groupChatThread.archivedAt })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, archived.id))
  assert.ok(stored?.archivedAt, 'the thread is archived')

  const rows = await usageSummary(personReader(person), { scope: { chat: chat.id }, since: SINCE, groupBy: 'thread' })
  assert.deepEqual(totals(rows), [[archived.ref, 8]])
})

test("a space scope sums the spend made in that space's chat, and an unknown space answers nothing", async () => {
  const spaceSlug = `space-${crypto.randomUUID()}`
  await db.insert(space).values({ slug: spaceSlug, name: spaceSlug })
  const spaceChat = await makeChat('space-chat', spaceSlug)
  const loose = await makeChat('loose')
  const person = await makePerson()
  await letIn(spaceChat.id, { userId: person })
  await letIn(loose.id, { userId: person })
  await spend((await makeThread(spaceChat.id)).sessionKey, '2026-03-02T00:00:00.000Z', 12)
  await spend((await makeThread(loose.id)).sessionKey, '2026-03-02T00:00:00.000Z', 120)

  const reader = personReader(person)
  assert.deepEqual(totals(await usageSummary(reader, { scope: { space: spaceSlug }, since: SINCE, groupBy: 'chat' })), [
    [spaceChat.id, 12],
  ])
  assert.deepEqual(await usageSummary(reader, { scope: { space: 'no-such-space' }, since: SINCE, groupBy: 'chat' }), [])
})

// ── grouping and cost ───────────────────────────────────────────────────

test('by day the keys are UTC days, oldest first; by agent the most tokens come first', async () => {
  const chat = await makeChat('grouping')
  const person = await makePerson()
  await letIn(chat.id, { userId: person })
  // Named so that key order and token order disagree.
  const big = await makeThread(chat.id, 'agent-zed')
  const small = await makeThread(chat.id, 'agent-amy')
  await spend(small.sessionKey, '2026-03-03T23:30:00.000Z', 5)
  await spend(big.sessionKey, '2026-03-02T00:30:00.000Z', 50)
  await spend(big.sessionKey, '2026-03-03T01:00:00.000Z', 50)

  const reader = personReader(person)
  assert.deepEqual(totals(await usageSummary(reader, { scope: { chat: chat.id }, since: SINCE, groupBy: 'day' })), [
    ['2026-03-02', 50],
    ['2026-03-03', 55],
  ])
  assert.deepEqual(totals(await usageSummary(reader, { scope: { chat: chat.id }, since: SINCE, groupBy: 'agent' })), [
    ['agent-zed', 100],
    ['agent-amy', 5],
  ])
})

test('cost sums the priced turns in one currency, says how many were priced, and is null for none or two currencies', async () => {
  const chat = await makeChat('cost')
  const person = await makePerson()
  await letIn(chat.id, { userId: person })
  const priced = await makeThread(chat.id)
  const partly = await makeThread(chat.id)
  const unpriced = await makeThread(chat.id)
  const mixed = await makeThread(chat.id)
  await spend(priced.sessionKey, '2026-03-02T00:00:00.000Z', 1, { amount: 0.25, currency: 'USD' })
  await spend(priced.sessionKey, '2026-03-02T01:00:00.000Z', 1, { amount: 0.5, currency: 'USD' })
  await spend(partly.sessionKey, '2026-03-02T00:00:00.000Z', 1, { amount: 1, currency: 'USD' })
  await spend(partly.sessionKey, '2026-03-02T01:00:00.000Z', 1)
  await spend(unpriced.sessionKey, '2026-03-02T00:00:00.000Z', 1)
  await spend(mixed.sessionKey, '2026-03-02T00:00:00.000Z', 1, { amount: 1, currency: 'USD' })
  await spend(mixed.sessionKey, '2026-03-02T01:00:00.000Z', 1, { amount: 1, currency: 'EUR' })

  const rows = await usageSummary(personReader(person), { scope: { chat: chat.id }, since: SINCE, groupBy: 'thread' })
  const costOf = (ref: string) => {
    const row = rows.find((candidate) => candidate.key === ref)
    assert.ok(row, `a row for ${ref}`)
    return { cost: row.cost, pricedTurns: row.pricedTurns, turns: row.turns }
  }
  assert.deepEqual(costOf(priced.ref), { cost: { amount: 0.75, currency: 'USD' }, pricedTurns: 2, turns: 2 })
  assert.deepEqual(costOf(partly.ref), { cost: { amount: 1, currency: 'USD' }, pricedTurns: 1, turns: 2 })
  assert.deepEqual(costOf(unpriced.ref), { cost: null, pricedTurns: 0, turns: 1 })
  assert.deepEqual(costOf(mixed.ref), { cost: null, pricedTurns: 2, turns: 2 })
})

// ── arguments ───────────────────────────────────────────────────────────

test('a malformed scope, grouping or time refuses with what was wrong', async () => {
  const reader = personReader(await makePerson())
  await assert.rejects(() => usageSummary(reader, { scope: {} as never, since: SINCE, groupBy: 'chat' }), /"scope"/)
  await assert.rejects(
    () => usageSummary(reader, { scope: { chat: 'a', agent: 'b' } as never, since: SINCE, groupBy: 'chat' }),
    /"scope"/,
  )
  await assert.rejects(
    () => usageSummary(reader, { scope: { chat: 'a' }, since: SINCE, groupBy: 'model' as never }),
    /"groupBy"/,
  )
  await assert.rejects(
    () => usageSummary(reader, { scope: { chat: 'a' }, since: 'yesterday', groupBy: 'chat' }),
    /"since" must be an ISO date/,
  )
  await assert.rejects(
    () => usageSummary(reader, { scope: { chat: 'a' }, since: SINCE, until: 'later', groupBy: 'chat' }),
    /"until" must be an ISO date/,
  )
})
