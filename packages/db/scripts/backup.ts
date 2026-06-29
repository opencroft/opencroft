// Write a connector-agnostic JSON backup of the current database.
//   node scripts/backup.ts [out.json]   (omit to write to stdout)
// Honors the usual DATABASE_URL / PGLITE_PATH / DB_MIGRATIONS_DIR env.

import fs from 'node:fs'

import { createBackup } from '@opencroft/db/backup'
import { openDb } from '@opencroft/db/connect'

const out = process.argv[2]
const { db, close } = await openDb()
const backup = await createBackup(db)
await close()

const json = JSON.stringify(backup, null, 2)
const total = Object.values(backup.tables).reduce((a, rows) => a + rows.length, 0)
if (out) {
  fs.writeFileSync(out, json)
  console.error(`Backup written to ${out} (${total} rows across ${Object.keys(backup.tables).length} tables)`)
} else {
  process.stdout.write(`${json}\n`)
}
process.exit(0)
