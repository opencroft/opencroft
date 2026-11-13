// The rewrite of a key's rows into the compacted layout, without a database:
// what the rows become, where each old position goes, and that a reader draws
// the same conversation from the rewritten logs as from the rows before.
import assert from 'node:assert/strict'
import test from 'node:test'

import { foldEvents } from 'agent-client/fold'
import { SESSION_LOG } from 'agent-client/transcript-log'
import type { ChatEvent } from 'agent-client/types'

import { LogRewriter, type LogRow } from './session-log-rewrite'

const say = (text: string, messageId = 'm1'): ChatEvent => ({ kind: 'agent_message', text, messageId })
const ask = (text: string): ChatEvent => ({ kind: 'user', text })
const turnEnd: ChatEvent = { kind: 'turn_end', stopReason: 'end_turn' }
const call = (toolCallId: string): ChatEvent => ({ kind: 'tool_call', toolCallId, title: 'Read', status: 'pending' })
const update = (toolCallId: string, fields: { status?: string; output?: string }): ChatEvent => ({
  kind: 'tool_update',
  toolCallId,
  ...fields,
})
const spawn = (subagentSessionId: string, state?: string): ChatEvent => ({
  kind: 'subagent',
  subagent: { subagentSessionId, name: 'Worker', task: 'dig', ...(state ? { state } : {}) },
})
const step = (subagentSessionId: string, event: ChatEvent): ChatEvent => ({
  kind: 'subagent_event',
  subagentSessionId,
  event,
})

// Rows of one log as stored, from `start`, a second apart.
function rowsOf(events: ChatEvent[], start = 0, subagentId = SESSION_LOG): LogRow[] {
  return events.map((event, offset) => ({
    subagentId,
    position: start + offset,
    event,
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, start + offset)),
  }))
}

function rewrite(own: LogRow[], subagents: LogRow[] = []) {
  const rewriter = new LogRewriter()
  for (const row of own) {
    rewriter.addOwn(row)
  }
  for (const row of subagents) {
    rewriter.addSubagent(row)
  }
  return rewriter.finish()
}

const logOf = (rows: LogRow[], id: string) => rows.filter((row) => row.subagentId === id)
const eventsOf = (rows: LogRow[], id: string) => logOf(rows, id).map((row) => row.event)

// What a reader draws from a log, ids aside: a compacted log has fewer
// entries, never different messages.
function drawn(events: ChatEvent[]) {
  return foldEvents(events).map(({ id: _id, ...message }) => message)
}

// A turn as the old layout stored it: one row per event, a subagent's steps
// wrapped in the session's own log, repeated readings and snapshots.
const OLD_TURN: ChatEvent[] = [
  ask('look into it'),
  { kind: 'available_commands', commands: [] },
  say('On '),
  say('it.'),
  call('t1'),
  update('t1', { status: 'in_progress' }),
  update('t1', { status: 'completed', output: 'files' }),
  spawn('child-1'),
  step('child-1', say('dig', 'c1')),
  step('child-1', say('ging', 'c1')),
  step('child-1', call('t2')),
  spawn('child-1', 'completed'),
  { kind: 'usage', used: 10, size: 100 },
  { kind: 'available_commands', commands: [] },
  { kind: 'usage', used: 20, size: 100 },
  turnEnd,
]

test('an old-layout log is compacted, its subagent steps moved to their own log, and draws the same', () => {
  const { rows } = rewrite(rowsOf(OLD_TURN))
  const own = eventsOf(rows, SESSION_LOG)
  assert.deepEqual(own, [
    ask('look into it'),
    { kind: 'available_commands', commands: [] },
    say('On it.'),
    call('t1'),
    update('t1', { status: 'completed', output: 'files' }),
    {
      kind: 'subagent',
      subagent: { subagentSessionId: 'child-1', name: 'Worker', task: 'dig', state: 'completed', steps: 2 },
    },
    { kind: 'usage', used: 20, size: 100 },
    turnEnd,
  ])
  assert.deepEqual(eventsOf(rows, 'child-1'), [say('digging', 'c1'), call('t2')])
  assert.deepEqual(
    logOf(rows, 'child-1').map((row) => row.position),
    [0, 1],
  )
  // The session's own conversation draws what the old rows drew; the subagent's section
  // now draws from its own log, and draws what its wrapped steps did.
  assert.deepEqual(drawn(own), drawn(OLD_TURN))
  const unwrapped = OLD_TURN.flatMap((event) => (event.kind === 'subagent_event' ? [event.event] : []))
  assert.deepEqual(drawn(eventsOf(rows, 'child-1')), drawn(unwrapped))
})

