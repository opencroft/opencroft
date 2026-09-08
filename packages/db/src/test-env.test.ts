// The subject is what a PROCESS leaves behind, so every case here runs in a real child process
// that really ends -- normally, by throwing, and by signal. Asserting against this process instead
// would be asserting about handlers that have been registered rather than about handlers that ran.
//
// Each child gets a TMPDIR of its own. `os.tmpdir()` reads it, so the module under test creates and
// sweeps inside a directory this file owns: the assertions are about a population of known size,
// and a test run does not reach into the shared /tmp that every other process on the host is using.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const PREFIX = 'opencroft-test-pglite-'
const workdir = mkdtempSync(join(tmpdir(), 'opencroft-test-env-test-'))

after(() => {
  rmSync(workdir, { recursive: true, force: true })
})

const testEnv = join(import.meta.dirname, 'test-env.ts')

/**
 * Write a child script that imports the module under test and then does `body`.
 *
 * It prints the datadir it was given and whether that directory exists WHILE the process is still
 * running. Without the second line, "the directory is gone afterwards" would also be true of a
 * module that never created one, which is the assertion passing for the wrong reason.
 */
function childScript(name: string, body: string): string {
  const path = join(workdir, name)
  writeFileSync(
    path,
    [
      `import ${JSON.stringify(testEnv)}`,
      "import { existsSync } from 'node:fs'",
      // Concatenation rather than template literals: this is the CHILD's source, and a `${}` here
      // would be read as this file's own interpolation by everything that lints it.
      'const dir = process.env.PGLITE_PATH ?? ""',
      'console.log("PATH=" + dir)',
      'console.log("EXISTS_DURING_RUN=" + existsSync(dir))',
      body,
      '',
    ].join('\n'),
  )
  return path
}

interface Ended {
  dir: string
  existedDuringRun: boolean
  code: number | null
  signal: NodeJS.Signals | null
}

/** Run a child to completion in its own TMPDIR, optionally signalling it once it is up. */
function run(
  script: string,
  opts: { tmp: string; env?: Record<string, string>; signal?: NodeJS.Signals },
): Promise<Ended> {
  // Cleared rather than merely not set: an ambient PGLITE_PATH would send the child down the
  // caller-supplied branch, where it creates nothing — and every assertion about what it cleans up
  // would then pass without the code under test ever having run.
  const { PGLITE_PATH: _ambient, ...inherited } = process.env
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...inherited, TMPDIR: opts.tmp, ...opts.env },
  })
  let out = ''
  return new Promise<Ended>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      out += chunk
      if (opts.signal && out.includes('EXISTS_DURING_RUN=')) {
        child.kill(opts.signal)
      }
    })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code, signal) => {
      resolve({
        dir: /PATH=(.*)/.exec(out)?.[1] ?? '',
        existedDuringRun: out.includes('EXISTS_DURING_RUN=true'),
        code,
        signal,
      })
    })
  })
}

/** A TMPDIR of this test's own, for one child. */
function scratchTmp(): string {
  const dir = join(workdir, `tmp-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir)
  return dir
}

test('a run that finishes takes its datadir with it', async () => {
  const script = childScript('normal.mts', '')
  const tmp = scratchTmp()

  const ended = await run(script, { tmp })

  assert.equal(ended.code, 0)
  assert.ok(ended.dir.startsWith(join(tmp, PREFIX)), `the datadir was made in the child's own tmp: ${ended.dir}`)
  assert.equal(ended.existedDuringRun, true, 'and it really existed while the run was going')
  assert.equal(existsSync(ended.dir), false, 'and it is gone now')
})

test('a run that throws takes its datadir with it too', async () => {
  // The failing run is the one that used to leak and the one that matters: a suite dies, and the
  // 28MB it was using stays on a disk that is usually already the reason it died.
  const script = childScript('throws.mts', "throw new Error('the suite failed')")
  const tmp = scratchTmp()

  const ended = await run(script, { tmp })

  assert.notEqual(ended.code, 0, 'the run really failed')
  assert.equal(ended.existedDuringRun, true)
  assert.equal(existsSync(ended.dir), false, 'and it still cleaned up after itself')
})

test('a run killed part-way takes its datadir with it, and still dies of the signal', async () => {
  // SIGTERM's default disposition is to terminate WITHOUT running exit handlers, so this is the
  // case an `exit` hook alone does not reach. The second assertion is the other half: handling the
  // signal must not swallow it, or a harness that kills a hung run would see it exit cleanly.
  const script = childScript('killed.mts', 'setInterval(() => {}, 1 << 30)')
  const tmp = scratchTmp()

  const ended = await run(script, { tmp, signal: 'SIGTERM' })

  assert.equal(ended.signal, 'SIGTERM', 'the process still died of what killed it')
  assert.equal(ended.existedDuringRun, true)
  assert.equal(existsSync(ended.dir), false, 'and the datadir went with it')
})

