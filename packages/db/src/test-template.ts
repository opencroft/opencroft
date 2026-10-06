import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Where a test run keeps the migrated datadir its test files start from, or undefined outside a
 * run of scripts/run-tests.mjs, which owns OPENCROFT_TEST_RUN_DIR and removes it when the run ends.
 *
 * Opening an empty datadir runs initdb and then every migration, which costs seconds per test
 * process; copying a datadir that already went through both costs a fraction of one. The migrator
 * still runs on the copy and finds nothing to apply, so a suite sees the same schema either way.
 */
export function templateDatadir(): string | undefined {
  const runDir = process.env.OPENCROFT_TEST_RUN_DIR
  return runDir ? join(runDir, 'pglite-template') : undefined
}

/**
 * The same template as one uncompressed tar of the datadir, the form PGlite loads into an
 * in-memory database (see test-memory-db.ts). Undefined outside a run, like the datadir.
 */
export function templateDump(): string | undefined {
  const runDir = process.env.OPENCROFT_TEST_RUN_DIR
  return runDir ? join(runDir, 'pglite-template.tar') : undefined
}

/**
 * Build the template datadir: a fresh embedded database with every migration applied, closed so
 * that everything is flushed to disk before any test process copies it. Then dump it, for the
 * test processes that open their database in memory.
 *
 * Meant for a workspace's once-per-run test setup. Throws outside a test run, and on whatever
 * error opening or migrating raised -- a migration that fails here fails in every suite as well.
 */
export async function buildTemplateDatadir(): Promise<void> {
  const dir = templateDatadir()
  const dump = templateDump()
  if (!dir || !dump) {
    throw new Error('buildTemplateDatadir runs inside a test run: OPENCROFT_TEST_RUN_DIR is not set')
  }
  // openDb reads its target from the environment. This process exists to build the template, so
  // pointing it here for good is safe, and a real DATABASE_URL must never be what gets migrated.
  delete process.env.DATABASE_URL
  process.env.PGLITE_PATH = dir
  const { openDb } = await import('./connect')
  const { close } = await openDb()
  await close()

  // Reopened rather than dumped through openDb's client, which does not expose PGlite's own
  // methods; the template is closed and nothing else holds it yet. Written under a temporary name
  // and renamed, so a process never reads half a dump.
  const { PGlite } = await import('@electric-sql/pglite')
  const template = new PGlite(dir)
  try {
    await template.waitReady
    const tar = await template.dumpDataDir('none')
    await writeFile(`${dump}.partial`, Buffer.from(await tar.arrayBuffer()))
    await rename(`${dump}.partial`, dump)
  } finally {
    await template.close()
  }
}
