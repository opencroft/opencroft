// This app's half of the durable transcript, against a real database.
//
// The engine's half — what a log holds and what a restored one is turned back
// into — is tested in agent-client. What belongs here is what only a database
// can get wrong: that an entry lands at its position and a rewrite replaces it,
// across batches; that a buffered tail is not lost to a read that arrives
// before the timer; that one session's transcript is not another's; that each
// log keeps its own numbering, from where the session's log starts here; that
// nothing is trimmed by default, a reopen reads only the tail and the rest is
// read back by position; that the history settings trim whole turns, oldest
// first; and that a rename carries the whole recording with it. And, for the
// search index written alongside, that it takes a reply that grows in place
// exactly once, and survives a process that stops mid-reply.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { agentSessionEvent, db, transcriptMessage, transcriptMessageCursor } from '@opencroft/db'
import { type LogWrite, SESSION_LOG, TranscriptLog } from 'agent-client/transcript-log'
import type { ChatEvent } from 'agent-client/types'
import { and, asc, eq, sql } from 'drizzle-orm'

import {
  attachSessionLogs,
  catchUpTranscriptIndex,
  clearSessionEvents,
  enginePositionOf,
  flushSessionEvents,
  moveSessionEvents,
  prepareSessionLogs,
  readSessionLogs,
  recordForkedSession,
  recordLogWrite,
  recordReplay,
  rerecordEditedSession,
  retireSessionTranscript,
  sessionHistoryPort,
  setHistoryRetention,
  storedLogReader,
  sweepHistory,
} from './session-event-store'
import { SEGMENT_CHARS } from './transcript-messages'
import { searchTranscripts } from './transcript-search'

// A fresh key per test: these all run against one database and must not see
// each other's rows.
let counter = 0
function nextKey(): string {
  counter += 1
  return `agent:test:session-events-${counter}`
}

// The next position of each engine session's own log, for `append`.
const nextOf = new Map<string, number>()

// One event appended to an engine session's own log as its own entry, the way
// a log kept before compaction holds every event. `session` is the engine
// session writing; by default one named after the key.
function append(key: string, event: ChatEvent, session = key): void {
  const position = nextOf.get(session) ?? 0
  nextOf.set(session, position + 1)
  recordLogWrite(key, session, { log: SESSION_LOG, position, event, appended: true })
}

// An engine session that keeps its log compacted, as the app's engine does:
// every event goes through agent-client's TranscriptLog, and each write it
// makes is recorded.
function compacting(key: string, session = `${key}#compact`) {
  const log = new TranscriptLog()
  return {
    log,
    emit(event: ChatEvent): LogWrite[] {
      const made = log.append(event)
      for (const write of made) {
        recordLogWrite(key, session, write)
      }
      return made
    },
  }
}

const agentMessage = (text: string): ChatEvent => ({ kind: 'agent_message', text })
const turnEnd: ChatEvent = { kind: 'turn_end', stopReason: 'end_turn' }

// The session's own log as stored, whole, in order.
async function storedEvents(key: string): Promise<ChatEvent[]> {
  const reader = await storedLogReader(key)
  return (await reader.read(0, reader.end)).events
}

const texts = async (key: string) =>
  (await storedEvents(key)).map((event) => (event.kind === 'agent_message' ? event.text : event.kind))

test('a recorded transcript comes back in the order it was emitted', async () => {
  const key = nextKey()
  append(key, agentMessage('first'))
  append(key, agentMessage('second'))
  append(key, agentMessage('third'))
  assert.deepEqual(await texts(key), ['first', 'second', 'third'])
})

test('order survives across separate batches, so a turn is not reassembled wrongly', async () => {
  const key = nextKey()
  append(key, agentMessage('first'))
  await flushSessionEvents()
  append(key, agentMessage('second'))
  await flushSessionEvents()
  append(key, agentMessage('third'))
  assert.deepEqual(await texts(key), ['first', 'second', 'third'])
})

test('a read flushes the buffered tail, so a session reopened immediately is not missing its last turn', async () => {
  // The whole point of reading through this module rather than the table: the
  // events a reader was just looking at are the ones still in the buffer.
  const key = nextKey()
  append(key, agentMessage('still buffered'))
  assert.deepEqual(await texts(key), ['still buffered'])
})

test('an entry rewritten in place is one row, holding its newest state, within a batch and across batches', async () => {
  const key = nextKey()
  const session = compacting(key)
  session.emit({ kind: 'user', text: 'write' })
  session.emit(agentMessage('Hel'))
  session.emit(agentMessage('lo'))
  await flushSessionEvents()
  session.emit(agentMessage(' there'))
  session.emit(turnEnd)
  assert.deepEqual(await texts(key), ['user', 'Hello there', 'turn_end'])
  assert.deepEqual(await positionsOf(key), [0, 1, 2])
})

