// The migration that set `runner` apart from `kind`, run the way it runs for
// real: on a database that already has 0034's table with rows in it, as a deployed one's
// did when it arrived. Every `tool` row then was a command the runner had
// detached on its node, and the backfill must say so — read as in-process, the
// ones still running would be failed by the next restart's sweep instead of
// probed on their nodes.
//
// A scratch database in memory: migrated through 0034 from a copy of the
// migrations that stops there, filled the way the code before the column
// filled the table, then migrated from the real folder, which applies what
// comes after — and nothing before it again.
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { PGlite } from '@electric-sql/pglite'
import { migrationsFolder } from '@opencroft/db/connect'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'

const LAST_BEFORE = '0034_add_background_task'
const THE_MIGRATION = '0035_add_background_task_runner'

type Db = ReturnType<typeof drizzle>

interface JournalEntry {
  tag: string
}

const scratch = mkdtempSync(path.join(tmpdir(), 'bg-task-runner-migration-'))
const pg = new PGlite()
const db = drizzle(pg)

after(async () => {
  await pg.close()
  rmSync(scratch, { recursive: true, force: true })
})

/** The migrations folder as it stood before `runner`: every entry through 0034, nothing after. */
function migrationsThrough(tag: string): { folder: string; applied: number; total: number } {
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta', '_journal.json'), 'utf8'))
  const entries: JournalEntry[] = journal.entries
  const last = entries.findIndex((entry) => entry.tag === tag)
  assert.ok(last >= 0, `${tag} is in the journal`)
  assert.equal(entries[last + 1]?.tag, THE_MIGRATION, 'the migration under test comes straight after it')
  const kept = entries.slice(0, last + 1)
  mkdirSync(path.join(scratch, 'meta'), { recursive: true })
  writeFileSync(path.join(scratch, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }))
  for (const entry of kept) {
    copyFileSync(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(scratch, `${entry.tag}.sql`))
  }
  return { folder: scratch, applied: kept.length, total: entries.length }
}

/** A row as the code before the column wrote one: no `runner` named. */
async function insertAsBefore(
  target: Db,
  row: { taskId: string; kind: string; state: string; name: string; nodeDir?: string },
): Promise<void> {
  await target.execute(sql`
    INSERT INTO "BackgroundTask"
      ("taskId", "instanceId", "kind", "name", "target", "summary", "state", "startedAt", "nodeDir")
    VALUES
      (${row.taskId}, 'instance-a', ${row.kind}, ${row.name}, 'buildbox/terminal', 'from before the column',
       ${row.state}, now(), ${row.nodeDir ?? null})
  `)
}

async function appliedCount(target: Db): Promise<number> {
  const result = await target.execute(sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`)
  return (result.rows[0] as { n: number }).n
}

function sqlState(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } }
  return e?.code ?? e?.cause?.code
}

test('rows from before the column: every tool task moves to the runner, every action stays in-process', async () => {
  const before = migrationsThrough(LAST_BEFORE)
  await migrate(db, { migrationsFolder: before.folder })
  assert.equal(await appliedCount(db), before.applied)

  const rows = [
    // A command still out on its node, one that finished, and a start that
    // never got as far as a directory — all three the runner's.
    { taskId: 'tool-running', kind: 'tool', state: 'running', name: 'remote_exec', nodeDir: '/tmp/opencroft-tasks/a' },
    {
      taskId: 'tool-completed',
      kind: 'tool',
      state: 'completed',
      name: 'remote_script',
      nodeDir: '/tmp/opencroft-tasks/b',
    },
    { taskId: 'tool-never-started', kind: 'tool', state: 'failed', name: 'remote_exec' },
    { taskId: 'app-action-running', kind: 'app-action', state: 'running', name: 'deploy' },
    { taskId: 'node-action-stopped', kind: 'node-action', state: 'stopped', name: 'backup' },
  ]
  for (const row of rows) {
    await insertAsBefore(db, row)
  }

  await migrate(db, { migrationsFolder })
  assert.equal(await appliedCount(db), before.total, 'the migrations after 0034 applied, and only those')

  const result = await db.execute(sql`SELECT "taskId", "kind", "runner" FROM "BackgroundTask" ORDER BY "taskId"`)
  assert.deepEqual(
    Object.fromEntries((result.rows as { taskId: string; runner: string }[]).map((row) => [row.taskId, row.runner])),
    {
      'app-action-running': 'in-process',
      'node-action-stopped': 'in-process',
      'tool-completed': 'background-task-runner',
      'tool-never-started': 'background-task-runner',
      'tool-running': 'background-task-runner',
    },
  )
})

test('after it, a writer that names no runner is recorded in-process, and none can record no runner at all', async () => {
  // A process still on the code from before the column, sharing the database.
  await insertAsBefore(db, { taskId: 'written-after', kind: 'app-action', state: 'running', name: 'deploy' })
  const result = await db.execute(sql`SELECT "runner" FROM "BackgroundTask" WHERE "taskId" = 'written-after'`)
  assert.deepEqual(result.rows, [{ runner: 'in-process' }])

  const refused = await db
    .execute(sql`UPDATE "BackgroundTask" SET "runner" = NULL WHERE "taskId" = 'written-after'`)
    .then(
      () => null,
      (error: unknown) => error,
    )
  // 23502: not_null_violation — the refusal meant, and no other.
  assert.equal(sqlState(refused), '23502')
})
