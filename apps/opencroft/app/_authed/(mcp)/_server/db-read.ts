// A read-only window onto this instance's database.
//
// It exists because the writing direction already works and the reading one
// did not: an agent can apply a migration and run a backfill, and then has no
// way to establish what either did. The embedded database is opened in-process
// and its data directory is guarded against a second opener, so this cannot be
// a client pointed at a connection string -- it has to be a tool inside the
// process that already holds the handle.
//
// Three properties, and none of them is a check on the text of the query:
//
//   - read-only is enforced by the transaction, so a write is refused where it
//     would be performed -- including from a data-modifying CTE, which a
//     "does it start with SELECT" test waves through;
//   - what a statement reads is answered by the PLANNER, not by looking for
//     table names in the SQL, because quoting, aliases and views all defeat
//     the string and none of them defeat the plan;
//   - a truncated result says so.
//
// It is a guardrail, not a sandbox. It stops the auth surface being read by
// accident or in passing, which is what was asked for. It is not built to hold
// against someone deliberately working around it.

// Via `schema`, which re-exports the auth module: that subpath is already the
// package's public surface, so this needs no new export and no new coupling.
import { authSchema } from '@opencroft/db/schema'
import { getTableName } from 'drizzle-orm'

export interface DbReadRequest {
  sql: string
  maxRows?: number
}

export interface DbReadResult {
  rows: Record<string, unknown>[]
  rowCount: number
  /** True when the query had more rows than `maxRows`. Never silent. */
  truncated: boolean
  maxRows: number
  /**
   * How many email ADDRESSES were removed — two in one value count twice.
   * Beside `truncated` and for the same reason: a reader who cannot tell
   * "this was empty" from "this was taken out" will report the first.
   */
  redactions: number
}

// An email is matched by SHAPE, and that is the right test for it — an address
// is defined by its form, and no list could hold every address before seeing
// it. That is the exact opposite of how a secret is handled, where the value
// is known and comparing against it is the only thing that works, and a shape
// would catch only the shapes someone thought of. Two rules, two reasons;
// applying either to the other's problem is what fails.
//
// This is separate again from DENIED_TABLES, which is about where the tool may
// look rather than what values may leave: `session`, `account` and
// `verification` are refused because nothing here has business reading them at
// all, while `user` is read on purpose — the tool exists to join against it —
// with personal data removed on the way out.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g

/**
 * Strip email addresses out of every **string** value, and count how many
 * ADDRESSES were removed — not how many values were touched, since two in one
 * string count twice. The number is reported to a reader who will reason from
 * it, which is the whole point of reporting it.
 *
 * A non-string value is returned untouched, and that is a real limit rather
 * than a tidy one: an address inside a `jsonb` object or a `text[]` would
 * survive.
 *
 * It closes nothing today, and the reason is a property rather than a tally —
 * a tally rots the moment a column is added and is inherited as fact for years
 * afterwards. As of 26.08.2026 the column types imported from
 * `drizzle-orm/pg-core` are `text`, `timestamp`, `integer`, `bigint` and
 * `boolean` in `schema.ts`, and `text`, `timestamp` and `boolean` in
 * `auth-schema.ts`; neither file imports `json` or `jsonb`, and neither calls
 * `.array()`. So no column can hold a non-string value at all, and
 * `Setting.data` stores its JSON as `text` and is therefore scanned. The
 * import line is both where that changes and where to look.
 */
export function redactEmails(rows: Record<string, unknown>[]): {
  rows: Record<string, unknown>[]
  redactions: number
} {
  let redactions = 0
  const cleaned = rows.map((row) => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== 'string') {
        out[key] = value
        continue
      }
      const replaced = value.replace(EMAIL, () => {
        redactions += 1
        return '[email removed]'
      })
      out[key] = replaced
    }
    return out
  })
  return { rows: cleaned, redactions }
}

export const DEFAULT_MAX_ROWS = 200
export const MAX_MAX_ROWS = 2000
export const STATEMENT_TIMEOUT_MS = 5000

/**
 * Tables this tool refuses to read.
 *
 * Derived from the auth module rather than typed out, so a table added to auth
 * tomorrow is refused without anyone remembering to add it here -- the failure
 * direction that matters, since a hand-kept list goes stale silently and in
 * the permissive direction.
 *
 * `user` is the one exception, and it is a judgement rather than an oversight:
 * it holds identity (name, email, role, ban state) and no credential -- the
 * tokens live in `session`, the password and provider material in `account`,
 * the one-time codes in `verification`. It is also the table every
 * "did every account get X" question joins against, which is the question this
 * tool was built for. Excluding it would leave the tool unable to answer the
 * thing it exists to answer, while protecting nothing.
 */
