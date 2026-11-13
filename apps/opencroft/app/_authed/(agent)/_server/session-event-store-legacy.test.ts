// The event store's rewrite of keys recorded in the layout before compaction,
// against a real database: that a listed key is rewritten once before it is
// read, its search index moved with it; that the sweep rewrites the rest and
// leaves a key an engine session here writes under; that a failed rewrite
// changes nothing; and that a rename and a clear take the listing along.
// What the rows become is session-log-rewrite.test.ts's.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { agentSessionEvent, agentSessionLegacyLog, db, transcriptMessage, transcriptMessageCursor } from '@opencroft/db'
import { SESSION_LOG } from 'agent-client/transcript-log'
import type { ChatEvent } from 'agent-client/types'
import { and, asc, eq } from 'drizzle-orm'

import {
  catchUpTranscriptIndex,
  clearSessionEvents,
  flushSessionEvents,
  moveSessionEvents,
  readSessionLogs,
  recordLogWrite,
  rewriteLegacyTranscripts,
  storedLogReader,
} from './session-event-store'
import { searchTranscripts } from './transcript-search'

let counter = 0
function nextKey(): string {
  counter += 1
  return `agent:test:legacy-${counter}`
}

const say = (text: string, messageId = 'm1'): ChatEvent => ({ kind: 'agent_message', text, messageId })
const turnEnd: ChatEvent = { kind: 'turn_end', stopReason: 'end_turn' }
const step = (event: ChatEvent): ChatEvent => ({ kind: 'subagent_event', subagentSessionId: 'child-1', event })

// Two turns as the layout before compaction stored them, the old cap having
// cut everything below position 30.
const OLD_ROWS: ChatEvent[] = [
  { kind: 'user', text: 'first question' }, // 30
  say('alpha '), // 31
  say('bravo'), // 32
  turnEnd, // 33
  { kind: 'user', text: 'second question' }, // 34
  { kind: 'subagent', subagent: { subagentSessionId: 'child-1', name: 'Investigator', task: 'dig' } }, // 35
  step(say('digging ', 'c1')), // 36
  step(say('deeper', 'c1')), // 37
  {
    kind: 'subagent',
    subagent: { subagentSessionId: 'child-1', name: 'Investigator', task: 'dig', state: 'completed' },
  }, // 38
  say('charlie ', 'm2'), // 39
  say('delta', 'm2'), // 40
  turnEnd, // 41
]

// A key recorded in the old layout from position `start`, listed for the rewrite.
async function recordOldLayout(key: string, events = OLD_ROWS, start = 30): Promise<void> {
  await db
    .insert(agentSessionEvent)
    .values(events.map((event, offset) => ({ sessionKey: key, position: start + offset, event })))
  await db.insert(agentSessionLegacyLog).values({ sessionKey: key })
}

const listed = async (key: string) =>
  (await db.select().from(agentSessionLegacyLog).where(eq(agentSessionLegacyLog.sessionKey, key))).length > 0

const rowsOf = async (key: string, subagentId = SESSION_LOG) =>
  (
    await db
      .select({ position: agentSessionEvent.position, event: agentSessionEvent.event })
      .from(agentSessionEvent)
      .where(and(eq(agentSessionEvent.sessionKey, key), eq(agentSessionEvent.subagentId, subagentId)))
      .orderBy(asc(agentSessionEvent.position))
  ).map((row) => [row.position, row.event as ChatEvent] as const)

const hitsFor = async (key: string, word: string) =>
  (await searchTranscripts([key], word, 10)).hits.map((hit) => [hit.position, hit.role, hit.turn])

