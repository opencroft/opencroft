// This app's half of the durable transcript, against a real database.
//
// The engine's half — what a restored log is turned back into — is tested in
// agent-client. What belongs here is what only a database can get wrong: that
// event ORDER survives a round trip across batches, that a buffered tail is not
// lost to a read that arrives before the timer, that one session's transcript
// is not another's, that the cap drops the oldest rather than the newest, and
// that a rename carries the whole recording with it. And, for the search index
// written alongside, that it keeps what the cap trims and survives a process
// that stops mid-reply.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { agentSessionEvent, db, transcriptMessage, transcriptMessageCursor } from '@opencroft/db'
import type { ChatEvent } from 'agent-client/types'
import { and, asc, eq, sql } from 'drizzle-orm'

import {
  appendSessionEvent,
  catchUpTranscriptIndex,
  clearSessionEvents,
  flushSessionEvents,
  moveSessionEvents,
  readSessionEvents,
  recordReplay,
  rerecordEditedSession,
  retireSessionTranscript,
} from './session-event-store'
import { searchTranscripts } from './transcript-search'

// A fresh key per test: these all run against one database and must not see
// each other's rows.
let counter = 0
function nextKey(): string {
  counter += 1
  return `agent:test:session-events-${counter}`
}

const agentMessage = (text: string): ChatEvent => ({ kind: 'agent_message', text })
const turnEnd: ChatEvent = { kind: 'turn_end', stopReason: 'end_turn' }

const texts = async (key: string) =>
  (await readSessionEvents(key)).map((event) => (event.kind === 'agent_message' ? event.text : event.kind))

test('a recorded transcript comes back in the order it was emitted', async () => {
  const key = nextKey()
  appendSessionEvent(key, agentMessage('first'))
  appendSessionEvent(key, agentMessage('second'))
  appendSessionEvent(key, agentMessage('third'))
  assert.deepEqual(await texts(key), ['first', 'second', 'third'])
})

test('order survives across separate batches, so a turn is not reassembled wrongly', async () => {
  // Positions are allocated at flush time, so two batches must continue one
  // numbering rather than each starting from where the table looked empty.
  const key = nextKey()
  appendSessionEvent(key, agentMessage('first'))
  await flushSessionEvents()
  appendSessionEvent(key, agentMessage('second'))
  await flushSessionEvents()
  appendSessionEvent(key, agentMessage('third'))
  assert.deepEqual(await texts(key), ['first', 'second', 'third'])
})

test('a read flushes the buffered tail, so a session reopened immediately is not missing its last turn', async () => {
  // The whole point of reading through this module rather than the table: the
  // events a reader was just looking at are the ones still in the buffer.
  const key = nextKey()
  appendSessionEvent(key, agentMessage('still buffered'))
  assert.deepEqual(await texts(key), ['still buffered'])
})

test('every event kind is recorded, snapshots included', async () => {
  // The read side folds the last snapshot it sees per kind, so dropping them
  // here would restore a session with no modes and no usage.
  const key = nextKey()
  const events: ChatEvent[] = [
    { kind: 'user', text: 'delegate this' },
    { kind: 'subagent', subagent: { subagentSessionId: 'child-1', name: 'Investigator', task: 'dig' } },
    { kind: 'subagent_event', subagentSessionId: 'child-1', event: { kind: 'agent_message', text: 'dug' } },
    { kind: 'usage', used: 10, size: 100 },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  for (const event of events) {
    appendSessionEvent(key, event)
  }
  assert.deepEqual(await readSessionEvents(key), events)
})

test("one session's transcript is not another's", async () => {
  const mine = nextKey()
  const theirs = nextKey()
  appendSessionEvent(mine, agentMessage('mine'))
  appendSessionEvent(theirs, agentMessage('theirs'))
  assert.deepEqual(await texts(mine), ['mine'])
  assert.deepEqual(await texts(theirs), ['theirs'])
})

test('clearing one session leaves every other session alone', async () => {
  const mine = nextKey()
  const theirs = nextKey()
  appendSessionEvent(mine, agentMessage('mine'))
  appendSessionEvent(theirs, agentMessage('theirs'))
  await flushSessionEvents()

  await clearSessionEvents(theirs)
  assert.deepEqual(await texts(theirs), [])
  assert.deepEqual(await texts(mine), ['mine'])
})

const positionsOf = async (key: string) =>
  (
    await db
      .select({ position: agentSessionEvent.position })
      .from(agentSessionEvent)
      .where(eq(agentSessionEvent.sessionKey, key))
      .orderBy(asc(agentSessionEvent.position))
  ).map((row) => row.position)

test('a retired key starts numbering again, rather than resuming where it left off', async () => {
  // The cached next-position has to go with the rows. Kept, the first event of
  // the new transcript would sort after a history that no longer exists, and
  // the cap would then count positions nothing occupies.
  const key = nextKey()
  appendSessionEvent(key, { kind: 'user', text: 'old' })
  await flushSessionEvents()
  await retireSessionTranscript(key)
  appendSessionEvent(key, agentMessage('new'))
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [0])
})

