// Reads that must come back whole however much the rows they match add up to,
// against the embedded PGlite whose result size this exists to stay under.
//
// Every case here returns more than the embedded database can hold in one
// result (about 15 MiB). Read in one SELECT, each fails with "memory access
// out of bounds" and leaves the database refusing every later query until it
// is reopened, so each case also runs one ordinary query afterwards.
import './test-env'

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'

import { eq, sql } from 'drizzle-orm'

import { resetDatabase } from './backup'
import { boundedSelect, inBudget, STATEMENT_BYTE_BUDGET } from './bounded-select'
import { type DB, openDb } from './connect'
import { agentQueueEntry, agentSessionEvent } from './schema'

let db: DB
let close: () => Promise<void>

before(async () => {
  ;({ db, close } = await openDb())
})

after(async () => {
  await close?.()
})

beforeEach(async () => {
  await resetDatabase(db)
})

async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const row of rows) {
    out.push(row)
  }
  return out
}

async function stillAnswers(): Promise<void> {
  const [row] = await db.execute(sql`select 1 as one`).then((result) => result.rows)
  assert.deepEqual(row, { one: 1 })
}

test('two rows that together exceed one result come back whole', async () => {
  const text = 'q'.repeat(10 * 1024 * 1024)
  for (const id of ['entry-a', 'entry-b']) {
    await db.insert(agentQueueEntry).values({ id, sessionKey: 'agent:test:big', kind: 'message', text, position: 0 })
  }

  const rows = await collect(
    boundedSelect<{ id: string; text: string }>(db, {
      from: agentQueueEntry,
      fields: { id: agentQueueEntry.id, text: agentQueueEntry.text },
      key: [agentQueueEntry.id],
    }),
  )

  assert.deepEqual(
    rows.map((row) => [row.id, row.text.length]),
    [
      ['entry-a', text.length],
      ['entry-b', text.length],
    ],
  )
  await stillAnswers()
})

test('many small rows past one result come back in key order, across planning pages, and only those the filter matches', async () => {
  // 1,200 rows of 20 KB: about 23 MiB, and more rows than one planning read
  // fetches. A second session shares every position, so a batch read that
  // dropped the filter would return its rows too.
  const filler = 'e'.repeat(20 * 1024)
  for (const sessionKey of ['agent:test:read', 'agent:test:other']) {
    for (let start = 0; start < 1_200; start += 100) {
      await db.insert(agentSessionEvent).values(
        Array.from({ length: 100 }, (_, i) => ({
          sessionKey,
          position: start + i,
          event: { kind: 'agent_message', text: `${sessionKey}:${start + i}:${filler}` },
        })),
      )
    }
  }

  const rows = await collect(
    boundedSelect<{ position: number; event: { text: string } }>(db, {
      from: agentSessionEvent,
      fields: { position: agentSessionEvent.position, event: agentSessionEvent.event },
      key: [agentSessionEvent.position],
      where: eq(agentSessionEvent.sessionKey, 'agent:test:read'),
    }),
  )

  assert.deepEqual(
    rows.map((row) => row.position),
    Array.from({ length: 1_200 }, (_, i) => i),
  )
  assert.ok(rows.every((row) => row.event.text.startsWith(`agent:test:read:${row.position}:`)))
  await stillAnswers()
})

test('a filter matching nothing reads nothing, from a table that is not empty', async () => {
  await db
    .insert(agentQueueEntry)
    .values({ id: 'entry-a', sessionKey: 'agent:test:one', kind: 'message', text: 'x', position: 0 })
  const all = await collect(
    boundedSelect(db, { from: agentQueueEntry, fields: { id: agentQueueEntry.id }, key: [agentQueueEntry.id] }),
  )
  const none = await collect(
    boundedSelect(db, {
      from: agentQueueEntry,
      fields: { id: agentQueueEntry.id },
      key: [agentQueueEntry.id],
      where: eq(agentQueueEntry.sessionKey, 'agent:test:absent'),
    }),
  )
  assert.deepEqual([all.length, none.length], [1, 0])
})

test('batches stay under the budget by bytes and by count, and an item over the budget goes alone', async () => {
  const half = STATEMENT_BYTE_BUDGET / 2
  const sizes = [half, half, 1, STATEMENT_BYTE_BUDGET * 2, 1, 1, 1]
  const batches = await collect(inBudget(sizes, (size) => size, 2))
  assert.deepEqual(batches, [[half, half], [1], [STATEMENT_BYTE_BUDGET * 2], [1, 1], [1]])
})
