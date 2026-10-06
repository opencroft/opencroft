// Restore a JSON backup (from scripts/backup.ts) into the current database,
// replacing all existing data in one transaction. The schema is migrated to the
// current version first, so older backups load cleanly.
//   node scripts/restore.ts <backup.json>
// Honors the usual DATABASE_URL / PGLITE_PATH / DB_MIGRATIONS_DIR env.

import fs from 'node:fs'

import { type Backup, backupSource, restoreBackup } from '@opencroft/db/backup'
import { openDb } from '@opencroft/db/connect'

const file = process.argv[2]
if (!file) {
  console.error('usage: node scripts/restore.ts <backup.json>')
  process.exit(1)
}

const backup = JSON.parse(fs.readFileSync(file, 'utf8')) as Backup
const { db, close } = await openDb()
const summary = await restoreBackup(db, backupSource(backup))
await close()

// From the restore itself, not from the file: rows the current schema cannot
// take are dropped on the way in, and a count read off the file would report
// them as restored.
const total = Object.values(summary.restored).reduce((a, rows) => a + rows, 0)
console.error(`Restored ${total} rows across ${Object.keys(summary.restored).length} tables from ${file}.`)
if (summary.uncovered.length > 0) {
  console.error(`Left untouched (not in this backup): ${summary.uncovered.join(', ')}`)
}
if (summary.unknown.length > 0) {
  console.error(`Ignored (no such table): ${summary.unknown.join(', ')}`)
}
process.exit(0)
