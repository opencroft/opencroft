// The migration that deletes the legacy dashboard's settings, run for real:
// the schema as it stood before it, the dashboard's rows beside rows whose ids
// resemble them, then the migration itself — and which rows are left.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import { migrationsFolder } from './connect'

const MIGRATION = '0057_drop_legacy_dashboard_settings'

interface Journal {
  entries: Array<{ tag: string }>
}

let client: PGlite
let beforeMigration: string

// The migrations folder as it stood just before this migration: the same files,
// with the journal ending one entry earlier.
function foldersBefore(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'drop-legacy-dashboard-settings-'))
  cpSync(migrationsFolder, dir, { recursive: true })
  const journalFile = path.join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalFile, 'utf-8')) as Journal
  const at = journal.entries.findIndex((entry) => entry.tag === tag)
  assert.ok(at > 0, `${tag} is in the journal`)
  writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }))
  return dir
}

before(async () => {
  beforeMigration = foldersBefore(MIGRATION)
  client = new PGlite()
  await migrate(drizzle(client), { migrationsFolder: beforeMigration })
})

after(async () => {
  await client?.close()
  rmSync(beforeMigration, { recursive: true, force: true })
})

test("deletes the legacy dashboard's settings and keeps every other row", async () => {
  const ids = [
    'app-dashboard-graph',
    'custom-node-templates',
    'app-node:app-1',
    'app-node:app-2',
    'app-dashboard-mvp-graph',
    'app-dashboard-mvp-extension-storage',
    'my-app-node:app-1',
    'filemanager-connections',
  ]
  const now = new Date().toISOString()
  for (const id of ids) {
    await client.query(`INSERT INTO "Setting" (id, data, "createdAt", "updatedAt") VALUES ($1, '{}', $2, $2)`, [
      id,
      now,
    ])
  }

  await migrate(drizzle(client), { migrationsFolder })

  const rows = await client.query<{ id: string }>(`SELECT id FROM "Setting" ORDER BY id`)
  assert.deepEqual(
    rows.rows.map((row) => row.id),
    ['app-dashboard-mvp-extension-storage', 'app-dashboard-mvp-graph', 'filemanager-connections', 'my-app-node:app-1'],
  )
})
