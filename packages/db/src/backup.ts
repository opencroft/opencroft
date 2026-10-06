import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { getTableConfig, type PgColumn, PgTable } from 'drizzle-orm/pg-core'

import { boundedSelect, inBudget } from './bounded-select'
import type { DB } from './connect'
import * as schemaExports from './schema'

// Connector-agnostic logical backup: a plain-JSON, per-table row dump that
// restores into any Postgres-dialect backend (embedded PGlite or remote
// node-postgres) regardless of which one produced it. Timestamps serialize to
// ISO strings via JSON and are revived to Date on restore.
//
// THE TABLE LIST IS DERIVED FROM THE SCHEMA, not written out here. The
// hand-written list this replaces named four tables — Setting, Secret, Space,
// McpAuditLog — and was last touched when the database moved to Postgres. By
// then the schema had twenty-seven, so every backup taken since silently
// carried no graphs (SpaceGraph), no App instances (SpaceApp), no group chats,
// no agent queue and no accounts, and nothing anywhere said so: a table that
// is absent from the dump is also absent from the delete pass, so restores
// looked clean. A list that must be edited by hand to stay correct will not
// be, so this one is read off the schema instead and `backup.test.ts` fails if
// a new table is neither covered nor named as deliberately excluded.

/**
 * Tables deliberately left out of a backup.
 *
 * Both hold short-lived credentials, and a restore empties them either way:
 * `user` IS carried, so every row of it is deleted before the reload, and
 * Better Auth's `session` rows cascade off that delete. Carrying them would
 * put live session tokens into a file people download and pass around, in
 * exchange for rows that are already invalid by the time anyone restores them.
 *
 * `account` is NOT here: it holds the password hash and the stored OAuth
 * access/refresh tokens, which are an account's contents rather than one
 * browser's login, and a restore that drops them leaves the installation with
 * no way in.
 *
 * `resetDatabase` still clears these — it wipes everything the schema knows.
 */
const EXCLUDED_FROM_BACKUP: ReadonlySet<string> = new Set(['session', 'verification'])

/** Postgres refuses a statement carrying more than this many bind parameters. */
const PG_MAX_BIND_PARAMS = 65_535

/** Cap on one insert's row count, so a narrow table doesn't build a statement out of 60k rows. */
const MAX_ROWS_PER_INSERT = 1_000

export const BACKUP_FORMAT_VERSION = 2

export interface Backup {
  formatVersion: number
  createdAt: string
  /**
   * SQL table name -> its rows. A KEY BEING PRESENT IS THE CLAIM that this
   * table's contents are exactly these rows, and restore acts on that claim by
   * clearing the table first. A table absent from here is one the backup says
   * nothing about, and restore leaves it alone — which is what lets a v1 file,
   * written when only four tables were covered, still load.
   */
  tables: Record<string, Record<string, unknown>[]>
}

/**
 * What a restore reads its rows from, one table at a time.
 *
 * A source rather than a `Backup` so that no reader has to hold a whole backup
 * at once: the object form is one value, and the file it comes from is one
 * string, which V8 caps at about 512 MiB.
 */
export interface BackupSource {
  /**
   * The tables the backup covers. Naming one IS THE CLAIM that its contents
   * are exactly the rows `rows` yields, and restore clears it first. A table
   * not named is one the backup says nothing about, and restore leaves it be.
   */
  tables: readonly string[]
  /** One covered table's rows. Asked for once per covered table, parents first. */
  rows(table: string): AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>
}

export interface RestoreSummary {
  /** SQL table name -> rows inserted, for the tables the backup covered. */
  restored: Record<string, number>
  /** Tables in the current schema the backup said nothing about. Left untouched. */
  uncovered: string[]
  /** Keys in the backup matching no table in the current schema. Ignored. */
  unknown: string[]
}

interface TableSpec {
  /** The SQL table name — the key it appears under in a backup. */
  name: string
  table: PgTable
  /**
   * Property name -> column, in the JS spelling. `db.select()` returns rows
   * keyed this way and `insert().values()` expects them this way, so this is
   * the spelling a backup file stores; the SQL column name never appears.
   */
  columns: Record<string, PgColumn>
  /** Properties to revive from ISO string to Date on restore. */
  dateProps: string[]
  /** SQL names of the tables this one points at through a foreign key. */
  dependsOn: string[]
  /** The primary key's columns, in key order: what a backup pages through the table by. */
  key: PgColumn[]
}

