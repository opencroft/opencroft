// A crash of PGlite's WebAssembly runtime, against a real PGlite.
//
// The trigger is a result too large for PGlite's wasm heap. It traps with
// "memory access out of bounds", and after that every call on the instance
// traps the same way. These tests pin that the database the app holds keeps
// answering anyway, without a process restart, and that reopening loses
// nothing that was committed.
import './test-env'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, afterEach } from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'

import { type DB, openDb } from './connect'
import { DatabaseCrashedError, RecoveringPGlite } from './recovering-pglite'

const workdir = mkdtempSync(join(tmpdir(), 'opencroft-recovering-pglite-test-'))
after(() => rmSync(workdir, { recursive: true, force: true }))

/** A query whose result does not fit in PGlite's wasm heap. */
const OVERSIZED = sql`select repeat('x', 128 * 1024 * 1024) as s`

let open: { db: DB; close: () => Promise<void> } | null = null
afterEach(async () => {
  await open?.close()
  open = null
})

let datadirs = 0
async function openFreshDb(): Promise<DB> {
  datadirs += 1
  process.env.PGLITE_PATH = join(workdir, `db-${datadirs}`)
  open = await openDb()
  await open.db.execute(sql`create table item (id int primary key, label text not null)`)
  return open.db
}

/** Captures console.error for the duration of `run`. */
async function capturingErrors<T>(run: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const original = console.error
  const lines: string[] = []
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '))
  }
  try {
    return { result: await run(), logged: lines.join('\n') }
  } finally {
    console.error = original
  }
}

/** The crash error a failed call carries, through drizzle's own query-error wrapper. */
function crashOf(error: unknown): DatabaseCrashedError | null {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof DatabaseCrashedError) {
      return current
    }
  }
  return null
}

async function labels(db: DB): Promise<string[]> {
  const result = await db.execute<{ label: string }>(sql`select label from item order by id`)
  return result.rows.map((row) => row.label)
}

test('the oversized query really breaks a bare PGlite for good', async () => {
  // The premise of everything below. If a PGlite upgrade stops trapping on
  // this query, the other tests here would pass without exercising a crash.
  const dataDir = join(workdir, 'bare')
  const bare = new PGlite(dataDir)
  await bare.query("select repeat('x', 1024)")
  await assert.rejects(bare.query("select repeat('x', 128 * 1024 * 1024)"), WebAssembly.RuntimeError)
  await assert.rejects(bare.query('select 1'), WebAssembly.RuntimeError)
})

test('after a crash the same db answers again, with the committed data intact', async () => {
  const db = await openFreshDb()
  await db.execute(sql`insert into item values (1, 'alice'), (2, 'bob')`)

  const { result: error } = await capturingErrors(() =>
    db.execute(OVERSIZED).then(
      () => null,
      (e: unknown) => e,
    ),
  )

  const crash = crashOf(error)
  assert.ok(crash, `expected a DatabaseCrashedError, got ${String(error)}`)
  assert.ok(crash.cause instanceof WebAssembly.RuntimeError)
  const count = await db.execute<{ n: number }>(sql`select count(*)::int as n from item`)
  assert.equal(count.rows[0]?.n, 2)
  assert.deepEqual(await labels(db), ['alice', 'bob'])
  await db.execute(sql`insert into item values (3, 'carol')`)
  assert.deepEqual(await labels(db), ['alice', 'bob', 'carol'])
})

test('a call waiting behind the crashing one runs on the reopened database instead of failing', async () => {
  const db = await openFreshDb()
  await db.execute(sql`insert into item values (1, 'alice')`)

  const { result } = await capturingErrors(() =>
    Promise.allSettled([db.execute(OVERSIZED), db.execute<{ n: number }>(sql`select count(*)::int as n from item`)]),
  )

  assert.equal(result[0].status, 'rejected')
  assert.ok(result[0].status === 'rejected' && crashOf(result[0].reason))
  assert.equal(result[1].status, 'fulfilled')
  assert.equal(result[1].status === 'fulfilled' && result[1].value.rows[0]?.n, 1)
})