test('a datadir the caller supplied is left exactly where it was, sweep included', async () => {
  // The control on the three above: they would also pass if this module removed whatever
  // PGLITE_PATH happened to point at.
  //
  // The name and the age are the control, not decoration. A directory named something this module
  // would never make, and freshly created, is one no code path here can reach -- so it could only
  // ever exercise the create/remove half, and would report "the caller's datadir is safe" while
  // the sweep was free to take it. This one is named like ours and backdated past the cutoff, so
  // it is eligible by every signal the sweep has EXCEPT being the one in use. That is the case a
  // person actually creates: re-pointing PGLITE_PATH at a previous run's leftover to look inside
  // it, which is by then old and carries the prefix.
  const tmp = scratchTmp()
  const supplied = join(tmp, `${PREFIX}kept-to-look-inside`)
  mkdirSync(supplied)
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000)
  utimesSync(supplied, old, old)
  const script = childScript('supplied.mts', '')

  const ended = await run(script, { tmp, env: { PGLITE_PATH: supplied } })

  assert.equal(ended.code, 0)
  assert.equal(ended.dir, supplied, 'the caller’s choice was honoured')
  assert.equal(existsSync(supplied), true, 'and it survived the process that borrowed it')
})

test('a run sweeps datadirs left by runs that could not clean up, and only those', async () => {
  // What SIGKILL and a lost host leave behind: nothing runs in the dying process, so the bound has
  // to be restored by somebody else. Age is the whole test -- the fresh directory is the control,
  // and without it "the sweep removed the old one" would also be true of a sweep that removed
  // everything it found, which would delete the database of a run still going.
  const tmp = scratchTmp()
  const abandoned = join(tmp, `${PREFIX}abandoned`)
  const running = join(tmp, `${PREFIX}running`)
  mkdirSync(abandoned)
  mkdirSync(running)
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000)
  utimesSync(abandoned, sevenHoursAgo, sevenHoursAgo)

  const ended = await run(childScript('sweeper.mts', ''), { tmp })

  assert.equal(ended.code, 0)
  assert.equal(existsSync(abandoned), false, 'the leftover of a run that cannot clean up is collected')
  assert.equal(existsSync(running), true, 'and a datadir young enough to belong to a live run is not')
})

test('the sweep collects directories and leaves a datadir lock alone', async () => {
  // The lock lives at `<datadir>.lock`, a SIBLING, so it carries the prefix the sweep matches on
  // and an old one is eligible by every other signal. Unlinking a bound socket does not stop its
  // holder — it frees the path for a second process to bind, after which two processes each
  // believe they hold one datadir exclusively, which is the silent corruption that lock exists to
  // prevent. Observed in practice: three such sockets outlived their datadirs by two weeks.
  const tmp = scratchTmp()
  const datadir = join(tmp, `${PREFIX}withalock`)
  const lock = `${datadir}.lock`
  mkdirSync(datadir)
  writeFileSync(lock, '')
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000)
  utimesSync(datadir, old, old)
  utimesSync(lock, old, old)

  const ended = await run(childScript('withlock.mts', ''), { tmp })

  assert.equal(ended.code, 0)
  assert.equal(existsSync(datadir), false, 'the directory is collected')
  assert.equal(existsSync(lock), true, 'and the lock beside it is not, however old it looks')
})

test('one run will not spend itself clearing a backlog, and consecutive runs still clear it', async () => {
  // The sweep never binds on what this fix leaves behind — it binds on what accumulated before the
  // fix existed, where an unbounded one makes a single test process spend minutes deleting other
  // people's leftovers and look exactly like a hung suite from outside.
  //
  // BACKLOG must exceed the module's own bound for the first assertion to mean anything. If the
  // bound is ever raised past it, this fails saying so, which is the right way to find out.
  const BACKLOG = 260
  const tmp = scratchTmp()
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000)
  for (let i = 0; i < BACKLOG; i++) {
    const dir = join(tmp, `${PREFIX}backlog-${i}`)
    mkdirSync(dir)
    utimesSync(dir, old, old)
  }
  const remaining = () => readdirSync(tmp).filter((e) => e.startsWith(PREFIX)).length
  const script = childScript('backlog.mts', '')

  await run(script, { tmp })
  const afterFirst = remaining()

  assert.ok(afterFirst > 0, `one run stops short of the whole backlog (${afterFirst} of ${BACKLOG} left)`)
  assert.ok(afterFirst < BACKLOG, 'having collected some of it')

  // A suite puts every test file in its own process, so "the next run" is really many sweeps.
  for (let i = 0; i < 5 && remaining() > 0; i++) {
    await run(script, { tmp })
  }
  assert.equal(remaining(), 0, 'and consecutive runs finish the job rather than leaving it forever')
})