test("a log with a subagent's steps stored inline in it, with no position, comes back as it was", async () => {
  // One row per event, a subagent's steps wrapped in the session's own log.
  const key = nextKey()
  const events: ChatEvent[] = [
    { kind: 'user', text: 'delegate this' },
    { kind: 'subagent', subagent: { subagentSessionId: 'child-1', name: 'Investigator', task: 'dig' } },
    { kind: 'subagent_event', subagentSessionId: 'child-1', event: { kind: 'agent_message', text: 'dug' } },
    { kind: 'usage', used: 10, size: 100 },
    turnEnd,
  ]
  await db
    .insert(agentSessionEvent)
    .values(events.map((event, position) => ({ sessionKey: key, position: 30 + position, event })))
  const read = await readSessionLogs(key)
  assert.deepEqual(read.events, events)
  assert.deepEqual([...read.subagentLogs], [])
  assert.deepEqual([...read.bases], [[SESSION_LOG, 30]])
})

test("a subagent's steps are stored in its own log, numbered from its own start, and its header in the session's", async () => {
  const key = nextKey()
  const session = compacting(key)
  const child = { subagentSessionId: 'child-1', name: 'Investigator', task: 'dig' }
  const step = (event: ChatEvent): ChatEvent => ({ kind: 'subagent_event', subagentSessionId: 'child-1', event })
  session.emit({ kind: 'user', text: 'delegate this' })
  session.emit({ kind: 'subagent', subagent: child })
  session.emit(step(agentMessage('digging')))
  session.emit(step({ kind: 'tool_call', toolCallId: 't1', title: 'ls', status: 'pending' }))
  session.emit({ kind: 'subagent', subagent: { ...child, state: 'completed' } })
  session.emit(turnEnd)

  const read = await readSessionLogs(key)
  assert.deepEqual(read.events, [
    { kind: 'user', text: 'delegate this' },
    { kind: 'subagent', subagent: { ...child, state: 'completed', steps: 2 } },
    turnEnd,
  ])
  assert.deepEqual(await positionsOf(key, 'child-1'), [0, 1])
  // A finished subagent takes no more steps: its log is read back by position
  // when its section is opened, not loaded with the session.
  assert.deepEqual([...read.subagentLogs.keys()], [])
  assert.deepEqual(
    (await sessionHistoryPort.read('unbound', 'child-1', 0, 2)).length,
    0,
    'a session that wrote nowhere reads nothing',
  )
  // A listing of turns reads the session's own log only.
  assert.deepEqual(await texts(key), ['user', 'subagent', 'turn_end'])
})

test('a reopen loads the logs of the subagents still running, whole, and binds them at 0', async () => {
  const key = nextKey()
  const session = compacting(key)
  const step = (id: string, event: ChatEvent): ChatEvent => ({ kind: 'subagent_event', subagentSessionId: id, event })
  session.emit({ kind: 'user', text: 'delegate two' })
  session.emit({ kind: 'subagent', subagent: { subagentSessionId: 'running', name: 'A', task: 'a' } })
  session.emit({ kind: 'subagent', subagent: { subagentSessionId: 'done', name: 'B', task: 'b' } })
  session.emit(step('running', agentMessage('still at it')))
  session.emit(step('done', agentMessage('finished')))
  session.emit({ kind: 'subagent', subagent: { subagentSessionId: 'done', name: 'B', task: 'b', state: 'completed' } })

  const read = await readSessionLogs(key)
  assert.deepEqual([...read.subagentLogs], [['running', [agentMessage('still at it')]]])
  assert.deepEqual(read.bases.get('running'), 0)
})

test("one session's transcript is not another's", async () => {
  const mine = nextKey()
  const theirs = nextKey()
  append(mine, agentMessage('mine'))
  append(theirs, agentMessage('theirs'))
  assert.deepEqual(await texts(mine), ['mine'])
  assert.deepEqual(await texts(theirs), ['theirs'])
})

test('clearing one session leaves every other session alone', async () => {
  const mine = nextKey()
  const theirs = nextKey()
  append(mine, agentMessage('mine'))
  append(theirs, agentMessage('theirs'))
  await flushSessionEvents()

  await clearSessionEvents(theirs)
  assert.deepEqual(await texts(theirs), [])
  assert.deepEqual(await texts(mine), ['mine'])
})

const positionsOf = async (key: string, subagentId = SESSION_LOG) =>
  (
    await db
      .select({ position: agentSessionEvent.position })
      .from(agentSessionEvent)
      .where(and(eq(agentSessionEvent.sessionKey, key), eq(agentSessionEvent.subagentId, subagentId)))
      .orderBy(asc(agentSessionEvent.position))
  ).map((row) => row.position)

test('a retired key starts numbering again, rather than resuming where it left off', async () => {
  // The cached next-position has to go with the rows. Kept, the first event of
  // the new transcript would sort after a history that no longer exists.
  const key = nextKey()
  append(key, { kind: 'user', text: 'old' })
  await flushSessionEvents()
  await retireSessionTranscript(key)
  append(key, agentMessage('new'), `${key}#next`)
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [0])
})

