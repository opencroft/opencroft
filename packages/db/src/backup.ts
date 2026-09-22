import { getTableColumns, getTableName, is } from 'drizzle-orm'
import { getTableConfig, type PgColumn, PgTable } from 'drizzle-orm/pg-core'

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
    const columns = getTableColumns(value) as Record<string, PgColumn>
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
    byName.set(name, { name, table: value, columns, dateProps, dependsOn })
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
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

function insertChunkSize(columnCount: number): number {
  return Math.max(1, Math.min(MAX_ROWS_PER_INSERT, Math.floor(PG_MAX_BIND_PARAMS / Math.max(1, columnCount))))
}

/**
 * Narrow a stored row to what the current schema can accept.
 *
 * Columns added since the backup was written are simply absent and take their
 * defaults. Columns dropped since are discarded HERE rather than left to the
 * driver: drizzle builds an insert from the keys it is handed and looks each
 * one up on the table, so an unknown key does not get ignored, it throws.
 */
function reviveRow(row: Record<string, unknown>, spec: TableSpec): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const prop of Object.keys(spec.columns)) {
    if (Object.hasOwn(row, prop)) {
      out[prop] = row[prop]
    }
  }
  for (const prop of spec.dateProps) {
    const value = out[prop]
    if (typeof value === 'string' || typeof value === 'number') {
      out[prop] = new Date(value)
    }
  }
  return out
}

/** Snapshot every covered table into a portable object (JSON.stringify-ready). */
export async function createBackup(db: DB): Promise<Backup> {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const { name, table } of BACKED_UP_TABLES) {
    tables[name] = (await db.select().from(table)) as Record<string, unknown>[]
  }
  return { formatVersion: BACKUP_FORMAT_VERSION, createdAt: new Date().toISOString(), tables }
}

/**
 * Replace the covered tables' contents with the backup's, in one transaction.
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
export async function restoreBackup(db: DB, backup: Backup): Promise<RestoreSummary> {
  if (!backup || typeof backup !== 'object' || !backup.tables || typeof backup.tables !== 'object') {
    throw new Error('Invalid backup: missing tables')
  }
  const covered = BACKED_UP_TABLES.filter((spec) => Object.hasOwn(backup.tables, spec.name))
  const summary: RestoreSummary = {
    restored: {},
    uncovered: ALL_TABLES.filter((spec) => !covered.includes(spec)).map((spec) => spec.name),
    unknown: Object.keys(backup.tables).filter((name) => !ALL_TABLES.some((spec) => spec.name === name)),
  }
  await db.transaction(async (tx) => {
    for (const spec of [...covered].reverse()) {
      await tx.delete(spec.table)
    }
    for (const spec of covered) {
      const rows = backup.tables[spec.name] ?? []
      const revived = rows
        .filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
        .map((row) => reviveRow(row, spec))
      summary.restored[spec.name] = revived.length
      const chunk = insertChunkSize(Object.keys(spec.columns).length)
      for (let i = 0; i < revived.length; i += chunk) {
        await tx.insert(spec.table).values(revived.slice(i, i + chunk))
      }
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
