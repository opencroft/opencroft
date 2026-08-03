// The lock module has its own tests; this one is about the thing that
// actually protects the database — openDb() refusing, against a real PGlite
// datadir opened by a real second process. Without this, the unit tests would
// prove a lock works while saying nothing about whether the app takes it.

import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { openDb } from './connect'
import { DatadirBusyError } from './datadir-lock'

// A DATABASE_URL in the environment would send openDb down the node-postgres
// branch, where locking is Postgres's own problem — and these tests would
// silently stop testing anything.
process.env.DATABASE_URL = undefined
delete process.env.DATABASE_URL

const workdir = mkdtempSync(join(tmpdir(), 'opencroft-connect-lock-test-'))
const children: ChildProcess[] = []

after(() => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  rmSync(workdir, { recursive: true, force: true })
})

const openerScript = join(workdir, 'opener.mts')
writeFileSync(
  openerScript,
  [
    `import { openDb } from ${JSON.stringify(join(import.meta.dirname, 'connect.ts'))}`,
    'await openDb()',
    "console.log('OPEN')",
    'setInterval(() => {}, 1 << 30)',
    '',
  ].join('\n'),
)

/** Open the datadir for real in another process, and keep it open. */
async function startOpener(dataDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', openerScript], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PGLITE_PATH: dataDir },
  })
  children.push(child)
  let out = ''
  let err = ''
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (chunk) => {
      out += chunk
      if (out.includes('OPEN')) resolve()
    })
    child.stderr?.on('data', (chunk) => {
      err += chunk
    })
    child.once('exit', (code) => reject(new Error(`opener exited early (${code}): ${err}`)))
  })
  return child
}

test('openDb refuses a datadir another process already has open', async () => {
  const dataDir = join(workdir, 'live', 'pglite')
  const opener = await startOpener(dataDir)

  process.env.PGLITE_PATH = dataDir
  const error = await openDb().then(
    () => null,
    (e: unknown) => e,
  )

  // Today this call SUCCEEDS and hands back a stale database whose writes are
  // discarded on close, with both processes exiting 0. That is the whole bug.
  assert.ok(error instanceof DatadirBusyError, `expected DatadirBusyError, got ${String(error)}`)
  assert.equal(error.holder?.pid, opener.pid, 'the refusal must name the process that actually holds the datadir')
  assert.match(error.message, /Refusing to open the PGlite database/)
})

test('openDb closes cleanly and the datadir can then be opened again', async () => {
  // The release path matters as much as the refusal: a lock that outlived its
  // own process would make every one-shot script a single-use operation.
  const dataDir = join(workdir, 'reopen', 'pglite')
  process.env.PGLITE_PATH = dataDir

  const first = await openDb()
  await first.close()

  const second = await openDb()
  assert.ok(second.db, 'a released datadir must be openable again')
  await second.close()
})