test('a key cleared for a conversation that lives on numbers past what its search index names', async () => {
  // The index keeps the conversation's history through the clear, so a
  // position numbered again would alias one of its rows.
  const key = nextKey()
  appendSessionEvent(key, { kind: 'user', text: 'kept in search' })
  appendSessionEvent(key, turnEnd)
  await flushSessionEvents()
  await clearSessionEvents(key)
  appendSessionEvent(key, agentMessage('after the clear'))
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [2])
})

test('numbering after a clear stays past the search index in a process that did not see the clear', async () => {
  const key = nextKey()
  // What a stopped process left: index rows up to position 49, no events.
  await db.insert(transcriptMessageCursor).values({ sessionKey: key, resumeFrom: 50, turn: 40, openSegment: 0 })
  appendSessionEvent(key, agentMessage('first after a restart'))
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [50])
})

test('a rename carries the whole recording onto the new key and leaves nothing behind', async () => {
  // Left behind, the conversation's history is unreachable under a name nothing
  // looks up again — and the next open silently falls back to the harness's
  // replay, which is exactly the loss the recording exists to prevent.
  const from = nextKey()
  const to = nextKey()
  appendSessionEvent(from, agentMessage('first'))
  appendSessionEvent(from, agentMessage('second'))

  await moveSessionEvents([{ from, to }])

  assert.deepEqual(await texts(to), ['first', 'second'])
  assert.deepEqual(await texts(from), [])
})

test('a rename carries a tail that was still buffered when it ran', async () => {
  const from = nextKey()
  const to = nextKey()
  appendSessionEvent(from, agentMessage('buffered'))
  await moveSessionEvents([{ from, to }])
  assert.deepEqual(await texts(to), ['buffered'])
})

test('appending past the cap drops the OLDEST events, never the newest', async () => {
  // A transcript is read from its tail, so a cap that cut the other way would
  // throw away the part anybody is looking at. Driven against the real cap so
  // the test measures the shipped number rather than restating a guess at it.
  const key = nextKey()
  const cap = await capacity()
  for (let i = 0; i < cap + 5; i++) {
    appendSessionEvent(key, agentMessage(`event-${i}`))
  }
  const kept = await texts(key)
  assert.equal(kept.length, cap)
  assert.equal(kept.at(0), 'event-5')
  assert.equal(kept.at(-1), `event-${cap + 4}`)
})

// ── The search index written alongside ────────────────────────────────────

const messages = async (key: string) =>
  db
    .select({
      position: transcriptMessage.position,
      segment: transcriptMessage.segment,
      role: transcriptMessage.role,
      turn: transcriptMessage.turn,
      text: transcriptMessage.text,
    })
    .from(transcriptMessage)
    .where(eq(transcriptMessage.sessionKey, key))
    .orderBy(asc(transcriptMessage.position), asc(transcriptMessage.segment))

const message = (position: number, role: 'user' | 'agent', turn: number, text: string, segment = 0) => ({
  position,
  segment,
  role,
  turn,
  text,
})

// What a process that has since stopped left behind: recorded events, and the
// rows and cursor it had written by then. Written straight to the tables, so
// nothing of it is in this process's memory.
async function leftByStoppedProcess(
  key: string,
  events: ChatEvent[],
  written: { rows: ReturnType<typeof message>[]; resumeFrom: number; turn: number | null },
): Promise<void> {
  await db
    .insert(agentSessionEvent)
    .values(events.map((event, position) => ({ sessionKey: key, position, event, createdAt: new Date() })))
  if (written.rows.length > 0) {
    await db
      .insert(transcriptMessage)
      .values(written.rows.map((row) => ({ sessionKey: key, ...row, createdAt: new Date() })))
  }
  await db.insert(transcriptMessageCursor).values({
    sessionKey: key,
    resumeFrom: written.resumeFrom,
    turn: written.turn,
    openPosition: null,
    openSegment: 0,
  })
}

