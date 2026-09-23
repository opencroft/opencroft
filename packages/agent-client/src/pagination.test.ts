import assert from 'node:assert/strict'
import test from 'node:test'

import { pageBeforeByRecords, pageBeforeByTurns, tailByRecords, tailByTurns } from './pagination'
import type { ChatEvent } from './types'

// Builds `turns` synthetic exchanges, each a 'user' event followed by
// `eventsPerTurn - 1` filler events, so index math is easy to reason about:
// turn N starts at index N * eventsPerTurn.
function turns(count: number, eventsPerTurn = 2): ChatEvent[] {
  const events: ChatEvent[] = []
  for (let i = 0; i < count; i++) {
    events.push({ kind: 'user', text: `turn ${i}` })
    for (let j = 1; j < eventsPerTurn; j++) {
      events.push({ kind: 'agent_message', text: `reply ${i}.${j}` })
    }
  }
  return events
}

test('tailByTurns returns everything, with hasMore false, when there are fewer turns than requested', () => {
  const events = turns(3)
  const window = tailByTurns(events, 10)
  assert.deepEqual(window.events, events)
  assert.equal(window.startIndex, 0)
  assert.equal(window.hasMore, false)
})

test('tailByTurns cuts exactly at a user-turn boundary, never mid-turn', () => {
  const events = turns(5, 3)
  const window = tailByTurns(events, 2)
  assert.equal(window.startIndex, 3 * 3) // turn 3 starts at index 9
  assert.equal(window.events.length, 6) // turns 3 and 4, 3 events each
  assert.equal(window.events[0].kind, 'user')
  assert.equal(window.hasMore, true)
})

test('tailByTurns with turns <= 0 returns an empty window positioned at the end', () => {
  const events = turns(3)
  const window = tailByTurns(events, 0)
  assert.deepEqual(window.events, [])
  assert.equal(window.startIndex, events.length)
  assert.equal(window.hasMore, true)
})

test('tailByTurns on an empty log has no more history', () => {
  const window = tailByTurns([], 5)
  assert.deepEqual(window.events, [])
  assert.equal(window.startIndex, 0)
  assert.equal(window.hasMore, false)
})

test('pageBeforeByTurns fetches the page immediately preceding a previous window', () => {
  const events = turns(5, 2)
  const tail = tailByTurns(events, 2) // turns 3-4, startIndex 6
  const older = pageBeforeByTurns(events, tail.startIndex, 2) // turns 1-2
  assert.equal(older.startIndex, 2)
  assert.deepEqual(older.events.map((e) => (e.kind === 'user' ? e.text : null)).filter(Boolean), ['turn 1', 'turn 2'])
  assert.equal(older.hasMore, true)
})

test('pageBeforeByTurns reaches the start and reports hasMore false', () => {
  const events = turns(3, 2)
  const older = pageBeforeByTurns(events, events.length, 10)
  assert.equal(older.startIndex, 0)
  assert.deepEqual(older.events, events)
  assert.equal(older.hasMore, false)
})

test('pageBeforeByTurns before index 0 returns an empty page', () => {
  const events = turns(3)
  const older = pageBeforeByTurns(events, 0, 2)
  assert.deepEqual(older.events, [])
  assert.equal(older.hasMore, false)
})

test('paging backward from the tail repeatedly covers the whole log with no gaps or overlaps', () => {
  const events = turns(9, 2)
  const pages: ChatEvent[][] = []
  let window = tailByTurns(events, 3)
  pages.unshift(window.events)
  while (window.hasMore) {
    window = pageBeforeByTurns(events, window.startIndex, 3)
    pages.unshift(window.events)
  }
  assert.deepEqual(pages.flat(), events)
})

// ── record-paged windows (the chat transcript's cursor) ───────────────────

function closedTool(id: string): ChatEvent[] {
  return [
    { kind: 'tool_call', toolCallId: id, title: id, status: 'pending' },
    { kind: 'tool_update', toolCallId: id, status: 'completed' },
  ]
}

// One turn: a user question, `tools` closed tool calls, then a final reply —
// so its agent-record count is `tools + 1`.
function turn(question: string, tools: number): ChatEvent[] {
  const events: ChatEvent[] = [{ kind: 'user', text: question }]
  for (let i = 0; i < tools; i++) {
    events.push(...closedTool(`${question}-tool-${i}`))
  }
  events.push({ kind: 'agent_message', text: `${question} final` })
  return events
}

const agentRecords = (window: { events: ChatEvent[] }) =>
  window.events.filter((e) => e.kind === 'tool_call' || e.kind === 'agent_message').length

test('the tail counts agent records and leaves user messages free', () => {
  // The acceptance case: turn A has 50 agent records, turn B has 7. A budget of
  // 10 takes all of B and only the last 3 of A.
  const events = [...turn('A', 49), ...turn('B', 6)]
  const window = tailByRecords(events, 10)
  assert.equal(agentRecords(window), 10)
  // B's own question is inside the range; A's is above it and comes back as the
  // header, so the partially-loaded turn still renders with its question.
  assert.deepEqual(
    window.events.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : null)),
    ['B'],
  )
  assert.equal(window.header?.event.kind === 'user' ? window.header.event.text : null, 'A')
  assert.equal(window.hasMore, true)
})

