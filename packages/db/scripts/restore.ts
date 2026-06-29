// Restore a JSON backup (from scripts/backup.ts) into the current database,
// replacing all existing data in one transaction. The schema is migrated to the
// current version first, so older backups load cleanly.
//   node scripts/restore.ts <backup.json>
// Honors the usual DATABASE_URL / PGLITE_PATH / DB_MIGRATIONS_DIR env.

import fs from 'node:fs'

import { type Backup, restoreBackup } from '@opencroft/db/backup'
import { openDb } from '@opencroft/db/connect'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/restore.ts <backup.json>')
  process.exit(1)
}

const backup = JSON.parse(fs.readFileSync(file, 'utf8')) as Backup
const { db, close } = await openDb()
await restoreBackup(db, backup)
await close()

const total = Object.values(backup.tables).reduce((a, rows) => a + rows.length, 0)
console.error(`Restored ${total} rows from ${file}.`)
process.exit(0)