test('a question is searchable at once, and a reply once its turn ends', async () => {
  const key = nextKey()
  appendSessionEvent(key, { kind: 'user', text: 'where is the config' })
  appendSessionEvent(key, agentMessage('In the con'))
  await flushSessionEvents()
  appendSessionEvent(key, agentMessage('fig folder.'))
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [message(0, 'user', 0, 'where is the config')])

  appendSessionEvent(key, turnEnd)
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'where is the config'),
    message(1, 'agent', 0, 'In the config folder.'),
  ])
})

test('the index keeps the messages the event cap trims', async () => {
  const key = nextKey()
  const cap = await capacity()
  appendSessionEvent(key, { kind: 'user', text: 'oldest question' })
  appendSessionEvent(key, agentMessage('oldest answer'))
  appendSessionEvent(key, turnEnd)
  for (let i = 3; i < cap + 10; i++) {
    appendSessionEvent(key, { kind: 'usage', used: i })
  }
  const recorded = await texts(key)
  assert.ok(!recorded.includes('user'), 'the question has been trimmed from the events')
  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'oldest question'),
    message(1, 'agent', 0, 'oldest answer'),
  ])
})

test('retiring a session clears its index, its cursor and the reply it held', async () => {
  const key = nextKey()
  appendSessionEvent(key, { kind: 'user', text: 'gone soon' })
  appendSessionEvent(key, agentMessage('held, never ended'))
  await flushSessionEvents()

  await retireSessionTranscript(key)
  assert.deepEqual(await messages(key), [])
  assert.deepEqual(
    await db.select().from(transcriptMessageCursor).where(eq(transcriptMessageCursor.sessionKey, key)),
    [],
  )

  appendSessionEvent(key, agentMessage('a new start'))
  appendSessionEvent(key, turnEnd)
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [message(0, 'agent', 0, 'a new start')])
})

test('clearing the events of a conversation that lives on keeps its search index', async () => {
  const key = nextKey()
  appendSessionEvent(key, { kind: 'user', text: 'still searchable' })
  appendSessionEvent(key, turnEnd)
  await flushSessionEvents()
  await clearSessionEvents(key)
  assert.deepEqual(await messages(key), [message(0, 'user', 0, 'still searchable')])
})

// A conversation as the engine holds it, recorded through the store: its
// events in order, so a test can hand the same log to an edit as the source.
async function recordConversation(key: string, events: ChatEvent[]): Promise<ChatEvent[]> {
  for (const event of events) {
    appendSessionEvent(key, event)
  }
  // A read waits out every batch already chained for the key, which a flush
  // of what is still buffered does not.
  await readSessionEvents(key)
  return events
}

const turnOf = (question: string, answer: string): ChatEvent[] => [
  { kind: 'user', text: question },
  agentMessage(answer),
  turnEnd,
]

test('an edit keeps older messages searchable, trimmed ones included, and drops the turns it rewinds', async () => {
  const key = nextKey()
  const cap = await capacity()
  // Positions: the oldest turn 0-2, a question at 3 whose 30-chunk reply runs
  // 4-33 and ends at 34, filler, then the kept, edited and later turns. The
  // filler is sized so the cap cuts through that reply, at position 20.
  const chunks = Array.from({ length: 30 }, (_, i) => ` c${i}`)
  const filler: ChatEvent[] = Array.from({ length: cap - 24 }, (_, i) => ({ kind: 'usage', used: i }))
  const kept = 35 + filler.length
  const edited = kept + 3
  await recordConversation(key, [
    ...turnOf('oldest question', 'oldest answer'),
    { kind: 'user', text: 'spanning question' },
    ...chunks.map(agentMessage),
    turnEnd,
    ...filler,
    ...turnOf('kept question', 'kept answer'),
    ...turnOf('edited question', 'edited-away answer'),
    ...turnOf('later question', 'later answer'),
  ])
  assert.equal((await positionsOf(key))[0], 20, 'the cap has cut through the long reply')
  // What an engine restored from the recording holds -- the trimmed turns are
  // only in the search index.
  const log = await readSessionEvents(key)
  const editedIndex = log.findIndex((event) => event.kind === 'user' && event.text === 'edited question')

  await rerecordEditedSession(key, log, editedIndex, log.slice(0, editedIndex))
  await recordConversation(key, turnOf('the edited question', 'a new answer'))

  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'oldest question'),
    message(1, 'agent', 0, 'oldest answer'),
    message(3, 'user', 3, 'spanning question'),
    message(4, 'agent', 3, chunks.join('')),
    message(kept, 'user', kept, 'kept question'),
    message(kept + 1, 'agent', kept, 'kept answer'),
    message(edited, 'user', edited, 'the edited question'),
    message(edited + 1, 'agent', edited, 'a new answer'),
  ])
  // The recording is the fork's history and then the new turn, numbered so it
  // ends where it did before the edit.
  const recorded = await texts(key)
  assert.deepEqual(recorded.slice(-6), ['user', 'kept answer', 'turn_end', 'user', 'a new answer', 'turn_end'])
  assert.equal((await positionsOf(key)).at(-1), edited + 2)
})

