import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import type { DB } from './connect'
import { migrationsFolder } from './connect'
import { schema } from './schema'

/**
 * Open the database a test process uses in memory instead of in a datadir -- for test processes
 * only, through test-env.ts; the app always goes through connect.ts's openDb.
 *
 * Why: an embedded PGlite on a datadir writes every page it changes to disk synchronously, and a
 * database test is mostly that. Measured 03.10.2026 on one suite of the app: 41 s of its 47 s
 * were spent in those writes, and the same suite ran in 5 s with its datadir in RAM.
 *
 * `dump` is the run's migrated template (test-template.ts), loaded instead of initialising and
 * migrating an empty cluster; without one the database is created empty and migrated here. The
 * migrator runs either way, so a suite sees the schema it would on a datadir.
 *
 * What a datadir has and this does not, which is why a suite that needs either opens a real one
 * (by setting PGLITE_PATH itself, or by calling openDb directly):
 *   - the datadir lock (datadir-lock.ts): there is no directory for a second process to open;
 *   - crash recovery (recovering-pglite.ts): reopening after a wasm trap starts from what is on
 *     disk, and here nothing is. A trap leaves this database failing every later query, so a test
 *     that causes one fails loudly rather than carrying on against a reset database.
 */
export async function openMemoryDb(dump: string | undefined): Promise<{ db: DB; close: () => Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  const loadDataDir = dump && existsSync(dump) ? new Blob([await readFile(dump)]) : undefined
  const client = new PGlite({ loadDataDir })
  await client.waitReady
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder })
  return { db: db as unknown as DB, close: () => client.close() }
}
