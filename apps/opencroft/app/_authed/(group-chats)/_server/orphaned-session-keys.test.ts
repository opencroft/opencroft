// The orphaned-key sweep against a real database: what it forgets, what it
// keeps, and when it refuses to touch anything. The sweep reads the whole
// store, so each test leaves nothing orphaned behind it for the next.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { agentQueueEntry, agentSessionEvent, db, groupChat, groupChatThread, groupChatThreadAlias } from '@opencroft/db'
import { eq } from 'drizzle-orm'

import {
  readPersistedConfigOptions,
  readPersistedPresence,
  readPersistedSession,
  writePersistedConfigOption,
  writePersistedPresence,
  writePersistedSession,
} from '@/app/_authed/(agent)/_server/acp-session-store'
import { queueStore } from '@/app/_authed/(agent)/_server/queue-store'
import { appendSessionEvent, flushSessionEvents } from '@/app/_authed/(agent)/_server/session-event-store'
import { migrateThreadSessionKeys } from './model'
import { describeOrphanSweep, type OrphanSweepReport, sweepOrphanedSessionKeys } from './orphaned-session-keys'

const [chat] = await db.insert(groupChat).values({ slug: 'sweep', name: 'Sweep', topic: 'Sweep' }).returning()
assert.ok(chat)
const chatId = chat.id

/** A live thread whose key holds a durable pointer, as every opened thread does. */
async function liveThread(threadSlug: string): Promise<{ id: string; key: string }> {
  const key = `group-chat.sweep.agent.${threadSlug}`
  const [row] = await db
    .insert(groupChatThread)
    .values({ groupChatId: chatId, agentNodeId: 'agent', sessionKey: key, slug: threadSlug })
    .returning()
  assert.ok(row)
  await writePersistedSession(key, `session-${threadSlug}`, true)
  return { id: row.id, key }
}

const queued = async (key: string) =>
  (await db.select().from(agentQueueEntry).where(eq(agentQueueEntry.sessionKey, key))).length
const recorded = async (key: string) =>
  (await db.select().from(agentSessionEvent).where(eq(agentSessionEvent.sessionKey, key))).length

function forgotten(report: OrphanSweepReport) {
  assert.ok(!('refused' in report), `the sweep refused: ${'refused' in report ? report.refused : ''}`)
  return report
}

const owned = await Promise.all(['one', 'two', 'three', 'four', 'five'].map(liveThread))

test('an orphan in each store is forgotten, whatever its spelling, and owned keys are not', async () => {
  const pointerOrphan = 'group-chat.sweep.agent.deleted-pointer'
  const presenceOrphan = 'group-chat:sweep:agent:deleted-presence'
  const configOrphan = 'group-chat.sweep.agent.deleted-config'
  const queueAndTranscriptOrphan = 'group-chat.sweep.agent.deleted-queue'
  const directChat = 'agent:someone:chat'
  await writePersistedSession(pointerOrphan, 'gone-1', true)
  await writePersistedPresence(presenceOrphan, { kind: 'online' })
  await writePersistedConfigOption(configOrphan, 'model', 'x')
  await queueStore.append(
    queueAndTranscriptOrphan,
    {
      id: 'orphan-entry',
      kind: 'message',
      sender: 'Reader',
      sentAt: new Date().toISOString(),
      text: 'never delivered',
    },
    'end',
  )
  appendSessionEvent(queueAndTranscriptOrphan, { kind: 'agent_message', text: 'from a deleted thread' })
  await flushSessionEvents()
  await writePersistedSession(directChat, 'direct', true)

  const report = forgotten(await sweepOrphanedSessionKeys())

  assert.deepEqual(Object.fromEntries(report.forgotten.map(({ key, stores }) => [key, [...stores].sort()])), {
    [pointerOrphan]: ['agent-tab-sessions'],
    [presenceOrphan]: ['agent-session-presence'],
    [configOrphan]: ['agent-tab-config-options'],
    [queueAndTranscriptOrphan]: ['queue', 'search index', 'transcript'],
  })
  assert.deepEqual(report.aliasHeld, [])
  assert.equal(await readPersistedSession(pointerOrphan), null)
  assert.equal(await readPersistedPresence(presenceOrphan), null)
  assert.deepEqual(await readPersistedConfigOptions(configOrphan), {})
  assert.equal(await queued(queueAndTranscriptOrphan), 0)
  assert.equal(await recorded(queueAndTranscriptOrphan), 0)
  for (const { key } of owned) {
    assert.ok(await readPersistedSession(key), `an owned pointer survives: ${key}`)
  }
  assert.ok(await readPersistedSession(directChat), 'a key outside the group-chat namespace is never touched')

  const lines = describeOrphanSweep(report)
  assert.equal(lines[0], `forgot 4 orphaned session key(s) of ${report.stored} stored`)
  assert.ok(lines.includes(`  forgot ${presenceOrphan} (agent-session-presence)`))

  // Runs safely twice: the second start finds nothing and says nothing.
  const again = forgotten(await sweepOrphanedSessionKeys())
  assert.deepEqual(again.forgotten, [])
  assert.deepEqual(describeOrphanSweep(again), [])
})

