import assert from 'node:assert/strict'
import test from 'node:test'

import { pageBeforeByTurns, tailByTurns } from './pagination'
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