test('an edit whose turn cannot be placed rebuilds the index from the recording, without duplicates', async () => {
  const key = nextKey()
  const log = await recordConversation(key, [...turnOf('first', 'one'), ...turnOf('second', 'two')])
  // A source log that disagrees with the recording at the edited turn.
  const disagreeing = log.map((event, index) => (index === 3 ? { kind: 'user' as const, text: 'not recorded' } : event))

  await rerecordEditedSession(key, disagreeing, 3, log.slice(0, 3))
  await recordConversation(key, turnOf('second, edited', 'two again'))

  const rows = await messages(key)
  assert.deepEqual(
    rows.map((row) => [row.role, row.text]),
    [
      ['user', 'first'],
      ['agent', 'one'],
      ['user', 'second, edited'],
      ['agent', 'two again'],
    ],
  )
})

test('a harness replay into a cleared recording leaves the search index as it was', async () => {
  const key = nextKey()
  const history = await recordConversation(key, [
    ...turnOf('asked once', 'answered once'),
    ...turnOf('asked twice', 'answered twice'),
  ])
  const before = await messages(key)

  await clearSessionEvents(key)
  await recordReplay(key, async () => {
    for (const event of history) {
      appendSessionEvent(key, event)
    }
    appendSessionEvent(key, { kind: 'turn_end', stopReason: 'replayed' })
  })
  assert.deepEqual(await messages(key), before)

  // What comes after the replay is indexed, numbered past it.
  await recordConversation(key, turnOf('asked after', 'answered after'))
  const after = await messages(key)
  assert.deepEqual(after.slice(0, before.length), before)
  assert.deepEqual(
    after.slice(before.length).map((row) => [row.role, row.text, row.position]),
    [
      ['user', 'asked after', 6 + 7],
      ['agent', 'answered after', 6 + 8],
    ],
  )
})

test('a harness replay for a conversation the index holds nothing for is indexed', async () => {
  const key = nextKey()
  await recordReplay(key, async () => {
    for (const event of turnOf('from the harness', 'replayed answer')) {
      appendSessionEvent(key, event)
    }
  })
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'from the harness'),
    message(1, 'agent', 0, 'replayed answer'),
  ])
})

test('a rename carries the index and the reply still being held', async () => {
  const from = nextKey()
  const to = nextKey()
  appendSessionEvent(from, { kind: 'user', text: 'travelling' })
  appendSessionEvent(from, agentMessage('half of '))
  await flushSessionEvents()

  await moveSessionEvents([{ from, to }])
  appendSessionEvent(to, agentMessage('the answer'))
  appendSessionEvent(to, turnEnd)
  await flushSessionEvents()

  assert.deepEqual(await messages(from), [])
  assert.deepEqual(await messages(to), [
    message(0, 'user', 0, 'travelling'),
    message(1, 'agent', 0, 'half of the answer'),
  ])
})