test('a session started under a cleared key numbers past what its search index names', async () => {
  // The index keeps the conversation's history through the clear, so a
  // position numbered again would alias one of its rows.
  const key = nextKey()
  append(key, { kind: 'user', text: 'kept in search' })
  append(key, turnEnd)
  await flushSessionEvents()
  await clearSessionEvents(key)
  append(key, agentMessage('after the clear'), `${key}#next`)
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [2])
})

test('a session that writes again from its start after a clear, as a replay does, numbers past what the key held', async () => {
  // A harness replay reuses the session's id and its log starts over at 0, so
  // the bases that session wrote with before the clear must not carry over.
  const key = nextKey()
  append(key, { kind: 'user', text: 'kept in search' })
  append(key, turnEnd)
  await flushSessionEvents()
  await clearSessionEvents(key)
  recordLogWrite(key, key, { log: SESSION_LOG, position: 0, event: { kind: 'user', text: 'replayed' }, appended: true })
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [2])
})

test('numbering after a clear stays past the search index in a process that did not see the clear', async () => {
  const key = nextKey()
  // What a stopped process left: index rows up to position 49, no events.
  await db.insert(transcriptMessageCursor).values({ sessionKey: key, resumeFrom: 50, turn: 40, openSegment: 0 })
  append(key, agentMessage('first after a restart'))
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [50])
})

test('a restored session writes on from where its logs were read, a trimmed front included', async () => {
  const key = nextKey()
  await db.insert(agentSessionEvent).values([
    { sessionKey: key, position: 40, event: { kind: 'user', text: 'kept' } },
    {
      sessionKey: key,
      position: 41,
      event: { kind: 'subagent', subagent: { subagentSessionId: 'child-1', name: 'C' } },
    },
    { sessionKey: key, subagentId: 'child-1', position: 7, event: agentMessage('a step') },
  ])
  const read = await readSessionLogs(key)
  // A subagent's log is held from its own 0, so the positions below its first
  // stored row are held too, as entries that draw nothing.
  assert.equal(read.subagentLogs.get('child-1')?.length, 8)
  attachSessionLogs(key, 'restored', read.bases)
  // The engine's log is what was read: its next entries are 2 and 8.
  recordLogWrite(key, 'restored', {
    log: SESSION_LOG,
    position: 2,
    event: { kind: 'user', text: 'next' },
    appended: true,
  })
  recordLogWrite(key, 'restored', { log: 'child-1', position: 8, event: agentMessage('another'), appended: true })
  // And a rewrite of an entry it was seeded with lands on that entry's row.
  recordLogWrite(key, 'restored', {
    log: SESSION_LOG,
    position: 0,
    event: { kind: 'user', text: 'kept!' },
    appended: false,
  })
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [40, 41, 42])
  assert.deepEqual(await positionsOf(key, 'child-1'), [7, 8])
  assert.deepEqual((await readSessionLogs(key)).events[0], { kind: 'user', text: 'kept!' })
})

test('a session created from recorded logs takes the bases prepared for it, and only it', async () => {
  const key = nextKey()
  await db
    .insert(agentSessionEvent)
    .values([{ sessionKey: key, position: 12, event: { kind: 'user', text: 'carried' } }])
  const read = await readSessionLogs(key)
  prepareSessionLogs(key, read.bases)
  recordLogWrite(key, 'carrier', { log: SESSION_LOG, position: 1, event: turnEnd, appended: true })
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [12, 13])

  // A creation that failed withdraws them: the next session numbers past.
  prepareSessionLogs(key, new Map([[SESSION_LOG, 0]]))
  prepareSessionLogs(key, null)
  recordLogWrite(key, 'fresh', { log: SESSION_LOG, position: 0, event: agentMessage('fresh'), appended: true })
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [12, 13, 14])
})

test('a stored position is placed against the session log it belongs to', async () => {
  const key = nextKey()
  await db.insert(agentSessionEvent).values([
    { sessionKey: key, position: 10, event: { kind: 'user', text: 'asked' } },
    { sessionKey: key, position: 11, event: agentMessage('answered') },
  ])
  const read = await readSessionLogs(key)
  attachSessionLogs(key, 'placed', read.bases)
  assert.equal(await enginePositionOf(key, 'placed', 11), 1)
  assert.equal(await enginePositionOf(key, 'placed', 4), -6, 'below the log: before its first row')
  assert.equal(await enginePositionOf(key, 'unknown', 10), null, 'a session that never wrote here')
})

