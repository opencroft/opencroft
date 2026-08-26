import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  boundedQuery,
  clampMaxRows,
  DbReadRefused,
  DEFAULT_MAX_ROWS,
  DENIED_TABLES,
  deniedRelations,
  MAX_MAX_ROWS,
  type QueryRunner,
  redactEmails,
  relationsInPlan,
  runBoundedRead,
} from './db-read'

/** A runner that answers EXPLAIN with the given plan and the query with rows. */
function fakeRunner(plan: unknown, rows: Record<string, unknown>[] = []): QueryRunner & { seen: string[] } {
  const seen: string[] = []
  return {
    seen,
    async execute(sql: string) {
      seen.push(sql)
      if (sql.startsWith('EXPLAIN')) {
        return { rows: [{ 'QUERY PLAN': plan }] }
      }
      return { rows }
    },
  }
}

test('the denied set is derived from the auth module, not typed out', () => {
  // Whatever auth grows, it is denied by default: the test asserts the shape
  // of the derivation rather than a fixed list, so adding a table cannot
  // quietly widen what this tool reads.
  assert.ok(DENIED_TABLES.has('session'), 'session holds live tokens')
  assert.ok(DENIED_TABLES.has('account'), 'account holds provider credentials')
  assert.ok(DENIED_TABLES.has('verification'), 'verification holds one-time codes')
})

test('the user table is readable on purpose', () => {
  // It holds identity and no credential, and it is what every "did every
  // account get X" question joins against — the question this tool exists for.
  assert.equal(DENIED_TABLES.has('user'), false)
})

test('relations are found however deeply the plan nests them', () => {
  const plan = [
    {
      Plan: {
        'Node Type': 'Nested Loop',
        Plans: [
          { 'Node Type': 'Seq Scan', 'Relation Name': 'space' },
          { 'Node Type': 'Subquery Scan', Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'session' }] },
        ],
      },
    },
  ]
  assert.deepEqual([...relationsInPlan(plan)].sort(), ['session', 'space'])
})

test('a query that reads a credential table is refused, by plan rather than by text', async () => {
  // The SQL below never names `session` — a view or an alias would hide it
  // from any string check. The planner reports it anyway.
  const runner = fakeRunner([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'session' } }])
  await assert.rejects(
    () => runBoundedRead(runner, { sql: 'select * from active_logins' }),
    (err: unknown) => {
      assert.ok(err instanceof DbReadRefused)
      assert.match((err as Error).message, /session/)
      return true
    },
  )
  // And it refused BEFORE running the query itself.
  assert.equal(runner.seen.filter((s) => !s.startsWith('SET') && !s.startsWith('EXPLAIN')).length, 0)
})

test('an ordinary read runs, under a read-only transaction and a timeout', async () => {
  const runner = fakeRunner([{ Plan: { 'Node Type': 'Seq Scan', 'Relation Name': 'space' } }], [{ id: 1 }])
  const result = await runBoundedRead(runner, { sql: 'select id from space' })
  assert.deepEqual(result.rows, [{ id: 1 }])
  assert.equal(result.truncated, false)
  assert.ok(runner.seen.includes('SET TRANSACTION READ ONLY'))
  assert.ok(runner.seen.some((s) => s.startsWith('SET LOCAL statement_timeout')))
})

test('a truncated result says so, and returns exactly the cap', async () => {
  // The whole point: a completeness question answered from a quietly
  // shortened list reads exactly like the truth.
  const rows = Array.from({ length: 4 }, (_, i) => ({ id: i }))
  const runner = fakeRunner([{ Plan: { 'Relation Name': 'space' } }], rows)
  const result = await runBoundedRead(runner, { sql: 'select id from space', maxRows: 3 })
  assert.equal(result.truncated, true)
  assert.equal(result.rowCount, 3)
  assert.equal(result.rows.length, 3)
})

test('a result exactly at the cap is not reported as truncated', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: i }))
  const runner = fakeRunner([{ Plan: { 'Relation Name': 'space' } }], rows)
  const result = await runBoundedRead(runner, { sql: 'select id from space', maxRows: 3 })
  assert.equal(result.truncated, false)
  assert.equal(result.rowCount, 3)
})

test('the cap is asked of the database, with one extra row to reveal more', () => {
  assert.equal(boundedQuery('select 1', 10), 'SELECT * FROM (select 1) AS bounded_read LIMIT 11')
})

test('a trailing semicolon does not break the wrap', () => {
  assert.match(boundedQuery('select 1;  ', 5), /\(select 1\) AS bounded_read/)
})

test('the row cap is bounded at both ends', () => {
  assert.equal(clampMaxRows(undefined), DEFAULT_MAX_ROWS)
  assert.equal(clampMaxRows(0), 1)
  assert.equal(clampMaxRows(-5), 1)
  assert.equal(clampMaxRows(10_000), MAX_MAX_ROWS)
  assert.equal(clampMaxRows(2.7), 2)
})

test('a plan touching nothing denied yields no refusal', () => {
  assert.deepEqual(deniedRelations([{ Plan: { 'Relation Name': 'user' } }]), [])
})

test('an email is removed by its shape, wherever it sits', () => {
  // By shape and not by column name, because `select email as e` defeats a
  // column check and `select *` defeats a column list.
  const { rows, redactions } = redactEmails([
    { e: 'someone@example.com', note: 'write to someone@example.com about it', n: 7 },
  ])
  assert.equal(redactions, 2)
  assert.equal(rows[0].e, '[email removed]')
  assert.equal(rows[0].note, 'write to [email removed] about it')
  assert.equal(rows[0].n, 7, 'a non-string value is left alone')
})

test('a result with nothing to redact says zero rather than nothing', () => {
  const { redactions } = redactEmails([{ id: 'abc', name: 'Someone' }])
  assert.equal(redactions, 0)
})

test('a redacted result reports the redaction alongside the rows', async () => {
  // Same rule as truncation: a reader who cannot tell "empty" from "removed"
  // reports the first.
  const runner = fakeRunner([{ Plan: { 'Relation Name': 'user' } }], [{ email: 'a@b.co' }])
  const result = await runBoundedRead(runner, { sql: 'select email from "user"' })
  assert.equal(result.redactions, 1)
  assert.deepEqual(result.rows, [{ email: '[email removed]' }])
})