test('the backfill indexes a transcript recorded before the index, by the same rule as a live one', async () => {
  const recorded = nextKey()
  const live = nextKey()
  const events: ChatEvent[] = [
    { kind: 'user', text: 'what changed' },
    agentMessage('Two '),
    { kind: 'agent_thought', text: 'not searchable' },
    agentMessage('files.'),
    turnEnd,
  ]
  // As the table held it before the index existed: events, no rows, no cursor.
  await db
    .insert(agentSessionEvent)
    .values(events.map((event, position) => ({ sessionKey: recorded, position, event })))
  for (const event of events) {
    appendSessionEvent(live, event)
  }
  await flushSessionEvents()

  const first = await catchUpTranscriptIndex()

  assert.ok(first.sessions >= 1, 'the recorded session was indexed')
  assert.deepEqual(await messages(recorded), await messages(live))
  assert.deepEqual(await messages(recorded), [
    message(0, 'user', 0, 'what changed'),
    message(1, 'agent', 0, 'Two files.'),
  ])
  // A second run finds nothing behind for it.
  await catchUpTranscriptIndex()
  assert.deepEqual(await messages(recorded), [
    message(0, 'user', 0, 'what changed'),
    message(1, 'agent', 0, 'Two files.'),
  ])
})

test('a reply cut off by a stopped process is rebuilt from the event store once, not lost or doubled', async () => {
  const key = nextKey()
  // The stopped process had written the question; the reply was still held in
  // its memory when it stopped, so only the events remember it.
  await leftByStoppedProcess(key, [{ kind: 'user', text: 'tell me' }, agentMessage('Once '), agentMessage('upon ')], {
    rows: [message(0, 'user', 0, 'tell me')],
    resumeFrom: 1,
    turn: 0,
  })

  await catchUpTranscriptIndex()
  await catchUpTranscriptIndex()
  // The process streaming it is gone, so the reply ends where the events do.
  assert.deepEqual(await messages(key), [message(0, 'user', 0, 'tell me'), message(1, 'agent', 0, 'Once upon ')])

  // Whatever this process records afterwards is a reply of its own.
  appendSessionEvent(key, agentMessage('a time.'))
  appendSessionEvent(key, turnEnd)
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'tell me'),
    message(1, 'agent', 0, 'Once upon '),
    message(3, 'agent', 0, 'a time.'),
  ])
})

test('a reply cut off by a stopped process is rebuilt by the next live batch when the backfill has not run', async () => {
  const key = nextKey()
  await leftByStoppedProcess(key, [{ kind: 'user', text: 'tell me' }, agentMessage('Once upon ')], {
    rows: [message(0, 'user', 0, 'tell me')],
    resumeFrom: 1,
    turn: 0,
  })
  appendSessionEvent(key, { kind: 'user', text: 'go on' })
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'tell me'),
    message(1, 'agent', 0, 'Once upon '),
    message(2, 'user', 2, 'go on'),
  ])
})

test('a reply a stopped process left half-written keeps its start time in the segments written after', async () => {
  const key = nextKey()
  const began = new Date('2026-01-01T00:00:00Z')
  await db.insert(agentSessionEvent).values(
    [{ kind: 'user', text: 'long one' }, agentMessage('first part'), agentMessage(' second part')].map(
      (event, position) => ({
        sessionKey: key,
        position,
        event,
        createdAt: began,
      }),
    ),
  )
  // Its first segment was written out before it stopped; the rest was held.
  await db.insert(transcriptMessage).values([
    { sessionKey: key, position: 0, segment: 0, role: 'user', turn: 0, text: 'long one', createdAt: began },
    { sessionKey: key, position: 1, segment: 0, role: 'agent', turn: 0, text: 'first part', createdAt: began },
  ])
  await db
    .insert(transcriptMessageCursor)
    .values({ sessionKey: key, resumeFrom: 2, turn: 0, openPosition: 1, openSegment: 1 })

  await catchUpTranscriptIndex()

  const rows = await db
    .select({
      segment: transcriptMessage.segment,
      text: transcriptMessage.text,
      createdAt: transcriptMessage.createdAt,
    })
    .from(transcriptMessage)
    .where(and(eq(transcriptMessage.sessionKey, key), eq(transcriptMessage.position, 1)))
    .orderBy(asc(transcriptMessage.segment))
  assert.deepEqual(rows, [
    { segment: 0, text: 'first part', createdAt: began },
    { segment: 1, text: ' second part', createdAt: began },
  ])
})