test("the history port reads a session's rows back in its own positions, buffered ones included", async () => {
  const key = nextKey()
  await db.insert(agentSessionEvent).values([
    { sessionKey: key, position: 20, event: { kind: 'user', text: 'one' } },
    { sessionKey: key, position: 21, event: agentMessage('answer one') },
    { sessionKey: key, position: 23, event: { kind: 'user', text: 'two' } },
  ])
  const read = await readSessionLogs(key)
  attachSessionLogs(key, 'ported', read.bases)
  recordLogWrite(key, 'ported', { log: SESSION_LOG, position: 4, event: agentMessage('buffered'), appended: true })

  assert.deepEqual(await sessionHistoryPort.read('ported', SESSION_LOG, 0, 10), [
    { position: 0, event: { kind: 'user', text: 'one' } },
    { position: 1, event: agentMessage('answer one') },
    { position: 3, event: { kind: 'user', text: 'two' } },
    { position: 4, event: agentMessage('buffered') },
  ])
  assert.equal(await sessionHistoryPort.turnStartBefore('ported', SESSION_LOG, 3), 0)
  assert.equal(await sessionHistoryPort.turnStartBefore('ported', SESSION_LOG, 4), 3)
  assert.equal(await sessionHistoryPort.turnStartBefore('ported', SESSION_LOG, 0), null)
  assert.equal(await sessionHistoryPort.end('ported', SESSION_LOG), 5)
  assert.equal(await sessionHistoryPort.end('ported', 'no-such-subagent'), 0)
})

test('an offline transcript reads as a log by position, a missing row standing as an entry that draws nothing', async () => {
  const key = nextKey()
  await db.insert(agentSessionEvent).values([
    { sessionKey: key, position: 5, event: { kind: 'user', text: 'one' } },
    { sessionKey: key, position: 7, event: turnEnd },
  ])
  const reader = await storedLogReader(key)
  assert.equal(reader.end, 3)
  assert.deepEqual(await reader.read(0, 3), {
    start: 0,
    events: [{ kind: 'user', text: 'one' }, { kind: 'queue', items: [] }, turnEnd],
  })
  assert.equal(await reader.turnStartBefore(3), 0)
})

test('a rename carries the whole recording onto the new key and leaves nothing behind', async () => {
  // Left behind, the conversation's history is unreachable under a name nothing
  // looks up again — and the next open silently falls back to the harness's
  // replay, which is exactly the loss the recording exists to prevent.
  const from = nextKey()
  const to = nextKey()
  append(from, agentMessage('first'))
  append(from, agentMessage('second'))
  recordLogWrite(from, from, { log: 'child-1', position: 0, event: agentMessage('a step'), appended: true })

  await moveSessionEvents([{ from, to }])

  assert.deepEqual(await texts(to), ['first', 'second'])
  assert.deepEqual(await positionsOf(to, 'child-1'), [0])
  assert.deepEqual(await texts(from), [])
})

test('a rename carries a tail that was still buffered when it ran', async () => {
  const from = nextKey()
  const to = nextKey()
  append(from, agentMessage('buffered'))
  await moveSessionEvents([{ from, to }])
  assert.deepEqual(await texts(to), ['buffered'])
})

// A long conversation: `turns` turns of a question, `replies` reply entries
// and an end, the first turn opening with the session's modes.
function longConversation(turns: number, replies: number): ChatEvent[] {
  const events: ChatEvent[] = [{ kind: 'modes', available: [{ id: 'ask', name: 'Ask' }], current: 'ask' }]
  for (let t = 0; t < turns; t++) {
    events.push({ kind: 'user', text: `question ${t}` })
    for (let r = 0; r < replies; r++) {
      events.push({ kind: 'tool_call', toolCallId: `t${t}-${r}`, title: 'ls', status: 'completed' })
    }
    events.push(turnEnd)
  }
  return events
}

test('with the settings off nothing is trimmed: a log far past 2000 entries keeps every one', async () => {
  const key = nextKey()
  const events = longConversation(30, 98)
  await recordConversation(key, events)
  assert.equal((await positionsOf(key)).length, events.length)
  assert.ok(events.length > 3000, 'precondition: well past the tail a reopen reads')
  // Nothing is trimmed by a sweep either.
  assert.deepEqual(await sweepHistory(), { sessions: 0 })
  assert.equal((await positionsOf(key)).length, events.length)
})

test('a reopen reads the tail from a turn start, with the state below it and the turns it leaves out counted', async () => {
  const key = nextKey()
  const events = longConversation(30, 98)
  await recordConversation(key, events)
  const read = await readSessionLogs(key)
  // Each turn is 100 entries after the opening modes: the tail starts at the
  // newest question leaving at least 2000 entries, 11 turns in.
  assert.equal(read.start, 1 + 10 * 100)
  assert.equal(read.turnsBefore, 10)
  assert.deepEqual(read.events[0], { kind: 'user', text: 'question 10' })
  assert.equal(read.events.length, events.length - read.start)
  assert.deepEqual(read.before, [{ position: 0, event: events[0] }], 'the modes come from below the tail')
  assert.deepEqual([...read.bases], [[SESSION_LOG, 0]])
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
  append(key, { kind: 'user', text: 'where is the config' })
  append(key, agentMessage('In the con'))
  await flushSessionEvents()
  append(key, agentMessage('fig folder.'))
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [message(0, 'user', 0, 'where is the config')])

  append(key, turnEnd)
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'where is the config'),
    message(1, 'agent', 0, 'In the config folder.'),
  ])
})

