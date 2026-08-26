// The assumptions db-read.ts rests on that no fake can establish, held against
// a real database **through the same layers the tool uses**.
//
// Each is a property of the stack below us rather than of our code, which is
// why they belong in a suite: a driver upgrade that changes the plan shape, a
// PGlite release that gains multi-statement support, or a drizzle change that
// stops binding statements to one transaction would each disable a guard while
// every unit test stayed green. There is nothing in `db-read.ts` these can
// catch; they catch the ground moving under it.
//
// **They go through drizzle, not through PGlite directly.** `runBoundedRead`
// runs its four statements as `tx.execute` inside `db.transaction(...)`, so
// that is where transaction binding happens and that is what has to be
// exercised. Reaching past it to `pg.query` would test a layer the tool never
// uses and report the third assumption as covered when it was not.
//
// The instance is in memory, so no data directory is touched and nothing can
// contend with the app's own (see connect.ts on a second opener). It costs
// roughly a second of suite time — the price of the only tests here that can
// fail when nothing in this repository changed.
//
// **Every refusal asserts the SQLSTATE, never merely that something threw.** A
// test expecting an error passes when the error arrives for any reason at all,
// including a typo in its own fixture — a check that cannot fail for the right
// reason. `42601` is a parse refusal, `25006` is a read-only transaction
// refusing a write, and nothing else counts as either.

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'

import { looksLikePlan, relationsInPlan } from './db-read'

type Db = ReturnType<typeof drizzle>

/** The driver's own error code, wherever the layers above put it. */
function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } }
  return e?.code ?? e?.cause?.code
}

async function refusal(run: () => Promise<unknown>): Promise<unknown> {
  return run().then(
    () => null,
    (e: unknown) => e,
  )
}

describe('the driver assumptions db-read rests on', () => {
  let pg: PGlite
  let db: Db

  before(async () => {
    pg = new PGlite()
    db = drizzle(pg)
    await db.execute(sql.raw('CREATE TABLE probe (id int primary key, note text)'))
    await db.execute(sql.raw("INSERT INTO probe (id, note) VALUES (1, 'first')"))
  })

  after(async () => {
    await pg.close()
  })

  test('EXPLAIN (FORMAT JSON) returns a plan the walker can read', async () => {
    const result = await db.execute(sql.raw('EXPLAIN (FORMAT JSON) SELECT * FROM probe'))
    const plan = (result.rows as Record<string, unknown>[]).map((row) => Object.values(row)[0])

    // The shape the guard depends on: not a JSON string needing a parse, and
    // `Relation Name` reachable through however many arrays it arrives inside.
    assert.equal(looksLikePlan(plan), true, 'recognisable as a plan')
    assert.deepEqual([...relationsInPlan(plan)], ['probe'])
  })

  test('a chained statement is refused at parse, with 42601', async () => {
    // The escape the plan guard cannot see: the planner is asked about the
    // first statement and the second is what would read a credential table.
    // `db-read.ts` refuses it before any driver is involved; this records what
    // this stack does on its own, so a release that starts accepting it shows
    // up here rather than silently widening the guard.
    const err = await refusal(() => db.execute(sql.raw('SELECT 1; SELECT 2')))
    assert.ok(err, 'the chained statement was refused')
    assert.equal(sqlState(err), '42601', 'refused at parse, not for some other reason')
  })

  test('a backslash escapes a quote inside an E-string, and nowhere else', async () => {
    // The premise the lexer's E-string branch encodes, and the one case where
    // our reading and the database genuinely disagreed. If a release changed
    // it, the lexer would follow a rule the database no longer has, and the
    // symptom would be a separator stepped over — which no unit test can see,
    // since they all supply their own input.
    const escaped = await db.execute(sql.raw(String.raw`select E'\'' as x`))
    assert.deepEqual(escaped.rows, [{ x: "'" }], 'backslash-quote is one escaped quote')

    const plain = await db.execute(sql.raw(String.raw`select '\' as x`))
    assert.deepEqual(plain.rows, [{ x: '\\' }], 'in a plain literal the backslash is data')

    // Attached only: with a space it is not an E-string, so the quote opens a
    // plain literal and the text no longer terminates.
    const spaced = await refusal(() => db.execute(sql.raw(String.raw`select E '\'' as x`)))
    assert.equal(sqlState(spaced), '42601', 'a detached prefix is not a prefix')

    // And the payload itself: wrapped as the tool wraps it, this is two
    // statements to the database, not one.
    const wrapped = await refusal(() =>
      db.execute(
        sql.raw(String.raw`SELECT * FROM (select E'\'') AS a; select * from probe; --') AS bounded_read LIMIT 2`),
      ),
    )
    assert.equal(sqlState(wrapped), '42601', 'the E-string payload is two statements')
  })

  for (const [label, statement] of [
    ['UPDATE', "UPDATE probe SET note = 'changed' WHERE id = 1"],
    ['DELETE', 'DELETE FROM probe WHERE id = 1'],
    ['INSERT', "INSERT INTO probe (id, note) VALUES (2, 'second')"],
    ['CREATE TABLE', 'CREATE TABLE sneaky (id int)'],
    ['a data-modifying CTE', "WITH w AS (UPDATE probe SET note = 'cte' RETURNING id) SELECT * FROM w"],
  ] as const) {
    test(`a read-only transaction refuses ${label}, with 25006`, async () => {
      // Through `db.transaction` and `tx.execute`, which is how the tool binds
      // its statements to one transaction — the layer where that binding could
      // stop happening.
      //
      // Each in its OWN transaction. Four writes in one produces three
      // `25P02 current transaction is aborted` refusals that are satisfied by
      // the first failure rather than by the rule under test: a passing check
      // with the wrong cause.
      const err = await refusal(() =>
        db.transaction(async (tx) => {
          await tx.execute(sql.raw('SET TRANSACTION READ ONLY'))
          await tx.execute(sql.raw(statement))
        }),
      )

      assert.ok(err, `${label} was refused`)
      assert.equal(sqlState(err), '25006', 'refused BY the read-only transaction')
    })
  }

  test('and the rows the writes tried to change are untouched', async () => {
    // The refusals above are only meaningful if nothing got through.
    const note = await db.execute(sql.raw('SELECT note FROM probe WHERE id = 1'))
    assert.deepEqual(note.rows, [{ note: 'first' }])
    const count = await db.execute(sql.raw('SELECT count(*)::int AS n FROM probe'))
    assert.deepEqual(count.rows, [{ n: 1 }], 'the INSERT did not land either')
  })
})
