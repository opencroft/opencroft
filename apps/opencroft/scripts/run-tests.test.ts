// The repository's test runner, which lives at the root because every
// workspace's `test` script calls it. Tested here because this is where
// tooling tests run.
//
// Each case but the one on how file limits combine runs the real runner as a
// child process over a scratch workspace of its own, so what is asserted is
// what a run does, not what the script says. The scratch workspace sits
// outside the repository; the runner finds tsx from its own location, so the
// scratch workspace needs none.

import assert from 'node:assert/strict'
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

import { fileTimeouts } from '../../../scripts/test-file-limit.mjs'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const RUNNER = join(repoRoot, 'scripts', 'run-tests.mjs')

const scratch = mkdtempSync(join(tmpdir(), 'opencroft-run-tests-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** A workspace holding `files` (relative path to source), for one case. */
function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, 'ws-'))
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), source)
  }
  return dir
}

function runnerEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  // The run this case is part of has a run directory of its own; inheriting
  // it would hand the child someone else's. NODE_TEST_CONTEXT marks this
  // process as a file of that run, and a test runner that inherits it reports
  // to a parent that is not listening instead of printing a report.
  const {
    OPENCROFT_TEST_RUN_DIR: _outer,
    OPENCROFT_TEST_CONCURRENCY: _requested,
    OPENCROFT_TEST_FILE_TIMEOUT: _limit,
    NODE_TEST_CONTEXT: _context,
    ...inherited
  } = process.env
  return { ...inherited, OPENCROFT_TEST_TAP: '1', ...env }
}

function runIn(dir: string, env: Record<string, string> = {}) {
  // Bounded, so a runner that never ends fails the case instead of holding
  // this file open: what is asserted below includes that it ended by itself.
  const result = spawnSync(process.execPath, [RUNNER, '.'], {
    cwd: dir,
    encoding: 'utf8',
    env: runnerEnv(env),
    timeout: 60_000,
    killSignal: 'SIGKILL',
  })
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

// The waits below end on the event they wait for, or when the case is
// cancelled: `cancelled` is the case's own signal, which this file's limit
// aborts, so how long a loaded host takes never decides a result and a case
// whose event never comes still reaches its `finally`.

/**
 * Whether `pid` stopped. Node's test runner stops its files and exits without
 * waiting for them, so a stopped file can outlive the run by a moment; one
 * that was never told to stop is still there when the case is cancelled.
 */
async function stops(pid: number, cancelled: AbortSignal): Promise<boolean> {
  while (isAlive(pid)) {
    if (cancelled.aborted) return false
    await sleep(20)
  }
  return true
}

/** The code `child` exited with, once it has exited. */
async function exitCode(child: ChildProcess, cancelled: AbortSignal): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode
  const [code] = await once(child, 'exit', { signal: cancelled })
  return code
}