function collectTables(): TableSpec[] {
  const byName = new Map<string, TableSpec>()
  for (const value of Object.values(schemaExports as Record<string, unknown>)) {
    if (!is(value, PgTable)) {
      continue
    }
    const name = getTableName(value)
    if (byName.has(name)) {
      continue
    }
    // A generated column is the database's to compute: it is not carried in a
    // backup, and an insert naming one is refused, so a restore leaves it out
    // and Postgres fills it in from the columns it is generated from.
    const columns = Object.fromEntries(
      Object.entries(getTableColumns(value) as Record<string, PgColumn>).filter(([, column]) => !column.generated),
    )
    const dateProps = Object.entries(columns)
      .filter(([, column]) => column.dataType === 'date')
      .map(([prop]) => prop)
    // Self-references are dropped: a row pointing at its own table orders
    // nothing, and keeping the edge would turn the sort below into a cycle.
    const dependsOn = [
      ...new Set(
        getTableConfig(value)
          .foreignKeys.map((fk) => getTableName(fk.reference().foreignTable))
          .filter((target) => target !== name),
      ),
    ]
    byName.set(name, { name, table: value, columns, dateProps, dependsOn, key: primaryKeyOf(name, value) })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * A table's primary key columns, declared on a column or as a composite key.
 *
 * Throws for a table with none: it could only be read in one SELECT, which is
 * the read this module exists to avoid, so a keyless table fails at load
 * rather than in the first backup that outgrows it.
 */
function primaryKeyOf(name: string, table: PgTable): PgColumn[] {
  const composite = getTableConfig(table).primaryKeys[0]
  if (composite) {
    return composite.columns
  }
  const single = Object.values(getTableColumns(table) as Record<string, PgColumn>).filter((column) => column.primary)
  if (single.length !== 1) {
    throw new Error(`${name} has no primary key, which a backup pages through the table by`)
  }
  return single
}

/**
 * Parents before children, so an insert never lands on an absent foreign key.
 *
 * Kahn's algorithm, with ties broken by name so two runs produce byte-identical
 * files. A cycle cannot be ordered at all — Postgres would need deferred
 * constraints for one — and there is none in this schema; should one appear,
 * the tables in it are appended in name order rather than dropped, so the
 * failure is a foreign-key error naming the table rather than a silently
 * shorter backup.
 */
function inDependencyOrder(specs: TableSpec[]): TableSpec[] {
  const remaining = new Map(specs.map((spec) => [spec.name, spec]))
  const ordered: TableSpec[] = []
  const placed = new Set<string>()
  while (remaining.size > 0) {
    const ready = [...remaining.values()].filter((spec) =>
      spec.dependsOn.every((dep) => placed.has(dep) || !remaining.has(dep)),
    )
    if (ready.length === 0) {
      ordered.push(...remaining.values())
      break
    }
    for (const spec of ready) {
      ordered.push(spec)
      placed.add(spec.name)
      remaining.delete(spec.name)
    }
  }
  return ordered
}

const ALL_TABLES = inDependencyOrder(collectTables())
const BACKED_UP_TABLES = ALL_TABLES.filter((spec) => !EXCLUDED_FROM_BACKUP.has(spec.name))

/** Every table the schema declares, parents first. */
export function allTableNames(): string[] {
  return ALL_TABLES.map((spec) => spec.name)
}

/** The tables a backup carries, parents first. */
export function backedUpTableNames(): string[] {
  return BACKED_UP_TABLES.map((spec) => spec.name)
}

/** The tables deliberately left out of a backup. */
export function excludedTableNames(): string[] {
  return ALL_TABLES.filter((spec) => EXCLUDED_FROM_BACKUP.has(spec.name)).map((spec) => spec.name)
}

function insertChunkSize(spec: TableSpec): number {
  const columnCount = Object.keys(spec.columns).length
  return Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(PG_MAX_BIND_PARAMS / Math.max(1, columnCount))))
}

/**
 * One covered table's rows, as a backup stores them, in primary-key order.
 *
 * Never in one SELECT, whatever the table: see `boundedSelect` for the limit
 * a whole table outgrows. Yielded one at a time so a caller can write each
 * away before the next batch is read, which keeps the backup's memory at one
 * batch rather than the whole table. A row deleted while the table is being
 * read is not in the backup, as it would not have been a moment later.
 */
export async function* backupRows(db: DB, table: string): AsyncGenerator<Record<string, unknown>> {
  const spec = BACKED_UP_TABLES.find((candidate) => candidate.name === table)
  if (!spec) {
    throw new Error(`${table} is not a table a backup carries`)
  }
  yield* boundedSelect(db, { from: spec.table, fields: spec.columns, key: spec.key })
}