export const DENIED_TABLES: ReadonlySet<string> = new Set(
  Object.values(authSchema)
    .map((table) => getTableName(table))
    .filter((name) => name !== 'user'),
)

export class DbReadRefused extends Error {}

/**
 * Where a real statement separator sits, or -1 for none, or -2 when the text
 * could not be read to the end.
 *
 * This exists because the plan guard only ever inspects the statement it
 * explained, and nothing downstream guarantees that is the statement that
 * runs: one driver refuses a chained statement at parse and the other accepts
 * it, so the same input is safe on one deployment and not the other. A guard
 * whose correctness depends on which driver is underneath is the defect, not
 * the fix — so the second statement is refused here, before anything sees it.
 *
 * Only `;` separates statements in Postgres, so finding one outside every
 * construct that can legitimately contain it is sufficient. The constructs
 * are: line comments, block comments (which nest), single-quoted literals
 * (where `''` is the escape), quoted identifiers, and dollar quoting.
 *
 * **The bias is deliberate.** Mis-reading the text as being INSIDE a literal
 * would skip a real separator and fail open, so nothing here extends a
 * literal on a guess: a backslash is not treated as an escape, because with
 * `standard_conforming_strings` on it is not one, and treating it as one is
 * exactly the mistake that would swallow a closing quote. Anything that
 * cannot be read to the end returns -2 and is refused. Every uncertainty
 * resolves to rejection.
 */
function isIdentifierChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c)
}

/**
 * The index just past a single-quoted literal's closing quote, or -1 if it
 * does not close. `''` is a doubled quote in either mode; `escapes` adds
 * backslash escaping, which only `E'…'` has.
 */
function readSingleQuoted(sql: string, open: number, escapes: boolean): number {
  let i = open + 1
  while (i < sql.length) {
    const c = sql[i]
    if (escapes && c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      if (sql[i + 1] === "'") {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  return -1
}

export function findStatementBreak(sql: string): number {
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]

    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i)
      if (nl < 0) {
        return -1
      }
      i = nl + 1
      continue
    }

    if (c === '/' && sql[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1
          i += 2
        } else {
          i += 1
        }
      }
      if (depth > 0) {
        return -2
      }
      continue
    }

    // `E'…'` turns backslash escapes ON, which is the entire purpose of the
    // prefix and happens regardless of `standard_conforming_strings`. Read as
    // a plain literal, `\'` inside one looks like a close followed by an open,
    // and the lexer runs one quote out of phase for the rest of the statement
    // — stepping over a real separator. Scoped to this construct and no
    // further: in a plain literal a backslash is NOT an escape, and treating
    // it as one there is the failure this whole approach avoids.
    //
    // Adjacency is required, and measured (26.08.2026): `E '…'` with a space
    // or newline between is not an E-string at all, and neither is a quote
    // following an identifier — `role'x'` is a type name and a plain literal.
    // `U&'…'` is deliberately absent: its backslash introduces a unicode code
    // point and does NOT escape a quote, so it reads as a plain literal here,
    // which is what it is.
    if ((c === 'E' || c === 'e') && sql[i + 1] === "'" && !isIdentifierChar(sql[i - 1])) {
      const end = readSingleQuoted(sql, i + 1, true)
      if (end < 0) {
        return -2
      }
      i = end
      continue
    }

    if (c === "'") {
      const end = readSingleQuoted(sql, i, false)
      if (end < 0) {
        return -2
      }
      i = end
      continue
    }

    if (c === '"') {
      const quote = sql.indexOf('"', i + 1)
      if (quote < 0) {
        return -2
      }
      i = quote + 1
      continue
    }

    if (c === '$') {
      const tag = /^\$[A-Za-z_0-9]*\$/.exec(sql.slice(i))?.[0]
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length)
        if (end < 0) {
          return -2
        }
        i = end + tag.length
        continue
      }
      i += 1
      continue
    }

    if (c === ';') {
      return i
    }
    i += 1
  }
  return -1
}

/** The caller's statement with one trailing separator removed, if present. */
export function withoutTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;\s*$/, '')
}

/**
 * Sound on any driver: one statement in, so the statement the planner
 * described is the statement that runs.
 */
export function refuseIfChained(sql: string): void {
  const where = findStatementBreak(withoutTrailingSemicolon(sql))
  if (where === -2) {
    throw new DbReadRefused(
      'This statement could not be read to the end — an unterminated string, identifier or comment. It was not run.',
    )
  }
  if (where >= 0) {
    throw new DbReadRefused(
      'Only one statement at a time: what the planner is asked about has to be what runs, and a second statement would not be checked.',
    )
  }
}