/** Reads the JSON a file under test wrote to `path`, once it has written it. */
async function whenWritten(path: string, cancelled: AbortSignal): Promise<{ pid: number; runDir: string }> {
  while (!existsSync(path) || readFileSync(path, 'utf8') === '') {
    if (cancelled.aborted) throw new Error(`nothing was written to ${path}`)
    await sleep(50)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * A test file that records it started, then waits for `other` to have
 * started too. Two of these pass only if they run at the same time: run one
 * after the other, the first waits out its deadline and fails.
 */
function meetsPeer(self: string, other: string): string {
  return [
    "import { existsSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import test from 'node:test'",
    `test('${self} meets ${other}', async () => {`,
    '  const dir = process.env.OPENCROFT_TEST_RUN_DIR ?? ""',
    `  writeFileSync(join(dir, '${self}'), '')`,
    '  const deadline = Date.now() + 30_000',
    `  while (!existsSync(join(dir, '${other}'))) {`,
    "    if (Date.now() > deadline) throw new Error('the other file never started')",
    '    await new Promise((resolve) => setTimeout(resolve, 20))',
    '  }',
    '})',
    '',
  ].join('\n')
}

/** A test file that writes `value`, an expression that may read files, to `out`. */
function records(out: string, value: string): string {
  return [
    "import { readFileSync, writeFileSync } from 'node:fs'",
    "import test from 'node:test'",
    `test('records', () => { writeFileSync(${JSON.stringify(out)}, String(${value})) })`,
    '',
  ].join('\n')
}

/**
 * A test file that writes its pid and run directory to `out`, then waits to be
 * stopped. It never ends by itself, so one that was not stopped cannot pass
 * for one that was; a case that started it kills it in its `finally`.
 */
function blocksUntilStopped(out: string): string {
  return [
    "import { writeFileSync } from 'node:fs'",
    "import test from 'node:test'",
    "test('blocks', async () => {",
    `  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, runDir: process.env.OPENCROFT_TEST_RUN_DIR }))`,
    '  await new Promise(() => setInterval(() => {}, 60_000))',
    '})',
    '',
  ].join('\n')
}

test('test files run side by side', () => {
  const dir = workspace({
    'src/a.test.ts': meetsPeer('a', 'b'),
    'src/b.test.ts': meetsPeer('b', 'a'),
  })

  const run = runIn(dir, { OPENCROFT_TEST_CONCURRENCY: '2' })

  assert.equal(run.status, 0, run.stdout)
  assert.match(run.stdout, /^Found 2 test files\.$/m)
  assert.match(run.stdout, /^# pass 2$/m)
})

const PREPARED = "readFileSync(process.env.OPENCROFT_TEST_RUN_DIR + '/prepared', 'utf8')"

test('the global setup runs once, before any file, and its output stays out of the report', () => {
  const dir = workspace({
    'scripts/test-global-setup.mjs': [
      "import { appendFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "appendFileSync(join(process.env.OPENCROFT_TEST_RUN_DIR, 'prepared'), 'once\\n')",
      "console.log('# fail 7')",
      '',
    ].join('\n'),
    'src/a.test.ts': records(join(scratch, 'seen-by-a'), PREPARED),
    'src/b.test.ts': records(join(scratch, 'seen-by-b'), PREPARED),
  })

  const run = runIn(dir)

  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(readFileSync(join(scratch, 'seen-by-a'), 'utf8'), 'once\n')
  assert.equal(readFileSync(join(scratch, 'seen-by-b'), 'utf8'), 'once\n')
  // The setup's own totals line stays out of the report, which has one per suite.
  assert.deepEqual(run.stdout.match(/^# fail \d+$/gm), ['# fail 0'])
  assert.match(run.stderr, /^# fail 7$/m, 'the setup still printed, to stderr')
})

test('a global setup that fails is reported and the files still run', () => {
  const dir = workspace({
    'scripts/test-global-setup.mjs': 'process.exit(3)\n',
    'src/a.test.ts': "import test from 'node:test'\ntest('runs', () => {})\n",
  })

  const run = runIn(dir)

  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /^# pass 1$/m)
  assert.match(run.stderr, /test-global-setup\.mjs failed \(exit 3\)/)
})

test('the run directory exists while the files run and is gone when the run ends', () => {
  const out = join(scratch, 'run-dir-path')
  const dir = workspace({ 'src/a.test.ts': records(out, 'process.env.OPENCROFT_TEST_RUN_DIR') })

  const run = runIn(dir)

  assert.equal(run.status, 0, run.stdout + run.stderr)
  const runDir = readFileSync(out, 'utf8')
  assert.ok(runDir.startsWith(join(tmpdir(), 'opencroft-test-run-')), `a run directory was handed over: ${runDir}`)
  assert.equal(existsSync(runDir), false)
})

test('an OPENCROFT_PGLITE_PATH the caller exported is not handed to every file', () => {
  const out = join(scratch, 'pglite-path')
  const dir = workspace({ 'src/a.test.ts': records(out, "process.env.OPENCROFT_PGLITE_PATH ?? 'unset'") })

  const run = runIn(dir, { OPENCROFT_PGLITE_PATH: join(scratch, 'shared-datadir') })

  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(readFileSync(out, 'utf8'), 'unset')
})

test('a run removes the run directories a dead run left behind, and nothing else', () => {
  // The runner's tmpdir, so what it sweeps is only what this case put there.
  const tmp = mkdtempSync(join(scratch, 'tmp-'))
  const sevenHoursAgo = Date.now() / 1000 - 7 * 60 * 60
  const leftBehind = join(tmp, 'opencroft-test-run-dead')
  mkdirSync(join(leftBehind, 'pglite-template'), { recursive: true })
  const inProgress = join(tmp, 'opencroft-test-run-running')
  mkdirSync(inProgress)
  const notADirectory = join(tmp, 'opencroft-test-run-file')
  writeFileSync(notADirectory, '')
  const someoneElses = join(tmp, 'other-tool-dir')
  mkdirSync(someoneElses)
  const linked = join(scratch, 'link-target')
  mkdirSync(linked)
  const link = join(tmp, 'opencroft-test-run-link')
  symlinkSync(linked, link)
  for (const path of [leftBehind, notADirectory, someoneElses, linked]) {
    utimesSync(path, sevenHoursAgo, sevenHoursAgo)
  }
  const dir = workspace({ 'src/a.test.ts': "import test from 'node:test'\ntest('runs', () => {})\n" })

  const run = runIn(dir, { TMPDIR: tmp })

  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.equal(existsSync(leftBehind), false, 'the dead run left this behind')
  assert.ok(existsSync(inProgress), 'a run that recently started may still be going')
  assert.ok(existsSync(notADirectory), 'only directories are run directories')
  assert.ok(existsSync(someoneElses), 'not a run directory')
  assert.ok(existsSync(link) && existsSync(linked), 'a link is not followed')
})

for (const { signal, group } of [
  // How a harness or a supervisor stops it: the runner's pid, nothing else.
  { signal: 'SIGTERM', group: false },
  // The test runner stops its files on INT and TERM only, so the runner sends
  // this one on as TERM.
  { signal: 'SIGHUP', group: false },
  // Ctrl-C in a terminal: every process in the foreground group at once.
  { signal: 'SIGINT', group: true },
] as const) {
  test(`${signal} to the runner${group ? "'s process group" : ' alone'} stops the files and removes the run directory`, async (t) => {
    const out = join(scratch, `stopped-by-${signal}`)
    const dir = workspace({ 'src/a.test.ts': blocksUntilStopped(out) })
    // A runner that fails to clean up leaves its run directory here, not in the real tmpdir.
    const tmp = mkdtempSync(join(scratch, 'tmp-'))
    const runner = spawn(process.execPath, [RUNNER, '.'], {
      cwd: dir,
      env: runnerEnv({ TMPDIR: tmp }),
      stdio: 'ignore',
      detached: group,
    })
    let file: { pid: number; runDir: string } | undefined
    try {
      file = await whenWritten(out, t.signal)
      assert.ok(existsSync(file.runDir), 'the run directory exists while the file runs')

      process.kill(group ? -(runner.pid as number) : (runner.pid as number), signal)
      const code = await exitCode(runner, t.signal)

      assert.notEqual(code, 0, 'a stopped run is not a passing one')
      assert.ok(await stops(file.pid, t.signal), 'the file stopped with the run')
      assert.equal(existsSync(file.runDir), false)
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
      if (file && isAlive(file.pid)) process.kill(file.pid, 'SIGKILL')
    }
  })
}

test('a signal during the global setup stops the run once the setup returns', async (t) => {
  const started = join(scratch, 'setup-started')
  const signalled = join(scratch, 'setup-signalled')
  const out = join(scratch, 'file-under-stopped-setup')
  const dir = workspace({
    'scripts/test-global-setup.mjs': [
      "import { existsSync, writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, runDir: process.env.OPENCROFT_TEST_RUN_DIR }))`,
      // Holds the runner in the setup until the signal has been sent to it.
      `while (!existsSync(${JSON.stringify(signalled)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)`,
      '',
    ].join('\n'),
    'src/a.test.ts': blocksUntilStopped(out),
  })
  const tmp = mkdtempSync(join(scratch, 'tmp-'))
  const runner = spawn(process.execPath, [RUNNER, '.'], { cwd: dir, env: runnerEnv({ TMPDIR: tmp }), stdio: 'ignore' })
  let file: { pid: number } | undefined
  try {
    const setup = await whenWritten(started, t.signal)

    process.kill(runner.pid as number, 'SIGTERM')
    writeFileSync(signalled, '')
    const code = await exitCode(runner, t.signal)

    assert.notEqual(code, 0)
    assert.equal(existsSync(setup.runDir), false)
    // The runner starts the files as the setup returns, before it handles the
    // signal; a file that got as far as its test was stopped with the run.
    if (existsSync(out)) {
      file = await whenWritten(out, t.signal)
      assert.ok(await stops(file.pid, t.signal), 'the file stopped with the run')
    }
  } finally {
    // Lets a setup still waiting return, so nothing this case started outlives it.
    writeFileSync(signalled, '')
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
    if (file && isAlive(file.pid)) process.kill(file.pid, 'SIGKILL')
  }
})

const PASSES = "import test from 'node:test'\ntest('passes', () => {})\n"

/** A test file that passes after `ms` milliseconds, preceded by `header` lines. */
function passesAfter(ms: number, header = ''): string {
  return `${header}import test from 'node:test'\ntest('passes late', async () => { await new Promise((resolve) => setTimeout(resolve, ${ms})) })\n`
}

// The limit for the cases below whose file must still be in its tests when the
// limit passes. A file's clock starts before tsx loads it, so start-up counts
// against the limit, and a limit start-up can reach ends the file before its
// tests run: there is then nothing still running to name. A file of a few
// lines took 1.3 to 2.7 s from process start to its first test while a root
// `npm test` ran on the development host (2026-10-29, 74 files). Four times the
// slowest, as for the run's default limit. Each of these cases waits it out.
const IN_TEST_LIMIT_S = 11

/** Kills whatever of `pids` a failed case left running. */
function killLeftovers(...pids: (number | undefined)[]) {
  for (const pid of pids) {
    if (pid !== undefined && isAlive(pid)) process.kill(pid, 'SIGKILL')
  }
}

test('a test file that never exits times out: it is named, killed with the process it started, and fails the run', async (t) => {
  const out = join(scratch, 'never-exits')
  const dir = workspace({
    // Both kinds of hang at once: a process of its own that never exits, and
    // a timer in the file's own process. The timer keeps the file's event loop
    // busy after the process it started is killed, so the test still running
    // is named only because the file is asked to report it.
    'src/never-exits.test.ts': [
      "import { spawn } from 'node:child_process'",
      "import { writeFileSync } from 'node:fs'",
      "import test from 'node:test'",
      'setInterval(() => {}, 1000)',
      "test('starts a process that never exits', () => {",
      "  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      `  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, child: child.pid }))`,
      '})',
      "test('waits for ever', () => new Promise(() => {}))",
      '',
    ].join('\n'),
    'src/passes.test.ts': PASSES,
  })
  let file: { pid: number; child: number } | undefined
  try {
    const run = runIn(dir, { OPENCROFT_TEST_FILE_TIMEOUT: String(IN_TEST_LIMIT_S) })
    file = JSON.parse(readFileSync(out, 'utf8'))

    assert.equal(run.signal, null, `the run ended by itself\n${run.stdout}${run.stderr}`)
    assert.notEqual(run.status, 0)
    // Started alongside, under the same limit: start-up did not reach it.
    assert.doesNotMatch(run.stderr, /^src\/passes\.test\.ts: timed out/m, `start-up fits the limit\n${run.stderr}`)
    assert.match(
      run.stderr,
      new RegExp(
        `^src/never-exits\\.test\\.ts: timed out after ${IN_TEST_LIMIT_S} s; killing it and every process it started\\.$`,
        'm',
      ),
    )
    assert.match(
      run.stderr,
      new RegExp(`^Timed out: src/never-exits\\.test\\.ts \\(limit ${IN_TEST_LIMIT_S} s\\)\\.$`, 'm'),
    )
    assert.match(run.stdout, /^not ok \d+ - waits for ever$/m, 'the test still running is named')
    assert.match(run.stdout, /^ok \d+ - passes$/m, 'the other file ran')
    assert.ok(await stops(file?.pid as number, t.signal), 'the file was killed')
    assert.ok(await stops(file?.child as number, t.signal), 'the process it started was killed')
  } finally {
    killLeftovers(file?.pid, file?.child)
  }
})

test('a test file blocked in synchronous code is killed once its grace period ends', async (t) => {
  const out = join(scratch, 'blocked')
  const dir = workspace({
    'src/blocked.test.ts': [
      "import { writeFileSync } from 'node:fs'",
      "import test from 'node:test'",
      "test('never yields', () => {",
      `  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid }))`,
      '  for (;;) {}',
      '})',
      '',
    ].join('\n'),
    'src/passes.test.ts': PASSES,
  })
  let file: { pid: number } | undefined
  try {
    const run = runIn(dir, { OPENCROFT_TEST_FILE_TIMEOUT: String(IN_TEST_LIMIT_S) })
    file = JSON.parse(readFileSync(out, 'utf8'))

    assert.equal(run.signal, null, `the run ended by itself\n${run.stdout}${run.stderr}`)
    assert.notEqual(run.status, 0)
    assert.doesNotMatch(run.stderr, /^src\/passes\.test\.ts: timed out/m, `start-up fits the limit\n${run.stderr}`)
    assert.match(
      run.stderr,
      new RegExp(`^Timed out: src/blocked\\.test\\.ts \\(limit ${IN_TEST_LIMIT_S} s\\)\\.$`, 'm'),
    )
    assert.match(run.stdout, /^not ok \d+ - src\/blocked\.test\.ts$/m)
    assert.match(run.stdout, /^ok \d+ - passes$/m)
    assert.ok(await stops(file?.pid as number, t.signal))
  } finally {
    killLeftovers(file?.pid)
  }
})

test('a file that declares a longer limit, with its reason, runs to that limit', () => {
  const dir = workspace({
    'src/declared.test.ts': passesAfter(2500, '// test-file-timeout: 300 s, because its fixture starts slowly\n'),
    // Longer than a timer can hold, so it is held to the longest one that can.
    'src/declared-beyond-a-timer.test.ts': passesAfter(
      2500,
      '// test-file-timeout: 3000000 s, because its fixture starts slowly\n',
    ),
    // The same file without the declaration, at the same default.
    'src/undeclared.test.ts': passesAfter(2500),
  })

  const run = runIn(dir, { OPENCROFT_TEST_FILE_TIMEOUT: '1' })

  assert.equal(run.signal, null)
  assert.notEqual(run.status, 0)
  assert.match(run.stderr, /^Timed out: src\/undeclared\.test\.ts \(limit 1 s\)\.$/m)
  assert.doesNotMatch(run.stderr, /^src\/declared\.test\.ts: timed out/m)
  assert.doesNotMatch(run.stderr, /^src\/declared-beyond-a-timer\.test\.ts: timed out/m)
  assert.equal(run.stdout.match(/^ok \d+ - passes late$/gm)?.length, 2, `both declared files passed\n${run.stdout}`)
})

test('a file gets the longer of its declared limit and the run default', () => {
  const declared = join(
    workspace({ 'a.test.ts': `// test-file-timeout: 300 s, because it is a slow one\n${PASSES}` }),
    'a.test.ts',
  )
  const undeclared = join(workspace({ 'b.test.ts': PASSES }), 'b.test.ts')

  const shorter = fileTimeouts([declared, undeclared], 60)
  const longer = fileTimeouts([declared, undeclared], 900)

  assert.deepEqual([...shorter.limits.values()], [300, 60])
  assert.deepEqual([...longer.limits.values()], [900, 900])
  assert.deepEqual([...shorter.problems, ...longer.problems], [])
})

test('a run default longer than a declared limit leaves the declaration standing, and the file runs', () => {
  const dir = workspace({
    'src/declared.test.ts': `// test-file-timeout: 300 s, because it is a slow one\n${PASSES}`,
  })

  const run = runIn(dir, { OPENCROFT_TEST_FILE_TIMEOUT: '900' })

  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`)
  assert.match(run.stdout, /^ok \d+ - passes$/m)
})

test('a limit declared without a reason, not longer than the default, or twice stops the run before any file starts', () => {
  const ran = join(scratch, 'ran-despite-declarations')
  const dir = workspace({
    'src/no-reason.test.ts': `// test-file-timeout: 600 s\n${PASSES}`,
    'src/too-short.test.ts': `// test-file-timeout: 240 s, because it is a slow one\n${PASSES}`,
    'src/twice.test.ts': `// test-file-timeout: 600 s, because it is a slow one\n// test-file-timeout: 900 s, because it is slower still\n${PASSES}`,
    'src/records.test.ts': records(ran, "'ran'"),
  })

  // A run default below the declared value: the declaration is still judged
  // against the default the source is written for.
  const run = runIn(dir, { OPENCROFT_TEST_FILE_TIMEOUT: '60' })

  assert.equal(run.status, 1)
  assert.match(run.stderr, /^src\/no-reason\.test\.ts: test-file-timeout: 600 s has no reason beside it\.$/m)
  assert.match(
    run.stderr,
    /^src\/too-short\.test\.ts: test-file-timeout: 240 s is not longer than the default of 240 s\.$/m,
  )
  assert.match(run.stderr, /^src\/twice\.test\.ts: declares test-file-timeout 2 times/m)
  assert.equal(existsSync(ran), false, 'no file ran')
})