/**
 * Narrow a stored row to what the current schema can accept.
 *
 * Columns added since the backup was written are simply absent and take their
 * defaults. So does a null in a column that has since become required and has
 * a default (a space's icon): left in, it would fail the whole restore.
 * Columns dropped since are discarded HERE rather than left to the driver:
 * drizzle builds an insert from the keys it is handed and looks each one up on
 * the table, so an unknown key does not get ignored, it throws.
 */
function reviveRow(row: Record<string, unknown>, spec: TableSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [prop, column] of Object.entries(spec.columns)) {
    if (!Object.hasOwn(row, prop)) {
      continue
    }
    if (row[prop] === null && column.notNull && column.hasDefault) {
      continue
    }
    out[prop] = row[prop]
  }
  for (const prop of spec.dateProps) {
    const value = out[prop]
    if (typeof value === 'string' || typeof value === 'number') {
      out[prop] = new Date(value)
    }
  }
  return out
}

async function* revivedRows(
  rows: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
  spec: TableSpec,
): AsyncGenerator<Record<string, unknown>> {
  for await (const row of rows) {
    if (row && typeof row === 'object') {
      yield reviveRow(row, spec)
    }
  }
}

/** About how many bytes a row's values take as statement parameters. */
function rowBytes(row: Record<string, unknown>): number {
  let bytes = 0
  for (const value of Object.values(row)) {
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value)
    } else if (value != null) {
      bytes += Buffer.byteLength(JSON.stringify(value) ?? '')
    }
  }
  return bytes
}

/**
 * Snapshot every covered table into one portable object (JSON.stringify-ready).
 *
 * The whole database in memory, and one string once serialised, so this is
 * for small databases only. Anything that has to keep working as the data
 * grows reads `backupRows` table by table instead.
 */
export async function createBackup(db: DB): Promise<Backup> {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const name of backedUpTableNames()) {
    const rows: Record<string, unknown>[] = []
    for await (const row of backupRows(db, name)) {
      rows.push(row)
    }
    tables[name] = rows
  }
  return { formatVersion: BACKUP_FORMAT_VERSION, createdAt: new Date().toISOString(), tables }
}

/** A `Backup` object as a restore source. Throws if `backup` is not shaped like one. */
export function backupSource(backup: Backup): BackupSource {
  if (!backup || typeof backup !== 'object' || !backup.tables || typeof backup.tables !== 'object') {
    throw new Error('Invalid backup: missing tables')
  }
  return { tables: Object.keys(backup.tables), rows: (table) => backup.tables[table] ?? [] }
}

/**
 * Replace the covered tables' contents with the source's, in one transaction.
 *
 * The caller is expected to have already migrated the database to the current
 * schema (openDb does this). Older backups therefore load into the current
 * tables — see `reviveRow` for what happens to columns added or dropped since.
 * We don't run cross-version data migrations.
 *
 * Deletes run children-first and inserts parents-first, so neither pass leans
 * on a cascade to do its work. A cascade still fires where a covered parent is
 * cleared and an UNCOVERED child points at it — restoring a v1 file, which
 * carries Space but not SpaceGraph, empties every graph that way. The returned
 * summary names the uncovered tables so a caller can say so before running.
 */
export async function restoreBackup(db: DB, source: BackupSource): Promise<RestoreSummary> {
  const named = new Set(source.tables)
  const covered = BACKED_UP_TABLES.filter((spec) => named.has(spec.name))
  const summary: RestoreSummary = {
    restored: {},
    uncovered: ALL_TABLES.filter((spec) => !covered.includes(spec)).map((spec) => spec.name),
    unknown: [...named].filter((name) => !ALL_TABLES.some((spec) => spec.name === name)),
  }
  await db.transaction(async (tx) => {
    for (const spec of [...covered].reverse()) {
      await tx.delete(spec.table)
    }
    for (const spec of covered) {
      let restored = 0
      for await (const batch of inBudget(revivedRows(source.rows(spec.name), spec), rowBytes, insertChunkSize(spec))) {
        await tx.insert(spec.table).values(batch)
        restored += batch.length
      }
      summary.restored[spec.name] = restored
    }
  })
  return summary
}

/** Deletes every row from every table, leaving the schema and migrations intact. */
export async function resetDatabase(db: DB): Promise<void> {
  await db.transaction(async (tx) => {
    for (const spec of [...ALL_TABLES].reverse()) {
      await tx.delete(spec.table)
    }
  })
}
