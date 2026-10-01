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
 *
 * If the embedded database's WebAssembly runtime crashes, it is reopened on
 * the same datadir behind the same `db` (see RecoveringPGlite); the process
 * exits non-zero only if that reopen fails.
 *
 * The embedded branch takes an advisory lock on the datadir first and throws
 * `DatadirBusyError` if another process holds it, rather than opening a stale
 * copy of the database. Only the embedded branch: a real Postgres server does
 * its own locking.
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
  // PGlite's own nodefs does not create intermediate directories, so a data
  // volume that has never been written to (a fresh checkout, a first deploy)
  // fails here instead of just starting up.
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dataDir, { recursive: true })

  // Before the datadir is opened, never after. PGlite will happily open a
  // directory another process is already holding: it succeeds, hands back a
  // stale database, and on close can discard the other process's writes with
  // both sides exiting 0. The lock turns that into a refusal naming the
  // holder. Keyed to the directory, so the throwaway datadir a test run makes
  // for itself never contends with anything.
  const { lockDatadir } = await import('./datadir-lock')
  const lock = await lockDatadir(dataDir)
  try {
    const { RecoveringPGlite } = await import('./recovering-pglite')
    const client = new RecoveringPGlite({
      open: async () => {
        const instance = new PGlite(dataDir)
        await instance.waitReady
        return instance
      },
      // The crash and the reopen failure are already logged. Exiting is what
      // is left: a process whose database cannot open serves nothing but
      // errors, and a supervisor that restarts it is the only way back.
      onReopenFailed: () => process.exit(1),
    })
    // The drizzle driver calls only `query` and `transaction` on its client,
    // which is exactly what RecoveringPGlite provides.
    const db = drizzle(client as unknown as InstanceType<typeof PGlite>, { schema })
    const { migrate } = await import('drizzle-orm/pglite/migrator')
    await migrate(db, { migrationsFolder })
    return {
      db: db as unknown as DB,
      close: async () => {
        // finally, not sequential: a driver that fails to close must not also
        // leave the lock held for the rest of the process's life.
        try {
          await client.close()
        } finally {
          await lock.release()
        }
      },
    }
  } catch (error) {
    // Nothing was returned, so no caller can reach close() to release this.
    await lock.release()
    throw error
  }
}