test('the crash is logged with the statement text and without its parameters', async () => {
  const db = await openFreshDb()

  const { logged } = await capturingErrors(async () => {
    await db.execute(sql`select repeat(${'param-marker'}::text, ${12 * 1024 * 1024}::int) as s`).catch(() => undefined)
    // Runs on the replacement, so the reopen has been logged by the time it answers.
    await db.execute(sql`select 1`)
  })

  assert.match(logged, /memory access out of bounds/)
  assert.match(logged, /select repeat\(\$1::text, \$2::int\) as s/)
  assert.doesNotMatch(logged, /param-marker/)
  assert.match(logged, /Reopened the embedded PGlite database/)
})

test('a crash inside a transaction rolls back its writes and the earlier commits survive', async () => {
  const db = await openFreshDb()
  await db.execute(sql`insert into item values (1, 'alice')`)

  const { result: error, logged } = await capturingErrors(() =>
    db
      .transaction(async (tx) => {
        await tx.execute(sql`insert into item values (2, 'uncommitted')`)
        await tx.execute(sql`update item set label = 'changed' where id = 1`)
        // Swallowed on purpose: the crash must be caught where it happens,
        // not only when it is what ends the transaction.
        await tx.execute(OVERSIZED).catch(() => undefined)
      })
      .then(
        () => null,
        (e: unknown) => e,
      ),
  )

  assert.ok(crashOf(error), `expected a DatabaseCrashedError, got ${String(error)}`)
  // The statement that crashed, not the COMMIT that trapped after it.
  assert.match(logged, /running: select repeat\('x', 128 \* 1024 \* 1024\) as s/)
  assert.deepEqual(await labels(db), ['alice'])
})

test('a writing statement that crashes outside a transaction leaves none of its writes behind', async () => {
  // What makes retrying the crashed request safe: the statement's own writes
  // are done before its result is built, and the crash comes while building
  // it, before the statement commits.
  const db = await openFreshDb()
  await db.execute(sql`insert into item values (1, 'alice')`)

  const { result: error } = await capturingErrors(() =>
    db
      .execute(
        sql`with big as (insert into item values (2, repeat('z', 64 * 1024 * 1024)) returning label),
                 more as (insert into item select g, 'more' from generate_series(10, 3010) g returning id)
            select (select label from big), (select count(*) from more)`,
      )
      .then(
        () => null,
        (e: unknown) => e,
      ),
  )

  assert.ok(crashOf(error), `expected a DatabaseCrashedError, got ${String(error)}`)
  assert.deepEqual(await labels(db), ['alice'])
})

test('a second trap in a transaction does not replace the first in the log', async () => {
  const db = await openFreshDb()

  const { logged } = await capturingErrors(() =>
    db
      .transaction(async (tx) => {
        await tx.execute(OVERSIZED).catch(() => undefined)
        await tx.execute(sql`select 'after-the-crash'`)
      })
      .catch(() => undefined),
  )

  assert.match(logged, /running: select repeat\('x', 128 \* 1024 \* 1024\) as s/)
  assert.doesNotMatch(logged, /after-the-crash/)
})

test('an ordinary SQL error passes through and keeps the same instance', async () => {
  const db = await openFreshDb()
  // Session state that a reopen would lose.
  await db.execute(sql`create temporary table scratch (n int)`)

  await assert.rejects(db.execute(sql`select * from no_such_table`), (error: unknown) => {
    assert.equal(crashOf(error), null)
    assert.match(String(error), /no_such_table/)
    return true
  })

  await db.execute(sql`select * from scratch`)
})

test('when the replacement cannot be opened, onReopenFailed is told and calls reject with that failure', async () => {
  const dataDir = join(workdir, 'reopen-fails')
  const reopenFailure = new Error('cannot open')
  let opens = 0
  const reported: unknown[] = []
  const client = new RecoveringPGlite({
    open: async () => {
      opens += 1
      if (opens > 1) {
        throw reopenFailure
      }
      const instance = new PGlite(dataDir)
      await instance.waitReady
      return instance
    },
    onReopenFailed: (error) => reported.push(error),
  })

  await capturingErrors(async () => {
    await assert.rejects(client.query("select repeat('x', 128 * 1024 * 1024)"), DatabaseCrashedError)
    await assert.rejects(client.query('select 1'), (error: unknown) => error === reopenFailure)
  })

  assert.deepEqual(reported, [reopenFailure])
  assert.equal(opens, 2)
})