/**
 * Every relation a plan will touch. Postgres nests plans arbitrarily deep
 * (`Plans`, `Subplans`, CTEs), so this walks whatever it is given rather than
 * assuming a shape, and reads `Relation Name` wherever it appears.
 */
export function relationsInPlan(plan: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(plan)) {
    for (const item of plan) {
      relationsInPlan(item, found)
    }
    return found
  }
  if (!plan || typeof plan !== 'object') {
    return found
  }
  for (const [key, value] of Object.entries(plan as Record<string, unknown>)) {
    if (key === 'Relation Name' && typeof value === 'string') {
      found.add(value)
    } else if (value && typeof value === 'object') {
      relationsInPlan(value, found)
    }
  }
  return found
}

/**
 * Whether what came back is recognisably a query plan at all.
 *
 * Without this, an unrecognised shape — a string, a null, no rows — walks to
 * an empty set, and an empty set is indistinguishable from "this plan touches
 * nothing denied". The guard would pass and the read would proceed: wrong in
 * the permissive direction, and silently, which is the one combination a
 * guard must never have. Not observed on either driver; refusing is what makes
 * it unable to happen rather than unlikely.
 */
export function looksLikePlan(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => looksLikePlan(item))
  }
  if (!value || typeof value !== 'object') {
    return false
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => key === 'Plan' || looksLikePlan(nested),
  )
}

/** The denied relations a plan touches, in the order they were found. */
export function deniedRelations(plan: unknown, denied: ReadonlySet<string> = DENIED_TABLES): string[] {
  return [...relationsInPlan(plan)].filter((name) => denied.has(name))
}

export function clampMaxRows(requested: unknown): number {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_MAX_ROWS
  return Math.min(Math.max(n, 1), MAX_MAX_ROWS)
}

/**
 * Wrap the caller's statement so the row cap is applied by the database rather
 * than by slicing what it already built, and so one extra row reveals whether
 * there were more.
 *
 * The wrap is not a guarantee that one statement arrives. A caller who closes
 * the parenthesis first -- `SELECT 1) AS a; SELECT ...; --` -- produces two
 * statements, and the plan guard above only ever saw the first. Whether the
 * second reaches the database is the DRIVER's property, not this function's,
 * and it differs by back-end: the embedded path goes through PGlite's extended
 * protocol, which takes one statement per call, while a remote `DATABASE_URL`
 * goes through node-postgres, whose simple protocol accepts several. So on one
 * deployment the escape is closed and on the other it is not, and neither fact
 * belongs to this wrapper.
 *
 * That is left as it is on purpose. This is a guardrail against reading the
 * credential surface in passing, and someone typing `) AS a;` is not passing.
 */
export function boundedQuery(sql: string, maxRows: number): string {
  return `SELECT * FROM (${withoutTrailingSemicolon(sql)}) AS bounded_read LIMIT ${maxRows + 1}`
}

/**
 * No bound parameters, deliberately. The caller writes the statement, so there
 * is no untrusted value being interpolated into it and nothing for binding to
 * protect — it would only add a placeholder dialect to get wrong.
 */
export interface QueryRunner {
  execute(sql: string): Promise<{ rows: Record<string, unknown>[] }>
}

/**
 * Run one statement under all three bounds. The runner is passed in so this
 * can be exercised against a fake as well as against a real transaction --
 * the refusal and the truncation report are the parts worth testing directly,
 * and neither needs a database to be wrong.
 */
export async function runBoundedRead(runner: QueryRunner, request: DbReadRequest): Promise<DbReadResult> {
  // Before anything else, and before any driver is involved: one statement in,
  // so the statement the planner is asked about is the statement that runs.
  refuseIfChained(request.sql)

  const maxRows = clampMaxRows(request.maxRows)
  const bounded = boundedQuery(request.sql, maxRows)

  await runner.execute('SET TRANSACTION READ ONLY')
  await runner.execute(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)

  // Ask the planner what this will read before reading anything.
  const explained = await runner.execute(`EXPLAIN (FORMAT JSON) ${bounded}`)
  const plan = explained.rows.map((row) => Object.values(row)[0])
  if (!looksLikePlan(plan)) {
    throw new DbReadRefused(
      'The database did not return a readable query plan, so what this statement reads could not be established and it was not run.',
    )
  }
  const refused = deniedRelations(plan)
  if (refused.length) {
    throw new DbReadRefused(
      `This tool does not read ${refused.join(', ')}: those hold credentials and session tokens. Everything else is readable.`,
    )
  }

  const result = await runner.execute(bounded)
  const truncated = result.rows.length > maxRows
  const capped = truncated ? result.rows.slice(0, maxRows) : result.rows
  const { rows, redactions } = redactEmails(capped)
  return { rows, rowCount: rows.length, truncated, maxRows, redactions }
}
