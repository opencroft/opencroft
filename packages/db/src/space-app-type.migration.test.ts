// The migration that folds an app instance's extension id and App slug into one
// qualified `type`, run for real: the schema as it stood before it, rows in the
// old shape, then the migration itself — and what the rows hold afterwards.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { after, before } from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

import { migrationsFolder } from './connect'

const MIGRATION = '0046_space_app_type'

interface Journal {
  entries: Array<{ tag: string }>
}

let client: PGlite
let before46: string

// The migrations folder as it stood just before this migration: the same files,
// with the journal ending one entry earlier.
function foldersBefore(tag: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'space-app-type-'))
  cpSync(migrationsFolder, dir, { recursive: true })
  const journalFile = path.join(dir, 'meta', '_journal.json')
  const journal = JSON.parse(readFileSync(journalFile, 'utf-8')) as Journal
  const at = journal.entries.findIndex((entry) => entry.tag === tag)
  assert.ok(at > 0, `${tag} is in the journal`)
  writeFileSync(journalFile, JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }))
  return dir
}

before(async () => {
  before46 = foldersBefore(MIGRATION)
  client = new PGlite()
  await migrate(drizzle(client), { migrationsFolder: before46 })
})

after(async () => {
  await client?.close()
  rmSync(before46, { recursive: true, force: true })
})

test('every existing instance takes its old extension id and App slug as one qualified type', async () => {
  const now = new Date().toISOString()
  await client.query(
    `INSERT INTO "Space" (id, slug, name, "createdAt", "updatedAt") VALUES ('space-1', 'one', 'One', $1, $1)`,
    [now],
  )
  const rows = [
    // A graph as stored before ids were dotted, and after.
    ['app-1', 'builtin/core', 'graph'],
    ['app-2', 'builtin.core', 'graph'],
    // A local extension's App, and an installed one's under its old folder id.
    ['app-3', 'local/git', 'git'],
    ['app-4', 'installed/acme-file-manager', 'file-manager'],
  ]
  for (const [id, extensionId, appSlug] of rows) {
    await client.query(
      `INSERT INTO "SpaceApp" (id, "spaceId", "extensionId", "appSlug", name, slug, "createdAt", "updatedAt")
       VALUES ($1, 'space-1', $2, $3, $1, $1, $4, $4)`,
      [id, extensionId, appSlug, now],
    )
  }

  await migrate(drizzle(client), { migrationsFolder })

  const migrated = await client.query<{ id: string; type: string }>(`SELECT id, type FROM "SpaceApp" ORDER BY id`)
  assert.deepEqual(migrated.rows, [
    { id: 'app-1', type: 'builtin.core.graph' },
    { id: 'app-2', type: 'builtin.core.graph' },
    { id: 'app-3', type: 'local.git.git' },
    { id: 'app-4', type: 'installed.acme-file-manager.file-manager' },
  ])
  const columns = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'SpaceApp' ORDER BY column_name`,
  )
  const names = columns.rows.map((row) => row.column_name)
  assert.ok(names.includes('type'))
  assert.equal(names.includes('extensionId'), false)
  assert.equal(names.includes('appSlug'), false)
})
