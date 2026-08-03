// The lock only means anything ACROSS processes, so these tests use real
// child processes rather than a second call in this one. An in-process check
// would prove nothing about the case that has actually destroyed databases
// here — another process, often another container, opening the same datadir —
// and it could not test a hard kill at all, which is the property most likely
// to be got wrong: a lock that survives its dead holder does not protect
// anything, it just stops the app from ever starting again.

import assert from 'node:assert/strict'
import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import test, { after } from 'node:test'

import { DatadirBusyError, lockDatadir, lockPathFor } from './datadir-lock'

const workdir = mkdtempSync(join(tmpdir(), 'opencroft-datadir-lock-test-'))
const holders: ChildProcess[] = []

after(() => {
  for (const child of holders) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
    }
  }
  rmSync(workdir, { recursive: true, force: true })
})

// Run through tsx the same way the test runner itself does, so the child
// resolves this package's TypeScript exactly as the suite does. `.mts` rather
// than `.ts`: the file lives in a temp directory with no package.json above
// it, so without the explicit ESM extension tsx transforms it as CommonJS and
// the top-level await below fails to compile.
const holderScript = join(workdir, 'holder.mts')
writeFileSync(
  holderScript,
  [
    `import { lockDatadir } from ${JSON.stringify(join(import.meta.dirname, 'datadir-lock.ts'))}`,
    'await lockDatadir(process.argv[2])',
    "console.log('HELD')",
    'setInterval(() => {}, 1 << 30)',
    '',
  ].join('\n'),
)

function datadir(name: string): string {
  const dir = join(workdir, name, 'pglite')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Start a child that takes the lock and holds it until it is killed.
 *
 * `node --import tsx` rather than `npx tsx`: npx is a wrapper process, so the
 * pid we would hold is not the pid that holds the lock. Killing the wrapper
 * would leave the real holder alive — the SIGKILL test would then be measuring
 * the wrong process, and the assertion that the refusal names the holder's pid
 * would be comparing against the wrapper's.
 */
async function startHolder(dataDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--import', 'tsx', holderScript, dataDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  holders.push(child)
  let out = ''
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on('data', (chunk) => {
      out += chunk
      if (out.includes('HELD')) resolve()
    })
    let err = ''
    child.stderr?.on('data', (chunk) => {
      err += chunk
    })
    child.once('exit', (code) => reject(new Error(`holder exited early (${code}): ${err}`)))
  })
  return child
}

test('a second process is refused while another holds the datadir, and is told who holds it', async () => {
  const dir = datadir('busy')
  const holder = await startHolder(dir)

  const error = await lockDatadir(dir).then(
    () => null,
    (e: unknown) => e,
  )

  assert.ok(error instanceof DatadirBusyError, `expected DatadirBusyError, got ${String(error)}`)
  assert.equal(error.code, 'DATADIR_BUSY')
  // Not "someone holds this" — the actual holder, answering for itself. A pid
  // read out of a file could be any process, or none.
  assert.equal(error.holder?.pid, holder.pid, 'the refusal must name the process that actually holds the lock')
  assert.match(error.message, /already has it open/)
  assert.match(error.message, new RegExp(String(holder.pid)))
})

test('a holder killed with SIGKILL does not brick the next open', async () => {
  const dir = datadir('killed')
  const holder = await startHolder(dir)

  holder.kill('SIGKILL')
  await once(holder, 'exit')

  // The socket file outlives the process it belonged to. That is precisely the
  // state a stale lockfile-with-pid would refuse on forever, and the reason
  // this is a kernel-held binding instead: nothing is listening on it now.
  assert.ok(existsSync(lockPathFor(dir)), 'the socket file is expected to survive a hard kill')

  const lock = await lockDatadir(dir)
  assert.ok(lock, 'the next opener must be able to take the lock after a hard kill')
  await lock.release()
})

test('the same process cannot open one datadir twice', async () => {
  // This is not a theoretical case: importing the db package index opens the
  // database as an import side effect, so a script that then opens it again
  // holds two handles on one datadir inside a single process.
  const dir = datadir('twice')
  const first = await lockDatadir(dir)
  try {
    await assert.rejects(() => lockDatadir(dir), DatadirBusyError)
  } finally {
    await first.release()
  }
})

test('releasing the lock lets the next opener in', async () => {
  const dir = datadir('released')
  const first = await lockDatadir(dir)
  await first.release()

  const second = await lockDatadir(dir)
  assert.ok(second)
  await second.release()
})

test('separate datadirs never contend', async () => {
  // The property the test tooling depends on: every suite that touches the
  // database makes its own throwaway PGLITE_PATH, so locking at the point the
  // datadir is opened must not serialise unrelated runs.
  const a = await lockDatadir(datadir('independent-a'))
  const b = await lockDatadir(datadir('independent-b'))
  assert.ok(a && b, 'two different datadirs must be lockable at the same time')
  await a.release()
  await b.release()
})

test('the lock sits beside the datadir, never inside it', () => {
  // PGlite runs initdb only when the directory is empty. A lock file inside it
  // would make a fresh datadir look already-initialised.
  const dir = join(workdir, 'placement', 'pglite')
  assert.equal(lockPathFor(dir), `${dir}.lock`)
  assert.ok(!lockPathFor(dir).startsWith(dir + sep), 'the lock must not be inside the datadir')
  // A configured path with a trailing separator is the way this goes wrong.
  assert.equal(lockPathFor(`${dir}${sep}`), `${dir}.lock`)
  assert.ok(!lockPathFor(`${dir}${sep}`).startsWith(dir + sep))
})