test('a reply that grows in place across batches is indexed once, whole', async () => {
  const key = nextKey()
  const session = compacting(key)
  session.emit({ kind: 'user', text: 'where is the config' })
  session.emit(agentMessage('In the con'))
  await flushSessionEvents()
  session.emit(agentMessage('fig '))
  await flushSessionEvents()
  session.emit({ kind: 'tool_call', toolCallId: 't1', title: 'ls', status: 'pending' })
  session.emit(agentMessage('folder.'))
  session.emit(turnEnd)
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'where is the config'),
    message(1, 'agent', 0, 'In the config folder.'),
  ])
})

test('a reply that grows in place past a segment is indexed whole, live and when a stopped process left it', async () => {
  const key = nextKey()
  const session = compacting(key)
  const words = Array.from({ length: (3 * SEGMENT_CHARS) / 8 }, (_, i) => ` w${i.toString(36).padStart(5, '0')}`)
  session.emit({ kind: 'user', text: 'write it out' })
  const half = words.length / 2
  for (const word of words.slice(0, half)) {
    session.emit(agentMessage(word))
  }
  await flushSessionEvents()
  // A process that stops here keeps only what it wrote; the next one reads
  // the rest of the entry back from its row.
  const stopped = nextKey()
  await db
    .insert(agentSessionEvent)
    .values((await storedEvents(key)).map((event, position) => ({ sessionKey: stopped, position, event })))
  const [cursor] = await db.select().from(transcriptMessageCursor).where(eq(transcriptMessageCursor.sessionKey, key))
  assert.ok(cursor && cursor.resumeChars > 0, 'precondition: rows were written from inside the entry')
  await db.insert(transcriptMessageCursor).values({ ...cursor, sessionKey: stopped })
  await db
    .insert(transcriptMessage)
    .values((await messages(key)).map((row) => ({ sessionKey: stopped, ...row, createdAt: new Date() })))

  for (const word of words.slice(half)) {
    session.emit(agentMessage(word))
  }
  session.emit(turnEnd)
  await flushSessionEvents()
  const reply = async (k: string) =>
    (await messages(k))
      .filter((row) => row.role === 'agent')
      .map((row) => row.text)
      .join('')
  assert.equal(await reply(key), words.join(''))

  await catchUpTranscriptIndex()
  assert.equal(await reply(stopped), words.slice(0, half).join(''), 'the stopped one ends where its row does, once')
})

test('retiring a session clears its index, its cursor and the reply it held', async () => {
  const key = nextKey()
  append(key, { kind: 'user', text: 'gone soon' })
  append(key, agentMessage('held, never ended'))
  await flushSessionEvents()

  await retireSessionTranscript(key)
  assert.deepEqual(await messages(key), [])
  assert.deepEqual(
    await db.select().from(transcriptMessageCursor).where(eq(transcriptMessageCursor.sessionKey, key)),
    [],
  )

  const next = `${key}#next`
  append(key, agentMessage('a new start'), next)
  append(key, turnEnd, next)
  await flushSessionEvents()
  assert.deepEqual(await messages(key), [message(0, 'agent', 0, 'a new start')])
})

test('clearing the events of a conversation that lives on keeps its search index', async () => {
  const key = nextKey()
  append(key, { kind: 'user', text: 'still searchable' })
  append(key, turnEnd)
  await flushSessionEvents()
  await clearSessionEvents(key)
  assert.deepEqual(await messages(key), [message(0, 'user', 0, 'still searchable')])
})

// A conversation recorded through the store by one engine session, every
// event its own entry.
async function recordConversation(key: string, events: ChatEvent[], session = key): Promise<ChatEvent[]> {
  for (const event of events) {
    append(key, event, session)
  }
  // A read waits out every batch already chained for the key, which a flush
  // of what is still buffered does not.
  await storedLogReader(key)
  return events
}

const turnOf = (question: string, answer: string): ChatEvent[] => [
  { kind: 'user', text: question },
  agentMessage(answer),
  turnEnd,
]

test('an edit cuts the recording at the edited turn, keeps what lies below the fork where it is, and keeps it searchable', async () => {
  const key = nextKey()
  // Positions: the oldest turn 0-2, below what the fork holds; then the kept
  // turn 3-5, the edited turn 6-8 and a later one 9-11.
  const log = await recordConversation(key, [
    ...turnOf('oldest question', 'oldest answer'),
    ...turnOf('kept question', 'kept answer'),
    ...turnOf('edited question', 'edited-away answer'),
    ...turnOf('later question', 'later answer'),
  ])
  const kept = 3
  const edited = 6

  // The fork holds the history from the kept turn up to the edited one.
  const fork = `${key}#fork`
  await rerecordEditedSession(key, key, edited, {
    sessionId: fork,
    start: kept,
    events: log.slice(kept, edited),
    subagentLogs: new Map(),
  })
  nextOf.set(fork, edited)
  await recordConversation(key, turnOf('the edited question', 'a new answer'), fork)

  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'oldest question'),
    message(1, 'agent', 0, 'oldest answer'),
    message(kept, 'user', kept, 'kept question'),
    message(kept + 1, 'agent', kept, 'kept answer'),
    message(edited, 'user', edited, 'the edited question'),
    message(edited + 1, 'agent', edited, 'a new answer'),
  ])
  // The recording is the history below the edit, untouched, and then the new
  // turn where the edited one stood.
  assert.deepEqual(await texts(key), [
    'user',
    'oldest answer',
    'turn_end',
    'user',
    'kept answer',
    'turn_end',
    'user',
    'a new answer',
    'turn_end',
  ])
  assert.deepEqual(await positionsOf(key), [0, 1, 2, 3, 4, 5, 6, 7, 8])
})