test('the header is never inside the slice, so a consumer can place it itself', () => {
  const events = [...turn('A', 49), ...turn('B', 6)]
  const window = tailByRecords(events, 10)
  assert.ok(window.header)
  assert.ok(window.header.index < window.startIndex)
  assert.ok(!window.events.includes(window.header.event))
})

test('paging back inside one turn terminates instead of re-serving its tail', () => {
  // The cursor sits on the first counted agent record, not the header — with it
  // on the header every page would start above the same question again.
  const events = turn('A', 20)
  let window = tailByRecords(events, 5)
  const seen: number[] = [window.startIndex]
  let hops = 0
  while (window.hasMore) {
    window = pageBeforeByRecords(events, window.startIndex, 5)
    assert.ok(window.startIndex < seen[seen.length - 1], 'each page must move strictly backwards')
    seen.push(window.startIndex)
    hops += 1
    assert.ok(hops < 20, 'paging must terminate')
  }
  assert.equal(window.startIndex, 0)
})

test('every page reports the same header while paging within one turn', () => {
  // Which is exactly why it is a field rather than spliced into the slice:
  // concatenating pages would otherwise repeat the question.
  const events = turn('A', 20)
  const tail = tailByRecords(events, 5)
  const older = pageBeforeByRecords(events, tail.startIndex, 5)
  assert.equal(tail.header?.index, 0)
  assert.equal(older.header?.index, 0)
})

test('paging backward covers the whole log with no gaps or overlaps', () => {
  const events = [...turn('A', 3), ...turn('B', 2), ...turn('C', 4)]
  const pages: ChatEvent[][] = []
  let window = tailByRecords(events, 3)
  pages.unshift(window.events)
  while (window.hasMore) {
    window = pageBeforeByRecords(events, window.startIndex, 3)
    pages.unshift(window.events)
  }
  assert.deepEqual(pages.flat(), events)
})

test('a history shorter than the budget is served whole, with no header and no more', () => {
  const events = turn('A', 2)
  const window = tailByRecords(events, 10)
  assert.deepEqual(window.events, events)
  assert.equal(window.startIndex, 0)
  assert.equal(window.hasMore, false)
  assert.equal(window.header, undefined)
})

test('a still-running tool call ships whole rather than being cut', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'go' },
    ...closedTool('done'),
    { kind: 'tool_call', toolCallId: 'live', title: 'live', status: 'pending' },
    { kind: 'tool_update', toolCallId: 'live', status: 'in_progress' },
  ]
  const window = tailByRecords(events, 1)
  const ids = window.events
    .filter((e) => e.kind === 'tool_call')
    .map((e) => (e.kind === 'tool_call' ? e.toolCallId : ''))
  assert.deepEqual(ids, ['live'])
  // the update belongs to the call that is present, never orphaned
  assert.equal(window.events.at(-1)?.kind, 'tool_update')
})

test('a tool call its turn never finished stops holding the window open at that turn end', () => {
  // A cancelled turn: its tool call never reports a terminal status. Everything
  // after it used to be one record, so a budget of 3 served the whole log.
  const events: ChatEvent[] = [
    { kind: 'user', text: 'cancelled' },
    { kind: 'tool_call', toolCallId: 'orphan', title: 'orphan', status: 'pending' },
    { kind: 'tool_update', toolCallId: 'orphan', status: 'in_progress' },
    { kind: 'turn_end', stopReason: 'cancelled' },
    ...turn('A', 3),
    ...turn('B', 3),
  ]
  const window = tailByRecords(events, 3)
  assert.equal(agentRecords(window), 3)
  assert.equal(window.hasMore, true)
  assert.ok(!window.events.some((e) => e.kind === 'tool_call' && e.toolCallId === 'orphan'))
})

test('the record a turn end closes still ends with it', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'cancelled' },
    { kind: 'tool_call', toolCallId: 'orphan', title: 'orphan', status: 'pending' },
    { kind: 'turn_end', stopReason: 'cancelled' },
    ...turn('A', 1),
  ]
  // One record per page: the orphan's page carries its turn_end and none of A's
  // work. (A's question rides along at its end -- a turn's question is free and
  // belongs to whichever page reaches it, like every other one.)
  let window = tailByRecords(events, 1)
  while (window.hasMore && !window.events.some((e) => e.kind === 'turn_end')) {
    window = pageBeforeByRecords(events, window.startIndex, 1)
  }
  assert.deepEqual(
    window.events.filter((e) => e.kind !== 'user').map((e) => e.kind),
    ['tool_call', 'turn_end'],
  )
})

test('records <= 0 and an exhausted cursor both yield empty windows', () => {
  const events = turn('A', 3)
  assert.deepEqual(tailByRecords(events, 0).events, [])
  assert.deepEqual(pageBeforeByRecords(events, 0, 5).events, [])
  assert.equal(pageBeforeByRecords(events, 0, 5).hasMore, false)
})
