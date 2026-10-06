// The template a test run's datadirs are copied from. What matters about it is that a copy is the
// database a suite would otherwise have built for itself: every migration applied, and flushed, so a
// process opening the copy finds them all recorded and has nothing left to run.

import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { PGlite } from '@electric-sql/pglite'

import { migrationsFolder } from './connect'
import { openMemoryDb } from './test-memory-db'
import { buildTemplateDatadir, templateDatadir, templateDump } from './test-template'

const workdir = mkdtempSync(join(tmpdir(), 'opencroft-test-template-test-'))
const ENV_KEYS = ['OPENCROFT_TEST_RUN_DIR', 'PGLITE_PATH', 'DATABASE_URL'] as const
const savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))

after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  rmSync(workdir, { recursive: true, force: true })
})

test('outside a test run there is no template, and building one is refused', async () => {
  delete process.env.OPENCROFT_TEST_RUN_DIR

  assert.equal(templateDatadir(), undefined)
  await assert.rejects(buildTemplateDatadir(), /OPENCROFT_TEST_RUN_DIR is not set/)
})

test('a copy of the template has every migration applied', async () => {
  process.env.OPENCROFT_TEST_RUN_DIR = workdir
  await buildTemplateDatadir()
  const template = templateDatadir()
  assert.ok(template)

  // A copy, opened by a client that is not the one that built it, is what a test process gets.
  const copy = join(workdir, 'copy')
  cpSync(template, copy, { recursive: true })
  const client = new PGlite(copy)
  try {
    const { rows } = await client.query<{ hash: string }>('select hash from drizzle.__drizzle_migrations')
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[]
    }
    assert.ok(journal.entries.length > 0, 'the package has migrations to apply')
    assert.equal(rows.length, journal.entries.length)
  } finally {
    await client.close()
  }
})

test('the template’s dump opens in memory with every migration applied', async () => {
  // Built by the case above; this one reads it back the way a test process does.
  process.env.OPENCROFT_TEST_RUN_DIR = workdir
  const dump = templateDump()
  // Without the file openMemoryDb migrates an empty database instead, which passes the count below.
  assert.ok(dump && existsSync(dump), 'building the template wrote its dump')

  const { db, close } = await openMemoryDb(dump)
  try {
    const { rows } = await db.execute<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations')
    const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
      entries: unknown[]
    }
    assert.equal(rows[0]?.n, journal.entries.length)
  } finally {
    await close()
  }
})