test("state under a live thread's alias is kept and reported, not forgotten", async () => {
  const [thread] = owned
  assert.ok(thread)
  const aliasKey = 'group-chat.sweep.agent.old-name'
  await db
    .insert(groupChatThreadAlias)
    .values({ threadId: thread.id, groupChatId: chatId, agentNodeId: 'agent', sessionKey: aliasKey, slug: null })
  await writePersistedSession(aliasKey, 'mid-rename', true)

  const report = forgotten(await sweepOrphanedSessionKeys())
  assert.deepEqual(report.forgotten, [])
  assert.deepEqual(report.aliasHeld, [{ key: aliasKey, stores: ['agent-tab-sessions'] }])
  assert.ok(await readPersistedSession(aliasKey), 'the half-moved state is still there')
  assert.deepEqual(describeOrphanSweep(report), [
    'alias-held session state: 1',
    `  kept ${aliasKey} (agent-tab-sessions)`,
  ])

  await db.delete(groupChatThreadAlias).where(eq(groupChatThreadAlias.sessionKey, aliasKey))
  forgotten(await sweepOrphanedSessionKeys())
})

// A move the migration could not finish: the row is already dot -- so no later
// migration selects it again -- while its queue and transcript are still filed
// under the colon key, marked as the thread's only by the colon alias the move
// wrote. Retiring that alias would hand the state to the sweep as nobody's.
test('state a half-finished move left under its colon key is kept, and so is the alias marking it', async () => {
  const thread = await liveThread('half-moved')
  const colonKey = 'group-chat:sweep:agent:half-moved'
  const emptyColonKey = 'group-chat:sweep:agent:long-gone'
  for (const sessionKey of [colonKey, emptyColonKey]) {
    await db
      .insert(groupChatThreadAlias)
      .values({ threadId: thread.id, groupChatId: chatId, agentNodeId: 'agent', sessionKey, slug: null })
  }
  await queueStore.append(
    colonKey,
    {
      id: 'unmoved-entry',
      kind: 'message',
      sender: 'Reader',
      sentAt: new Date().toISOString(),
      text: 'still waiting under the old key',
    },
    'end',
  )
  appendSessionEvent(colonKey, { kind: 'agent_message', text: 'recorded before the move' })
  await flushSessionEvents()

  const migration = await migrateThreadSessionKeys()
  assert.equal(migration.aliasesRetired, 1, 'the colon alias holding nothing is retired')
  const colonAliases = await db.select().from(groupChatThreadAlias).where(eq(groupChatThreadAlias.threadId, thread.id))
  assert.deepEqual(
    colonAliases.map((alias) => alias.sessionKey),
    [colonKey],
    'the one still marking state stays',
  )

  const report = forgotten(await sweepOrphanedSessionKeys())
  assert.deepEqual(report.forgotten, [])
  assert.deepEqual(report.aliasHeld, [{ key: colonKey, stores: ['queue', 'transcript', 'search index'] }])
  assert.equal(await queued(colonKey), 1, 'the unmoved message survives')
  assert.equal(await recorded(colonKey), 1, 'the unmoved transcript survives')

  await db.delete(groupChatThreadAlias).where(eq(groupChatThreadAlias.threadId, thread.id))
  forgotten(await sweepOrphanedSessionKeys())
})

// Each refusal is driven through the owner read, which is the one input the
// sweep's judgement rests on, and each leaves an orphan in place to prove
// nothing was touched.
test('the sweep fails closed, and says why', async (t) => {
  const orphan = 'group-chat.sweep.agent.left-alone'
  await writePersistedSession(orphan, 'kept', true)
  // Every live thread here holds a pointer, so the store holds one key per
  // thread plus the orphan.
  const threads = new Set(
    (await db.select({ key: groupChatThread.sessionKey }).from(groupChatThread)).map((row) => row.key),
  )

  await t.test('when the owner read throws', async () => {
    const report = await sweepOrphanedSessionKeys(async () => {
      throw new Error('connection lost')
    })
    assert.ok('refused' in report)
    assert.match(report.refused, /could not read which threads own session keys \(Error: connection lost\)/)
  })

  await t.test('when no thread exists beside stored keys', async () => {
    const report = await sweepOrphanedSessionKeys(async () => ({ threads: new Set(), aliases: new Set() }))
    assert.ok('refused' in report)
    assert.match(report.refused, /^no thread exists while \d+ group-chat key\(s\) are stored$/)
  })

  await t.test('when more than half the stored keys have no thread', async () => {
    const one = new Set([...threads].slice(0, 1))
    const report = await sweepOrphanedSessionKeys(async () => ({ threads: one, aliases: new Set() }))
    assert.ok('refused' in report)
    assert.equal(
      report.refused,
      `${threads.size} of ${threads.size + 1} stored group-chat key(s) have no thread -- more than half`,
    )
    assert.deepEqual(describeOrphanSweep(report), [`left orphaned session keys alone: ${report.refused}`])
  })

  assert.ok(await readPersistedSession(orphan), 'no refusal touched anything')
  // The control: with the real owner read, the same store is swept.
  const cleared = forgotten(await sweepOrphanedSessionKeys())
  assert.deepEqual(
    cleared.forgotten.map(({ key }) => key),
    [orphan],
  )
})

test('the log lists fifty keys and counts the rest', () => {
  const forgottenKeys = Array.from({ length: 53 }, (_, i) => ({ key: `group-chat.x.y.k${i}`, stores: ['queue'] }))
  const lines = describeOrphanSweep({ forgotten: forgottenKeys, aliasHeld: [], stored: 200 })
  assert.equal(lines.length, 1 + 50 + 1)
  assert.equal(lines[50], '  forgot group-chat.x.y.k49 (queue)')
  assert.equal(lines.at(-1), '  (+3 more)')
})
