import { type DB, openDb } from './connect'

// Reuse one connection per process (and across HMR in dev). The runtime
// migrator runs inside openDb() before the database is exposed, so every query
// site sees an up-to-date schema.
//
// The whole handle is kept, not just the database. An embedded PGlite persists
// what it is holding when its driver is released, so a process with no route to
// `close` has no way to shut its database down cleanly — and keeping only the
// database here made that route unreachable for every caller in the app.
const globalForDb = globalThis as unknown as {
  __opencroftDb?: Promise<{ db: DB; close: () => Promise<void> }>
  __opencroftDbClosing?: Promise<void>
}

const handle = await (globalForDb.__opencroftDb ??= openDb())

export const db = handle.db

/**
 * Release the driver, flushing an embedded database to disk.
 *
 * Idempotent, and safe to call from two places at once: the first call owns the
 * close and every later one awaits that same promise. Two shutdown signals
 * arriving together must not release the driver twice.
 *
 * Nothing re-opens afterwards. This is for a process that is stopping, not a
 * connection pool to be cycled — a query issued after it will fail, which is
 * the honest outcome for a caller still working during shutdown.
 */
export function closeDb(): Promise<void> {
  return (globalForDb.__opencroftDbClosing ??= handle.close())
}

export { migrationsFolder, openDb } from './connect'
export * from './schema'
export type { DB }