test('an edit drops the logs of the subagents spawned from the edited turn on, theirs included, and keeps the rest', async () => {
  const key = nextKey()
  const spawn = (id: string): ChatEvent => ({
    kind: 'subagent',
    subagent: { subagentSessionId: id, name: id, task: id },
  })
  const log = await recordConversation(key, [
    { kind: 'user', text: 'first' },
    spawn('kept-child'),
    turnEnd,
    { kind: 'user', text: 'second' },
    spawn('gone-child'),
    turnEnd,
  ])
  recordLogWrite(key, key, { log: 'kept-child', position: 0, event: agentMessage('kept step'), appended: true })
  recordLogWrite(key, key, { log: 'gone-child', position: 0, event: spawn('gone-grandchild'), appended: true })
  recordLogWrite(key, key, { log: 'gone-grandchild', position: 0, event: agentMessage('gone'), appended: true })

  await rerecordEditedSession(key, key, 3, {
    sessionId: `${key}#fork`,
    start: 0,
    events: log.slice(0, 3),
    subagentLogs: new Map(),
  })

  assert.deepEqual(
    (await storedEvents(key)).map((event) => event.kind),
    ['user', 'subagent', 'turn_end'],
  )
  assert.deepEqual(await positionsOf(key, 'kept-child'), [0], 'kept where it was, though the fork does not hold it')
  assert.deepEqual(await positionsOf(key, 'gone-child'), [])
  assert.deepEqual(await positionsOf(key, 'gone-grandchild'), [])
})

test('a fork into a new key records its logs there from the start, and indexes them', async () => {
  const key = nextKey()
  await recordForkedSession(key, {
    sessionId: `${key}#fork`,
    start: 0,
    events: turnOf('forked question', 'forked answer'),
    subagentLogs: new Map([['child-1', [agentMessage('a step')]]]),
  })
  assert.deepEqual(await positionsOf(key), [0, 1, 2])
  assert.deepEqual(await positionsOf(key, 'child-1'), [0])
  assert.deepEqual(await messages(key), [
    message(0, 'user', 0, 'forked question'),
    message(1, 'agent', 0, 'forked answer'),
  ])
  // The fork writes on after what it was seeded with.
  recordLogWrite(key, `${key}#fork`, { log: SESSION_LOG, position: 3, event: agentMessage('more'), appended: true })
  await flushSessionEvents()
  assert.deepEqual(await positionsOf(key), [0, 1, 2, 3])
})

test('a fork holding only the tail of its history gets the rest copied from its source, subagent logs and search included', async () => {
  const source = nextKey()
  const spawn = (id: string, state?: string): ChatEvent => ({
    kind: 'subagent',
    subagent: { subagentSessionId: id, name: id, task: id, ...(state ? { state } : {}) },
  })
  // The source's recording, from 10: an old turn with a subagent, then the
  // turn the fork holds, then one past the fork point with a subagent too.
  await db
    .insert(agentSessionEvent)
    .values(
      [
        { kind: 'user', text: 'old question' } as ChatEvent,
        spawn('old-child', 'completed'),
        turnEnd,
        { kind: 'user', text: 'held question' } as ChatEvent,
        turnEnd,
        { kind: 'user', text: 'past the fork' } as ChatEvent,
        spawn('later-child'),
      ].map((event, offset) => ({ sessionKey: source, position: 10 + offset, event })),
    )
  await db.insert(agentSessionEvent).values([
    { sessionKey: source, subagentId: 'old-child', position: 0, event: agentMessage('old step') },
    { sessionKey: source, subagentId: 'later-child', position: 0, event: agentMessage('later step') },
  ])
  attachSessionLogs(source, 'source', (await readSessionLogs(source)).bases)

  const key = nextKey()
  await recordForkedSession(
    key,
    {
      sessionId: `${key}#fork`,
      start: 3,
      events: turnOf('held question', 'held answer').slice(0, 2),
      subagentLogs: new Map(),
    },
    { sessionKey: source, sessionId: 'source' },
  )
  assert.deepEqual(
    (await storedEvents(key)).map((event) => (event.kind === 'user' ? event.text : event.kind)),
    ['old question', 'subagent', 'turn_end', 'held question', 'agent_message'],
  )
  assert.deepEqual(await positionsOf(key), [0, 1, 2, 3, 4])
  assert.deepEqual(await positionsOf(key, 'old-child'), [0])
  assert.deepEqual(await positionsOf(key, 'later-child'), [], 'spawned past the fork point')
  assert.deepEqual(
    (await messages(key)).map((row) => [row.position, row.text]),
    [
      [0, 'old question'],
      [3, 'held question'],
    ],
  )
})