test("positions are renumbered from the log's first stored row, so what lies below it keeps its own", () => {
  // The old cap left this log starting at 500.
  const { rows, remap } = rewrite(rowsOf(OLD_TURN, 500))
  assert.deepEqual(
    logOf(rows, SESSION_LOG).map((row) => row.position),
    [500, 501, 502, 503, 504, 505, 506, 507],
  )
  assert.equal(remap(499), 499)
  assert.equal(remap(0), 0)
})

test('each old position maps to the entry it went into, or the next entry added after it', () => {
  const { remap } = rewrite(rowsOf(OLD_TURN, 500))
  // The question and the reply's first chunk keep their entries; the second
  // chunk went into the first.
  assert.equal(remap(500), 500)
  assert.equal(remap(502), 502)
  assert.equal(remap(503), 502)
  // The second update merged into the first.
  assert.equal(remap(506), 504)
  // The header's later state lands back on the header.
  assert.equal(remap(511), 505)
  // A subagent's step went to its own log: the next entry added after it is
  // the usage reading, not the header rewritten in between.
  assert.equal(remap(508), 506)
  // A snapshot equal to the one before was dropped, and the reading after it
  // merged: the next entry added is the turn's end.
  assert.equal(remap(513), 507)
  assert.equal(remap(515), 507)
  // Past the old end, moved down by as much as the log shrank (16 rows to 8).
  assert.equal(remap(516), 508)
  assert.equal(remap(520), 512)
})

test('a gap in the old positions maps to the next entry added', () => {
  const own = [...rowsOf([ask('one'), turnEnd], 10), ...rowsOf([ask('two'), turnEnd], 20)]
  const { rows, remap } = rewrite(own)
  assert.deepEqual(
    logOf(rows, SESSION_LOG).map((row) => [row.position, row.event.kind]),
    [
      [10, 'user'],
      [11, 'turn_end'],
      [12, 'user'],
      [13, 'turn_end'],
    ],
  )
  assert.equal(remap(15), 12)
  assert.equal(remap(20), 12)
})

test('an entry keeps the time of the first row merged into it', () => {
  const { rows } = rewrite(rowsOf([ask('go'), say('a'), say('b'), say('c')], 0))
  const reply = logOf(rows, SESSION_LOG)[1]
  assert.equal(reply?.createdAt.toISOString(), '2026-01-01T00:00:01.000Z')
})

test("a subagent log already compacted follows the steps its subagent left in the session's log", () => {
  // Recorded across the change: two steps wrapped in the session's log, then
  // the rest in the subagent's own log, with the header counting only those.
  const own = rowsOf([
    ask('delegate'),
    spawn('child-1'),
    step('child-1', say('one ', 'c1')),
    step('child-1', call('t1')),
  ])
  const later = rowsOf(
    [say('two', 'c2'), call('t2'), update('t2', { status: 'completed' }), update('t2', { output: 'x' })],
    0,
    'child-1',
  )
  const { rows } = rewrite(own, later)
  assert.deepEqual(eventsOf(rows, 'child-1'), [
    say('one ', 'c1'),
    call('t1'),
    say('two', 'c2'),
    call('t2'),
    update('t2', { status: 'completed', output: 'x' }),
  ])
  const header = eventsOf(rows, SESSION_LOG)[1]
  assert.equal(header?.kind === 'subagent' ? header.subagent.steps : null, 4)
})

test('a compacted log comes out as it went in', () => {
  const { rows: once } = rewrite(rowsOf(OLD_TURN, 40))
  const { rows: twice, remap } = rewrite(
    logOf(once, SESSION_LOG),
    once.filter((row) => row.subagentId !== SESSION_LOG),
  )
  assert.deepEqual(twice, once)
  assert.equal(remap(43), 43)
})

test('a subagent whose spawn was cut keeps its steps, with no header for them', () => {
  // The cap cut the turn's start, the spawn with it.
  const own = rowsOf([step('lost', say('mid', 'l1')), step('lost', say('way', 'l1')), turnEnd], 900)
  const { rows } = rewrite(own)
  assert.deepEqual(eventsOf(rows, SESSION_LOG), [turnEnd])
  assert.deepEqual(eventsOf(rows, 'lost'), [say('midway', 'l1')])
})

test('the session rows come before the subagent rows', () => {
  const rewriter = new LogRewriter()
  rewriter.addSubagent(rowsOf([say('x')], 0, 'child-1')[0] as LogRow)
  assert.throws(() => rewriter.addOwn(rowsOf([ask('late')])[0] as LogRow))
})