test("a listed key's rows are rewritten before a reopen reads them, its search index moved with them", async () => {
  const key = nextKey()
  await recordOldLayout(key)
  // A search message for history the cap cut, below the rows.
  await db
    .insert(transcriptMessage)
    .values({ sessionKey: key, position: 3, segment: 0, role: 'user', turn: 3, text: 'zulu long gone' })
  await catchUpTranscriptIndex()
  assert.deepEqual(await hitsFor(key, 'bravo'), [[31, 'agent', 30]])
  assert.deepEqual(await hitsFor(key, 'delta'), [[39, 'agent', 34]])

  const read = await readSessionLogs(key)
  assert.deepEqual(read.events, [
    { kind: 'user', text: 'first question' },
    say('alpha bravo'),
    turnEnd,
    { kind: 'user', text: 'second question' },
    {
      kind: 'subagent',
      subagent: { subagentSessionId: 'child-1', name: 'Investigator', task: 'dig', state: 'completed', steps: 1 },
    },
    say('charlie delta', 'm2'),
    turnEnd,
  ])
  assert.deepEqual([...read.bases], [[SESSION_LOG, 30]])
  assert.deepEqual(await rowsOf(key, 'child-1'), [[0, say('digging deeper', 'c1')]])
  assert.equal(await listed(key), false)

  // Each hit still opens its own turn, at the new positions; history below the
  // rows keeps its own.
  assert.deepEqual(await hitsFor(key, 'bravo'), [[31, 'agent', 30]])
  assert.deepEqual(await hitsFor(key, 'delta'), [[35, 'agent', 33]])
  assert.deepEqual(await hitsFor(key, 'second'), [[33, 'user', 33]])
  assert.deepEqual(await hitsFor(key, 'zulu'), [[3, 'user', 3]])
  const [cursor] = await db.select().from(transcriptMessageCursor).where(eq(transcriptMessageCursor.sessionKey, key))
  assert.equal(cursor?.resumeFrom, 37)
})

test('a rewritten key is not rewritten again, and new rows follow its rewritten end', async () => {
  const key = nextKey()
  await recordOldLayout(key)
  await readSessionLogs(key)
  const once = await rowsOf(key)
  await readSessionLogs(key)
  assert.deepEqual(await rowsOf(key), once)
  // A session that was not seeded from the rows numbers past them.
  recordLogWrite(key, `${key}#new`, {
    log: SESSION_LOG,
    position: 0,
    event: { kind: 'user', text: 'third' },
    appended: true,
  })
  await flushSessionEvents()
  assert.deepEqual(
    (await rowsOf(key)).map(([position]) => position),
    [30, 31, 32, 33, 34, 35, 36, 37],
  )
})

test('an offline turn listing reads the rewritten rows too', async () => {
  const key = nextKey()
  await recordOldLayout(key)
  const reader = await storedLogReader(key)
  assert.equal(reader.end, 7)
  assert.equal(await listed(key), false)
})

test('the sweep rewrites every listed key, and leaves one an engine session here writes under', async () => {
  const quiet = nextKey()
  const busy = nextKey()
  await recordOldLayout(quiet)
  await recordOldLayout(busy)
  // A new session recording under `busy`, past its old rows.
  recordLogWrite(busy, `${busy}#live`, {
    log: SESSION_LOG,
    position: 0,
    event: { kind: 'user', text: 'now' },
    appended: true,
  })
  await flushSessionEvents()

  const done = await rewriteLegacyTranscripts()
  assert.ok(done.sessions >= 1)
  assert.ok(done.rowsAfter < done.rowsBefore)
  assert.equal(await listed(quiet), false)
  assert.equal((await rowsOf(quiet)).length, 7)
  assert.equal(await listed(busy), true)
  assert.equal((await rowsOf(busy)).length, OLD_ROWS.length + 1)
  assert.ok(done.left >= 1)
})

test('a rewrite that cannot move the index changes nothing, and the rows still read back', async () => {
  // Two search messages starting inside one run, which the rewrite merges into
  // one entry: the index cannot move them both, so the transaction fails.
  const key = nextKey()
  await recordOldLayout(key)
  await db.insert(transcriptMessage).values([
    { sessionKey: key, position: 31, segment: 0, role: 'agent', turn: 30, text: 'alpha' },
    { sessionKey: key, position: 32, segment: 0, role: 'agent', turn: 30, text: 'bravo' },
  ])
  await db
    .insert(transcriptMessageCursor)
    .values({ sessionKey: key, resumeFrom: 42, resumeChars: 0, turn: 34, openPosition: null, openSegment: 0 })
  const before = await rowsOf(key)

  const read = await readSessionLogs(key)
  assert.deepEqual(read.events, OLD_ROWS)
  assert.deepEqual(await rowsOf(key), before)
  assert.equal(await listed(key), true)
  assert.deepEqual(await hitsFor(key, 'bravo'), [[32, 'agent', 30]])
})

test('a rename carries the listing to the new key, and a clear drops it', async () => {
  const from = nextKey()
  const to = nextKey()
  await recordOldLayout(from)
  await moveSessionEvents([{ from, to }])
  assert.equal(await listed(from), false)
  assert.equal(await listed(to), true)
  await clearSessionEvents(to)
  assert.equal(await listed(to), false)
})