test('a fork of a reopened session keeps the logs of finished subagents spawned before its end, and drops the later ones', async () => {
  const source = nextKey()
  const spawn = (id: string, state?: string): ChatEvent => ({
    kind: 'subagent',
    subagent: { subagentSessionId: id, name: id, task: id, ...(state ? { state } : {}) },
  })
  await db
    .insert(agentSessionEvent)
    .values(
      [
        { kind: 'user', text: 'delegate' } as ChatEvent,
        spawn('done-child', 'completed'),
        turnEnd,
        { kind: 'user', text: 'delegate again' } as ChatEvent,
        spawn('later-child', 'completed'),
        turnEnd,
      ].map((event, position) => ({ sessionKey: source, position, event })),
    )
  await db.insert(agentSessionEvent).values([
    { sessionKey: source, subagentId: 'done-child', position: 0, event: agentMessage('done step') },
    { sessionKey: source, subagentId: 'later-child', position: 0, event: agentMessage('later step') },
  ])
  // What a reopen seeds: the whole short log, and no log of a finished subagent.
  const reopened = await readSessionLogs(source)
  assert.equal(reopened.start, 0, 'precondition: the whole log is held')
  assert.equal(reopened.subagentLogs.size, 0, 'precondition: finished subagents are not seeded')
  attachSessionLogs(source, 'source', reopened.bases)

  // Forked at the second turn: the first is kept, the second dropped.
  const key = nextKey()
  await recordForkedSession(
    key,
    { sessionId: `${key}#fork`, start: 0, events: reopened.events.slice(0, 3), subagentLogs: reopened.subagentLogs },
    { sessionKey: source, sessionId: 'source' },
  )
  assert.deepEqual(await positionsOf(key), [0, 1, 2])
  assert.deepEqual(await positionsOf(key, 'done-child'), [0])
  assert.deepEqual(await positionsOf(key, 'later-child'), [], 'spawned at the fork point')
})

