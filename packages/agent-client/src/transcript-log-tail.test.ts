import assert from 'node:assert/strict'
import test from 'node:test'

import { arrayLogReader, pageBeforeByRecords, recordsWindowFromReader, tailByRecords, turnAtFromReader } from './pagination'
import { SESSION_LOG, TranscriptLog } from './transcript-log'
import type { ChatEvent } from './types'

// A log held from a start past 0, letting go of its front, and the reader
// paging that serves a log so held.

const user = (text: string): ChatEvent => ({ kind: 'user', text })
const end: ChatEvent = { kind: 'turn_end', stopReason: 'end_turn' }
const spawn = (id: string, state?: string): ChatEvent => ({
  kind: 'subagent',
  subagent: { subagentSessionId: id, name: id, task: id, ...(state ? { state } : {}) },
})
const step = (id: string, event: ChatEvent): ChatEvent => ({ kind: 'subagent_event', subagentSessionId: id, event })

test("a log held from a start numbers its writes by the log's positions", () => {
  const log = new TranscriptLog([user('held'), end], new Map(), { start: 40 })
  const [write] = log.append(user('next'))
  assert.equal(write?.position, 42)
  assert.equal(log.start(), 40)
  assert.deepEqual(log.entries()?.at(-1), user('next'))
})

test('an entity placed below the start is rewritten where it stands, and a known snapshot is not appended again', () => {
  const modes: ChatEvent = { kind: 'modes', available: [{ id: 'ask', name: 'Ask' }], current: 'ask' }
  const log = new TranscriptLog([user('held')], new Map(), {
    start: 10,
    before: [
      { position: 2, event: modes },
      { position: 3, event: spawn('worker') },
    ],
  })
  assert.deepEqual(log.append(modes), [], 'the same snapshot adds nothing')
  const writes = log.append(step('worker', { kind: 'agent_message', text: 'working' }))
  assert.deepEqual(
    writes.map((write) => [write.log, write.position, write.appended]),
    [
      ['worker', 0, true],
      [SESSION_LOG, 3, false],
    ],
    "the step, then the header's new count where the header stands",
  )
  assert.equal(writes[1]?.event.kind === 'subagent' ? writes[1].event.subagent.steps : null, 1)
  const [done] = log.append(spawn('worker', 'completed'))
  assert.equal(done?.position, 3, 'its newest state rewrites the same entry')
  assert.equal(log.entries()?.length, 1, 'nothing below the start is held')
})

test("evicting lets go of the front, the finished subagents' logs with it, and keeps a running one's", () => {
  const log = new TranscriptLog()
  log.append(user('first'))
  log.append(spawn('finished'))
  log.append(step('finished', { kind: 'agent_message', text: 'done' }))
  log.append(spawn('finished', 'completed'))
  log.append(spawn('running'))
  log.append(step('running', { kind: 'agent_message', text: 'a' }))
  log.append(end)
  log.append(user('second'))
  log.evictBefore(4)
  assert.equal(log.start(), 4)
  assert.equal(log.entries()?.length, 1)
  assert.equal(log.entries('finished'), undefined)
  assert.ok(log.entries('running'))
  // The running subagent's header was let go of too, and is still rewritten.
  const writes = log.append(step('running', { kind: 'tool_call', toolCallId: 'c', title: 'ls', status: 'pending' }))
  assert.deepEqual(
    writes.map((write) => [write.log, write.position]),
    [
      ['running', 1],
      [SESSION_LOG, 2],
    ],
  )
  assert.equal(writes[1]?.event.kind === 'subagent' ? writes[1].event.subagent.steps : null, 2)
})

test('the subagents spawned from a position on, and theirs, are what a cut there drops', () => {
  const log = new TranscriptLog()
  log.append(user('first'))
  log.append(spawn('early'))
  log.append(user('second'))
  log.append(spawn('late'))
  log.append(step('late', spawn('grandchild')))
  assert.deepEqual([...log.subagentsFrom(2)].sort(), ['grandchild', 'late'])
})

// A long log of turns with tool calls in them, each a record.
function longLog(): ChatEvent[] {
  const events: ChatEvent[] = []
  for (let t = 0; t < 120; t++) {
    events.push(user(`q${t}`))
    for (let c = 0; c < 7; c++) {
      events.push({ kind: 'tool_call', toolCallId: `${t}.${c}`, title: 'ls', status: 'completed' })
    }
    events.push(end)
  }
  return events
}

test('records windows from a reader are the windows of the log held whole, page by page', async () => {
  const events = longLog()
  const reader = arrayLogReader(events)
  const tail = await recordsWindowFromReader(reader, { records: 20 })
  assert.deepEqual(tail, tailByRecords(events, 20))
  let before = tail.startIndex
  while (before > 0) {
    const page = await recordsWindowFromReader(reader, { beforeIndex: before, records: 30 })
    assert.deepEqual(page, pageBeforeByRecords(events, before, 30))
    before = page.startIndex
  }
})

test('records windows from a reader of a log held from a start carry the log positions', async () => {
  const events = longLog()
  const reader = arrayLogReader(events, 500)
  const tail = await recordsWindowFromReader(reader, { records: 20 })
  assert.equal(tail.startIndex, tailByRecords(events, 20).startIndex + 500)
})

test('the turn holding a position is read from its question to the next', async () => {
  const events = longLog()
  const reader = arrayLogReader(events)
  const turn = await turnAtFromReader(reader, 13)
  assert.equal(turn?.startIndex, 9)
  assert.equal(turn?.events.length, 9)
  assert.equal(turn?.last, false)
  const last = await turnAtFromReader(reader, events.length - 1)
  assert.equal(last?.last, true)
  assert.equal(await turnAtFromReader(reader, events.length), null)
})
