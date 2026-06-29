import path from 'node:path'

import type { NodePgDatabase } from 'drizzle-orm/node-postgres'

import { schema } from './schema'

// Single shared database type so call sites don't care which driver backs it.
export type DB = NodePgDatabase<typeof schema>

// Migrations live next to this package; override with DB_MIGRATIONS_DIR for
// bundled/containerised runtimes where the source layout differs.
export const migrationsFolder = process.env.DB_MIGRATIONS_DIR ?? path.join(import.meta.dirname, '..', 'migrations')

function isRemote(url: string | undefined): url is string {
  return !!url && /^postgres(ql)?:\/\//.test(url)
}

/**
 * Open the Postgres-dialect database and apply pending migrations.
 *
 * Remote node-postgres when DATABASE_URL is a connection string; otherwise an
 * embedded PGlite database (real Postgres compiled to WASM, in-process) that
 * persists to the data volume. `close` flushes + releases the driver — call it
 * in one-shot scripts so an embedded PGlite persists before the process exits.
 */
export async function openDb(): Promise<{ db: DB; close: () => Promise<void> }> {
  const url = process.env.DATABASE_URL
  if (isRemote(url)) {
    const { drizzle } = await import('drizzle-orm/node-postgres')
    const db = drizzle(url, { schema })
    const { migrate } = await import('drizzle-orm/node-postgres/migrator')
    await migrate(db, { migrationsFolder })
    return { db, close: async () => void (await (db.$client as { end?: () => Promise<void> }).end?.()) }
  }

  const { PGlite } = await import('@electric-sql/pglite')
  const { drizzle } = await import('drizzle-orm/pglite')
  const dataDir = process.env.PGLITE_PATH ?? path.join(process.cwd(), 'data', 'pglite')
  const client = new PGlite(dataDir)
  const db = drizzle(client, { schema })
  const { migrate } = await import('drizzle-orm/pglite/migrator')
  await migrate(db, { migrationsFolder })
  return { db: db as unknown as DB, close: async () => void (await client.close()) }
}
