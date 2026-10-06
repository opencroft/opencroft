import { asc, type SQL, sql } from 'drizzle-orm'
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'

import type { DB } from './connect'

// Reads whose result is held under a byte budget, however large the rows are.
//
// The embedded PGlite builds a whole result in its wasm memory, and a result
// past about 15 MiB fails with "memory access out of bounds", after which
// every query fails until the database is reopened. Measured 02.10.2026 on
// PGlite 0.2.17: 15.3 MiB came back in one SELECT and 19.1 MiB did not,
// whether as two 10 MB rows, twenty 1 MB rows or a thousand 32 KB ones. The
// total is what counts, so a read is at risk as soon as the rows it can match
// are unbounded in number or in size, not only when one row is large.

/** The most row data one statement reads or writes. Far enough under the limit that a size estimate's error does not matter. */
export const STATEMENT_BYTE_BUDGET = 4 * 1024 * 1024

/** How many rows' keys and sizes one planning read fetches. */
const KEYS_PER_PLAN = 1_000

/**
 * Group `items` into batches of at most `maxCount` items and, where it can,
 * at most STATEMENT_BYTE_BUDGET bytes. An item larger than the budget on its
 * own still goes, alone in its batch.
 */
export async function* inBudget<T>(
  items: AsyncIterable<T> | Iterable<T>,
  bytesOf: (item: T) => number,
  maxCount: number,
): AsyncGenerator<T[]> {
  let batch: T[] = []
  let bytes = 0
  for await (const item of items) {
    const size = bytesOf(item)
    if (batch.length > 0 && (batch.length === maxCount || bytes + size > STATEMENT_BYTE_BUDGET)) {
      yield batch
      batch = []
      bytes = 0
    }
    batch.push(item)
    bytes += size
  }
  if (batch.length > 0) {
    yield batch
  }
}

export interface BoundedSelect {
  from: PgTable
  /** What each row is read as: columns, or expressions over them. */
  fields: Record<string, PgColumn | SQL>
  /**
   * Columns that identify a row among those `where` matches, in the order rows
   * come back. A primary key always qualifies; so does any unique key within
   * the filter, such as a position within one session.
   */
  key: PgColumn[]
  where?: SQL
}

const listOf = (parts: readonly unknown[]) =>
  sql.join(
    parts.map((part) => sql`${part}`),
    sql`, `,
  )

/** The query's own filter and `condition`, together. The key is unique only within the filter, so every read repeats it. */
function matching(query: BoundedSelect, condition: SQL | undefined): SQL | undefined {
  const conditions = [query.where, condition].filter((part): part is SQL => part !== undefined)
  return conditions.length > 0 ? sql.join(conditions, sql` and `) : undefined
}

interface PlannedRow {
  key: unknown[]
  bytes: number
}

/**
 * The keys and sizes of up to KEYS_PER_PLAN matching rows after `after`, in
 * key order.
 *
 * A row's size is its fields' length as text, the form a result crosses out
 * of the database in. Only keys and numbers come back, so this read stays
 * small however large the rows are.
 */
async function planPage(db: DB, query: BoundedSelect, after: unknown[] | undefined): Promise<PlannedRow[]> {
  const keyFields = Object.fromEntries(query.key.map((column, i) => [`k${i}`, column]))
  const bytes = sql.join(
    Object.values(query.fields).map((field) => sql`coalesce(octet_length((${field})::text), 0)`),
    sql` + `,
  )
  const rows = (await db
    .select({ ...keyFields, bytes: sql<number>`${bytes}`.mapWith(Number) })
    .from(query.from)
    .where(matching(query, after ? sql`(${listOf(query.key)}) > (${listOf(after)})` : undefined))
    .orderBy(...query.key.map((column) => asc(column)))
    .limit(KEYS_PER_PLAN)) as Record<string, unknown>[]
  return rows.map((row) => ({ key: query.key.map((_, i) => row[`k${i}`]), bytes: row.bytes as number }))
}

/**
 * Every row `query` matches, in key order, read in statements that each
 * return about STATEMENT_BYTE_BUDGET at most (or one row, where a single row
 * is larger than that).
 *
 * Yielded a batch at a time, so a caller that writes each row away holds one
 * batch rather than the whole result. Not a snapshot: a row deleted between
 * the planning read and its batch is skipped, and one inserted behind the
 * read's position is not seen.
 */
export async function* boundedSelect<T extends Record<string, unknown>>(
  db: DB,
  query: BoundedSelect,
): AsyncGenerator<T> {
  let after: unknown[] | undefined
  for (;;) {
    const plan = await planPage(db, query, after)
    for await (const batch of inBudget(plan, (row) => row.bytes, KEYS_PER_PLAN)) {
      const keys = sql.join(
        batch.map((row) => sql`(${listOf(row.key)})`),
        sql`, `,
      )
      yield* (await db
        .select(query.fields)
        .from(query.from)
        .where(matching(query, sql`(${listOf(query.key)}) in (${keys})`))
        .orderBy(...query.key.map((column) => asc(column)))) as T[]
    }
    if (plan.length < KEYS_PER_PLAN) {
      return
    }
    after = plan[plan.length - 1].key
  }
}