test('a live batch indexed while the backfill is running is indexed once', async () => {
  const key = nextKey()
  await db.insert(agentSessionEvent).values([
    { sessionKey: key, position: 0, event: { kind: 'user', text: 'old question' } },
    { sessionKey: key, position: 1, event: agentMessage('old answer') },
  ])
  // The backfill's scan is issued first and finds the session behind; the
  // live batch is then indexed before the backfill reaches the session.
  const backfill = catchUpTranscriptIndex()
  appendSessionEvent(key, agentMessage(' and new'))
  appendSessionEvent(key, turnEnd)
  await Promise.all([backfill, flushSessionEvents()])
  const rows = await messages(key)
  assert.equal(rows.filter((row) => row.role === 'user').length, 1, 'the question once')
  assert.equal(
    rows
      .map((row) => row.text)
      .join('|')
      .split('old answer').length - 1,
    1,
    'the old answer once',
  )
  assert.equal(
    rows
      .map((row) => row.text)
      .join('|')
      .split(' and new').length - 1,
    1,
    'the new text once',
  )
})

test('a failed index write costs nothing the next batch cannot rebuild, and never an event', async () => {
  const key = nextKey()
  appendSessionEvent(key, { kind: 'user', text: 'first' })
  await flushSessionEvents()
  // A constraint the index rows of one batch break, standing in for any
  // failure of the index write.
  await db.execute(sql`alter table "TranscriptMessage" add constraint "test_refuse_text" check ("text" <> 'refused')`)
  try {
    appendSessionEvent(key, { kind: 'user', text: 'refused' })
    appendSessionEvent(key, agentMessage('the reply '))
    await flushSessionEvents()
  } finally {
    await db.execute(sql`alter table "TranscriptMessage" drop constraint "test_refuse_text"`)
  }
  appendSessionEvent(key, agentMessage('goes on'))
  appendSessionEvent(key, turnEnd)
  await flushSessionEvents()

  assert.deepEqual(await texts(key), ['user', 'user', 'the reply ', 'goes on', 'turn_end'])
  // The next batch read the state back from the cursor and the events, so the
  // question that failed is indexed after all, and the reply this process was
  // streaming is continued rather than ended.
  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'first'),
    message(1, 'user', 1, 'refused'),
    message(2, 'agent', 1, 'the reply goes on'),
  ])
})

test('a reply too long for one tsvector is recorded whole and indexed in searchable segments', async () => {
  const key = nextKey()
  // Distinct short words: the text whose parsed form is largest for its length.
  const words = Array.from({ length: 200_000 }, (_, i) => `w${i.toString(36)}`)
  const chunks = Array.from(
    { length: words.length / 200 },
    (_, i) => ` ${words.slice(i * 200, i * 200 + 200).join(' ')}`,
  )
  appendSessionEvent(key, { kind: 'user', text: 'write it all out' })
  for (const chunk of chunks) {
    appendSessionEvent(key, agentMessage(chunk))
  }
  appendSessionEvent(key, turnEnd)
  await flushSessionEvents()

  const recorded = await texts(key)
  assert.equal(recorded.length, chunks.length + 2)
  const segments = await db
    .select({
      segment: transcriptMessage.segment,
      text: transcriptMessage.text,
      size: sql<number>`pg_column_size(${transcriptMessage.document})::int`,
    })
    .from(transcriptMessage)
    .where(and(eq(transcriptMessage.sessionKey, key), eq(transcriptMessage.role, 'agent')))
    .orderBy(asc(transcriptMessage.segment))
  assert.ok(segments.length > 1, 'split into segments')
  assert.equal(segments.map((row) => row.text).join(''), chunks.join(''))
  for (const row of segments) {
    assert.ok(row.size < 1_048_576 / 4, `segment ${row.segment} parses to ${row.size} bytes`)
  }
  const hits = await searchTranscripts([key], words.at(-1) ?? '', 10)
  assert.deepEqual(
    hits.hits.map((hit) => [hit.position, hit.role, hit.turn]),
    [[1, 'agent', 0]],
  )
})

// The cap is the module's own constant and is deliberately not exported: a test
// that restated it would pass against a number nobody changed. Measured instead,
// by overrunning a key and reading back how much it held.
async function capacity(): Promise<number> {
  const probe = nextKey()
  const plenty = 4000
  for (let i = 0; i < plenty; i++) {
    appendSessionEvent(probe, agentMessage(`probe-${i}`))
  }
  const held = (await readSessionEvents(probe)).length
  await clearSessionEvents(probe)
  assert.ok(held < plenty, 'the store must cap a transcript rather than keep everything')
  return held
}
