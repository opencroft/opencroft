import assert from 'node:assert/strict'
import test from 'node:test'

import { pageBeforeByTurns, pageBeforeRecordsInTurn, tailByTurns, tailRecordsInTurn } from './pagination'
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

// Builds a closed tool-call group: a tool_call followed by an in_progress
// update (still open) and a terminal completed update.
function closedToolGroup(id: string): ChatEvent[] {
  return [
    { kind: 'tool_call', toolCallId: id, title: id, status: 'pending' },
    { kind: 'tool_update', toolCallId: id, status: 'in_progress' },
    { kind: 'tool_update', toolCallId: id, status: 'completed' },
  ]
}

function openToolGroup(id: string): ChatEvent[] {
  return [
    { kind: 'tool_call', toolCallId: id, title: id, status: 'pending' },
    { kind: 'tool_update', toolCallId: id, status: 'in_progress' },
  ]
}

// One turn: a user event, then `groups` closed tool-call groups.
function turnWithToolGroups(groups: number): ChatEvent[] {
  const events: ChatEvent[] = [{ kind: 'user', text: 'go' }]
  for (let i = 0; i < groups; i++) {
    events.push(...closedToolGroup(`tool-${i}`))
  }
  return events
}

test('tailRecordsInTurn cuts exactly at closed-record boundaries, never mid-tool-call', () => {
  const events = turnWithToolGroups(5)
  const window = tailRecordsInTurn(events, 0, events.length, 2)
  assert.equal(window.events[0].kind, 'tool_call')
  assert.deepEqual(window.events.map((e) => (e.kind === 'tool_call' ? e.toolCallId : null)).filter(Boolean), [
    'tool-3',
    'tool-4',
  ])
  assert.equal(window.hasMore, true)
  // Never includes the turn's own leading user event.
  assert.ok(window.events.every((e) => e.kind !== 'user'))
})

test('tailRecordsInTurn always ships an unresolved trailing group in full', () => {
  const events = [...turnWithToolGroups(2), ...openToolGroup('tool-open')]
  // Ask for 1 record: the closed 'tool-1' group would be the naive last
  // record, but 'tool-open' never resolves, so it must be included in full
  // rather than truncated or dropped.
  const window = tailRecordsInTurn(events, 0, events.length, 1)
  const toolIds = window.events.map((e) => (e.kind === 'tool_call' ? e.toolCallId : null)).filter(Boolean)
  assert.deepEqual(toolIds, ['tool-open'])
  assert.equal(window.events.at(-1)?.kind, 'tool_update')
})

test('tailRecordsInTurn with records <= 0 returns an empty window positioned at turnEnd', () => {
  const events = turnWithToolGroups(3)
  const window = tailRecordsInTurn(events, 0, events.length, 0)
  assert.deepEqual(window.events, [])
  assert.equal(window.startIndex, events.length)
  assert.equal(window.hasMore, true)
})

test('a permission request/resolved pair is never split across a cut', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'go' },
    ...closedToolGroup('tool-0'),
    { kind: 'permission_request', requestId: 'p1', title: 'allow?', options: [] },
    { kind: 'permission_resolved', requestId: 'p1', optionId: 'yes' },
  ]
  const window = tailRecordsInTurn(events, 0, events.length, 1)
  assert.deepEqual(
    window.events.map((e) => e.kind),
    ['permission_request', 'permission_resolved'],
  )
})

test('consecutive agent_message chunks fold into a single record boundary', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'go' },
    ...closedToolGroup('tool-0'),
    { kind: 'agent_message', text: 'hello ' },
    { kind: 'agent_message', text: 'world' },
  ]
  const window = tailRecordsInTurn(events, 0, events.length, 1)
  assert.deepEqual(
    window.events.map((e) => e.kind),
    ['agent_message', 'agent_message'],
  )
})

test('pageBeforeRecordsInTurn paging backward covers a turn body with no gaps or overlaps', () => {
  const events = turnWithToolGroups(9)
  const pages: ChatEvent[][] = []
  let window = tailRecordsInTurn(events, 0, events.length, 3)
  pages.unshift(window.events)
  while (window.hasMore) {
    window = pageBeforeRecordsInTurn(events, 0, window.startIndex, 3)
    pages.unshift(window.events)
  }
  assert.deepEqual(pages.flat(), events.slice(1)) // excludes the leading user event
})
