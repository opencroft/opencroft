// This app's half of the durable transcript, against a real database.
//
// The engine's half — what a restored log is turned back into — is tested in
// agent-client. What belongs here is what only a database can get wrong: that
// event ORDER survives a round trip across batches, that a buffered tail is not
// lost to a read that arrives before the timer, that one session's transcript
// is not another's, that the cap drops the oldest rather than the newest, and
// that a rename carries the whole recording with it.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { agentSessionEvent, db } from '@opencroft/db'
import type { ChatEvent } from 'agent-client/types'
import { eq } from 'drizzle-orm'

import {
  appendSessionEvent,
  clearSessionEvents,
  flushSessionEvents,
  moveSessionEvents,
  readSessionEvents,
} from './session-event-store'

// A fresh key per test: these all run against one database and must not see
// each other's rows.
let counter = 0
function nextKey(): string {
  counter += 1
  return `agent:test:session-events-${counter}`
}

const agentMessage = (text: string): ChatEvent => ({ kind: 'agent_message', text })

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

test('a cleared key starts numbering again, rather than resuming where it left off', async () => {
  // The cached next-position has to go with the rows. Kept, the first event of
  // the new transcript would sort after a history that no longer exists, and
  // the cap would then count positions nothing occupies.
  const key = nextKey()
  appendSessionEvent(key, agentMessage('old'))
  await flushSessionEvents()
  await clearSessionEvents(key)
  appendSessionEvent(key, agentMessage('new'))
  await flushSessionEvents()

  const rows = await db
    .select({ position: agentSessionEvent.position })
    .from(agentSessionEvent)
    .where(eq(agentSessionEvent.sessionKey, key))
  assert.deepEqual(
    rows.map((row) => row.position),
    [0],
  )
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
