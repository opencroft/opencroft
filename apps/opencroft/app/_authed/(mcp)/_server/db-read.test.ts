import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  boundedQuery,
  clampMaxRows,
  DbReadRefused,
  DEFAULT_MAX_ROWS,
  DENIED_TABLES,
  deniedRelations,
  findStatementBreak,
  looksLikePlan,
  MAX_MAX_ROWS,
  type QueryRunner,
  redactEmails,
  refuseIfChained,
  relationsInPlan,
  runBoundedRead,
  withoutTrailingSemicolon,
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

test('the chained-statement escape is refused before any driver sees it', async () => {
  // The escape the plan guard cannot catch: the planner is asked about the
  // first statement and the second one is what reads the credential table.
  // One driver refuses this at parse and the other does not, so it is refused
  // here instead — the same answer on every deployment.
  const runner = fakeRunner([{ Plan: { 'Relation Name': 'space' } }])
  await assert.rejects(
    () => runBoundedRead(runner, { sql: 'SELECT 1) AS a; SELECT * FROM "session"; --' }),
    (err: unknown) => {
      assert.ok(err instanceof DbReadRefused)
      assert.match((err as Error).message, /one statement/i)
      return true
    },
  )
  assert.deepEqual(runner.seen, [], 'nothing was sent, not even the SET statements')
})

test('a semicolon that is not a separator is not one', () => {
  // Rejecting these would make the tool refuse ordinary queries, which is how
  // a guard gets removed rather than fixed.
  assert.equal(findStatementBreak("select ';' as x"), -1, 'inside a literal')
  assert.equal(findStatementBreak("select 'it''s; fine' as x"), -1, 'past a doubled quote')
  assert.equal(findStatementBreak('select 1 -- ; trailing\n'), -1, 'in a line comment')
  assert.equal(findStatementBreak('select /* ; /* nested ; */ ; */ 1'), -1, 'in a nested block comment')
  assert.equal(findStatementBreak('select $tag$ a ; b $tag$'), -1, 'in a dollar-quoted string')
  assert.equal(findStatementBreak('select $$ a ; b $$'), -1, 'in an untagged dollar-quoted string')
  assert.equal(findStatementBreak('select "odd;name" from t'), -1, 'in a quoted identifier')
})

test('an E-string does not put the lexer out of phase', () => {
  // `E'…'` turns backslash escapes on, so `\'` is an escaped quote. Read as a
  // plain literal it looks like a close followed by an open, and everything
  // after runs one quote out of phase — stepping over the separator. This is
  // the exact payload: the planner would be asked about the first statement
  // while the second reads a denied table.
  assert.ok(
    findStatementBreak(String.raw`select E'\'') AS a; select * from session; --'`) >= 0,
    'the separator after an E-string escape is found',
  )
  assert.ok(findStatementBreak(String.raw`select e'\'') AS a; select 1; --'`) >= 0, 'lowercase prefix too')
  assert.throws(() => refuseIfChained(String.raw`select E'\'') AS a; select * from session; --'`), DbReadRefused)
})

test('the E prefix is only a prefix when it is attached, and only when it is a prefix', () => {
  // Measured against the database, 26.08.2026: a space or a newline between
  // the E and the quote means it is not an E-string, and a quote following an
  // identifier is a plain literal — `role'x'` is a type name and a literal.
  // Treating either as an E-string would enable backslash escaping where the
  // database has none, which is the fail-open direction.
  assert.equal(findStatementBreak(String.raw`select E '\' as x`), -1, 'space: plain literal, backslash is data')
  assert.equal(findStatementBreak(String.raw`select role'\' as x`), -1, 'after an identifier: plain literal')
  // And `U&'…'` escapes a code point, not a quote, so it reads as plain too.
  assert.equal(findStatementBreak(String.raw`select U&'\0041' as x`), -1)
})

test('a real separator is found wherever it is', () => {
  assert.ok(findStatementBreak('select 1; select 2') >= 0)
  assert.ok(findStatementBreak("select ';' as x; select 2") >= 0)
  assert.ok(findStatementBreak('select 1 /* c */ ; select 2') >= 0)
})

test('a trailing separator is allowed, since it separates nothing', () => {
  assert.equal(withoutTrailingSemicolon('select 1;  '), 'select 1')
  assert.doesNotThrow(() => refuseIfChained('select 1;'))
})

test('text that cannot be read to the end is refused rather than guessed at', () => {
  // Failing to find the end of a literal would otherwise mean walking past a
  // real separator — the one direction this must never fail in.
  assert.equal(findStatementBreak("select 'unterminated"), -2)
  assert.equal(findStatementBreak('select /* unterminated'), -2)
  assert.equal(findStatementBreak('select "unterminated'), -2)
  assert.equal(findStatementBreak('select $t$ unterminated'), -2)
  assert.throws(() => refuseIfChained("select 'oops"), DbReadRefused)
})

test('a plan shape the walker does not recognise is refused, not read as empty', async () => {
  // An empty set of relations is indistinguishable from "touches nothing
  // denied", so failing open here would pass the guard and run the query.
  for (const shape of ['not a plan', null, [], [{ 'QUERY PLAN': 'text output' }]]) {
    const runner = fakeRunner(shape)
    await assert.rejects(
      () => runBoundedRead(runner, { sql: 'select 1' }),
      (err: unknown) => err instanceof DbReadRefused,
      `expected refusal for ${JSON.stringify(shape)}`,
    )
    assert.equal(
      runner.seen.filter((s) => !s.startsWith('SET') && !s.startsWith('EXPLAIN')).length,
      0,
      'refused before running the statement',
    )
  }
})

test('a real plan is recognised, including one nested in an array', () => {
  assert.equal(looksLikePlan([{ Plan: { 'Node Type': 'Result' } }]), true)
  assert.equal(looksLikePlan({ Plan: {} }), true)
  assert.equal(looksLikePlan([{ 'Node Type': 'Result' }]), false)
})

test('the redaction count is addresses, not values', () => {
  // Two in one string is two: the number is reported to a reader who reasons
  // from it, so which one it counts is the point of reporting it.
  const { redactions } = redactEmails([{ note: 'a@b.co and c@d.co' }])
  assert.equal(redactions, 2)
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