test('a harness replay into a cleared recording leaves the search index as it was', async () => {
  const key = nextKey()
  const history = await recordConversation(key, [
    ...turnOf('asked once', 'answered once'),
    ...turnOf('asked twice', 'answered twice'),
  ])
  const before = await messages(key)

  await clearSessionEvents(key)
  const replaying = `${key}#replay`
  await recordReplay(key, async () => {
    for (const event of history) {
      append(key, event, replaying)
    }
    append(key, { kind: 'turn_end', stopReason: 'replayed' }, replaying)
  })
  assert.deepEqual(await messages(key), before)

  // What comes after the replay is indexed, numbered past it.
  await recordConversation(key, turnOf('asked after', 'answered after'), replaying)
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
      append(key, event)
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
  append(from, { kind: 'user', text: 'travelling' })
  append(from, agentMessage('half of '))
  await flushSessionEvents()

  await moveSessionEvents([{ from, to }])
  append(to, agentMessage('the answer'), from)
  append(to, turnEnd, from)
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
    append(live, event)
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
  append(key, agentMessage('a time.'))
  append(key, turnEnd)
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
  append(key, { kind: 'user', text: 'go on' })
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
  append(key, agentMessage(' and new'))
  append(key, turnEnd)
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
  append(key, { kind: 'user', text: 'first' })
  await flushSessionEvents()
  // A constraint the index rows of one batch break, standing in for any
  // failure of the index write.
  await db.execute(sql`alter table "TranscriptMessage" add constraint "test_refuse_text" check ("text" <> 'refused')`)
  try {
    append(key, { kind: 'user', text: 'refused' })
    append(key, agentMessage('the reply '))
    await flushSessionEvents()
  } finally {
    await db.execute(sql`alter table "TranscriptMessage" drop constraint "test_refuse_text"`)
  }
  append(key, agentMessage('goes on'))
  append(key, turnEnd)
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
  append(key, { kind: 'user', text: 'write it all out' })
  for (const chunk of chunks) {
    append(key, agentMessage(chunk))
  }
  append(key, turnEnd)
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

// ── The history settings ──────────────────────────────────────────────────

// Each test sets what it needs and leaves the settings off for the rest.
async function withRetention(
  retention: { maxEntries: number | null; cleanupAfterDays: number | null },
  run: () => Promise<void>,
): Promise<void> {
  setHistoryRetention(retention)
  try {
    await run()
  } finally {
    setHistoryRetention({ maxEntries: null, cleanupAfterDays: null })
  }
}

test('a limit keeps the newest entries as the log grows, cutting at a turn start, with what was cut from search', async () => {
  const key = nextKey()
  await withRetention({ maxEntries: 7, cleanupAfterDays: null }, async () => {
    await recordConversation(key, [
      ...turnOf('one', 'a'),
      ...turnOf('two', 'b'),
      ...turnOf('three', 'c'),
      ...turnOf('four', 'd'),
    ])
    // Twelve entries; the newest seven start inside turn two, so it goes
    // whole and turns three and four (six entries) stay.
    assert.deepEqual(await positionsOf(key), [6, 7, 8, 9, 10, 11])
    assert.deepEqual(
      (await messages(key)).map((row) => row.text),
      ['three', 'c', 'four', 'd'],
    )
  })
})

test('a limit smaller than the newest turn still keeps that turn whole', async () => {
  const key = nextKey()
  await withRetention({ maxEntries: 1, cleanupAfterDays: null }, async () => {
    await recordConversation(key, [...turnOf('old', 'a'), ...turnOf('newest', 'b')])
    assert.deepEqual(await positionsOf(key), [3, 4, 5])
  })
})

test('a cleanup period removes the turns that started before it, by the sweep, and the subagent logs spawned there', async () => {
  const key = nextKey()
  const day = 24 * 60 * 60 * 1000
  const now = new Date('2026-06-30T12:00:00Z')
  const at = (daysAgo: number) => new Date(now.getTime() - daysAgo * day)
  await db.insert(agentSessionEvent).values([
    { sessionKey: key, position: 0, event: { kind: 'user', text: 'forty days ago' }, createdAt: at(40) },
    {
      sessionKey: key,
      position: 1,
      event: { kind: 'subagent', subagent: { subagentSessionId: 'old-child', name: 'x', state: 'completed' } },
      createdAt: at(40),
    },
    { sessionKey: key, position: 2, event: { kind: 'user', text: 'ten days ago' }, createdAt: at(10) },
    { sessionKey: key, position: 3, event: turnEnd, createdAt: at(10) },
    { sessionKey: key, subagentId: 'old-child', position: 0, event: agentMessage('old step'), createdAt: at(40) },
  ])
  await withRetention({ maxEntries: null, cleanupAfterDays: 30 }, async () => {
    const swept = await sweepHistory(now)
    assert.ok(swept.sessions >= 1)
  })
  assert.deepEqual(await positionsOf(key), [2, 3])
  assert.deepEqual(await positionsOf(key, 'old-child'), [])
})

test('a cleanup period older than every turn keeps the newest one', async () => {
  const key = nextKey()
  const now = new Date('2026-06-30T12:00:00Z')
  const old = new Date('2026-01-01T00:00:00Z')
  await db.insert(agentSessionEvent).values([
    { sessionKey: key, position: 0, event: { kind: 'user', text: 'old' }, createdAt: old },
    { sessionKey: key, position: 1, event: { kind: 'user', text: 'newest, still old' }, createdAt: old },
    { sessionKey: key, position: 2, event: turnEnd, createdAt: old },
  ])
  await withRetention({ maxEntries: null, cleanupAfterDays: 1 }, async () => {
    await sweepHistory(now)
  })
  assert.deepEqual(await positionsOf(key), [1, 2])
})

test('settings cleared while a sweep runs leave the keys it has not reached untouched', async () => {
  const now = new Date('2000-03-01T00:00:00Z')
  const old = new Date('2000-01-01T00:00:00Z')
  const keys = [nextKey(), nextKey()]
  for (const key of keys) {
    await db.insert(agentSessionEvent).values([
      { sessionKey: key, position: 0, event: { kind: 'user', text: 'old' }, createdAt: old },
      { sessionKey: key, position: 1, event: { kind: 'user', text: 'newest, still old' }, createdAt: old },
      { sessionKey: key, position: 2, event: turnEnd, createdAt: old },
    ])
  }
  // The settings are cleared as the sweep's first trim deletes: only rows of
  // these keys are older than its cleanup period.
  const own = Object.hasOwn(db, 'delete')
  const original = db.delete
  let deletes = 0
  db.delete = ((...args: Parameters<typeof db.delete>) => {
    deletes += 1
    setHistoryRetention({ maxEntries: null, cleanupAfterDays: null })
    return original.apply(db, args)
  }) as typeof db.delete
  try {
    await withRetention({ maxEntries: null, cleanupAfterDays: 30 }, async () => {
      await sweepHistory(now)
    })
  } finally {
    if (own) {
      db.delete = original
    } else {
      Reflect.deleteProperty(db, 'delete')
    }
  }
  assert.ok(deletes > 0, 'precondition: the sweep trimmed a key')
  const kept = await Promise.all(keys.map((key) => positionsOf(key)))
  assert.deepEqual(
    kept.map((positions) => positions.length).sort(),
    [2, 3],
    'one key trimmed before the settings were cleared, the other untouched',
  )
})

test('clearing the settings stops the trimming', async () => {
  const key = nextKey()
  await withRetention({ maxEntries: 3, cleanupAfterDays: null }, async () => {
    await recordConversation(key, [...turnOf('one', 'a'), ...turnOf('two', 'b')])
  })
  assert.deepEqual(await positionsOf(key), [3, 4, 5])
  nextOf.set(key, 6)
  await recordConversation(key, [...turnOf('three', 'c'), ...turnOf('four', 'd')])
  assert.deepEqual(await positionsOf(key), [3, 4, 5, 6, 7, 8, 9, 10, 11])
})
