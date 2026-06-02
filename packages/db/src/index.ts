import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { createPrismaCompat } from './prisma-compat'
import { schema } from './schema'

// SQLite lives under the app's working directory. On a fresh data volume, seed
// it from the baked schema copy (mirrors the previous Prisma setup).
const dataDir = path.join(process.cwd(), 'data')
const dbFile = path.join(dataDir, 'opencroft.db')
const seedFile = path.join(process.cwd(), 'seed.db')

if (!fs.existsSync(dbFile) && fs.existsSync(seedFile)) {
  fs.mkdirSync(dataDir, { recursive: true })
  fs.copyFileSync(seedFile, dbFile)
}

const globalForDb = globalThis as unknown as { __opencroftSqlite?: Database.Database }
const sqlite = globalForDb.__opencroftSqlite ?? new Database(dbFile)
if (process.env.NODE_ENV !== 'production') {
  globalForDb.__opencroftSqlite = sqlite
}

export const db = drizzle({ client: sqlite, schema })

/** Deprecated Prisma-compatible facade — kept for the `host.prisma` extension API. */
export const prisma = createPrismaCompat(db)

export { schema }
export * from './schema'
export type DB = typeof db
