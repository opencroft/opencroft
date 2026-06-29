import type { PgTable } from 'drizzle-orm/pg-core'

import type { DB } from './connect'
import { appLink, mcpAuditLog, secret, setting, space } from './schema'

// Connector-agnostic logical backup: a plain-JSON, per-table row dump that
// restores into any Postgres-dialect backend (embedded PGlite or remote
// node-postgres) regardless of which one produced it. Timestamps serialize to
// ISO strings via JSON and are revived to Date on restore.

interface TableSpec {
  name: string
  table: PgTable
  /** Columns to revive from ISO string → Date when restoring. */
  dateCols: string[]
}

const TABLES: TableSpec[] = [
  { name: 'Setting', table: setting, dateCols: ['createdAt', 'updatedAt'] },
  { name: 'Secret', table: secret, dateCols: ['createdAt', 'updatedAt'] },
  { name: 'AppLink', table: appLink, dateCols: [] },
  { name: 'Space', table: space, dateCols: ['createdAt', 'updatedAt'] },
  { name: 'McpAuditLog', table: mcpAuditLog, dateCols: ['createdAt'] },
]

export const BACKUP_FORMAT_VERSION = 1

// Insert in batches so a table with many rows stays under Postgres’s 65535
// bind-parameter per-statement limit.
const INSERT_CHUNK = 500

export interface Backup {
  formatVersion: number
  createdAt: string
  tables: Record<string, Record<string, unknown>[]>
}

/** Snapshot every table into a portable object (JSON.stringify-ready). */
export async function createBackup(db: DB): Promise<Backup> {
  const tables: Record<string, Record<string, unknown>[]> = {}
  for (const { name, table } of TABLES) {
    tables[name] = (await db.select().from(table)) as Record<string, unknown>[]
  }
  return { formatVersion: BACKUP_FORMAT_VERSION, createdAt: new Date().toISOString(), tables }
}

/**
 * Replace all data with the backup's contents, in one transaction.
 *
 * The caller is expected to have already migrated the database to the current
 * schema (openDb does this). Older backups therefore load into the current
 * tables — columns added since are filled by their defaults; unknown columns in
 * the backup are ignored. We don't run cross-version data migrations.
 */
export async function restoreBackup(db: DB, backup: Backup): Promise<void> {
  if (!backup || typeof backup !== 'object' || !backup.tables) {
    throw new Error('Invalid backup: missing tables')
  }
  await db.transaction(async (tx) => {
    // No foreign keys between these tables, so delete order is irrelevant.
    for (const { table } of TABLES) {
      await tx.delete(table)
    }
    for (const { name, table, dateCols } of TABLES) {
      const rows = backup.tables[name] ?? []
      if (!rows.length) {
        continue
      }
      const revived = rows.map((row) => {
        const out: Record<string, unknown> = { ...row }
        for (const col of dateCols) {
          if (out[col] != null) {
            out[col] = new Date(out[col] as string)
          }
        }
        return out
      })
      for (let i = 0; i < revived.length; i += INSERT_CHUNK) {
        await tx.insert(table).values(revived.slice(i, i + INSERT_CHUNK))
      }
    }
  })
}
