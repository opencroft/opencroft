import { type DB, openDb } from './connect'

// Reuse one connection per process (and across HMR in dev). The runtime
// migrator runs inside openDb() before the database is exposed, so every query
// site sees an up-to-date schema.
const globalForDb = globalThis as unknown as { __opencroftDb?: Promise<DB> }
export const db = await (globalForDb.__opencroftDb ??= openDb().then((r) => r.db))

export type { DB }
export { openDb, migrationsFolder } from './connect'
export * from './schema'
