// The repository's test runner, which lives at the root because every
// workspace's `test` script calls it. Tested here for the same reason
// baseline-report.test.ts is: this is where tooling tests run.
//
// Each case runs the real runner as a child process over a scratch workspace
// of its own, so what is asserted is what a run does, not what the script
// says. The scratch workspace sits outside the repository; the runner finds
// tsx from its own location, so the scratch workspace needs none.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
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
    NODE_TEST_CONTEXT: _context,
    ...inherited
  } = process.env
  return { ...inherited, OPENCROFT_TEST_TAP: '1', ...env }
}

function runIn(dir: string, env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [RUNNER, '.'], { cwd: dir, encoding: 'utf8', env: runnerEnv(env) })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Whether `pid` is gone within a few seconds. Node's test runner stops its
 * files and exits without waiting for them, so a stopped file can outlive the
 * run by a few milliseconds; one that was never told to stop is still there
 * long after.
 */
async function stopsSoon(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false
    await sleep(20)
  }
  return true
}

/** Reads the JSON a file under test wrote to `path`, once it has written it. */
async function whenWritten(path: string): Promise<{ pid: number; runDir: string }> {
  const deadline = Date.now() + 60_000
  while (!existsSync(path) || readFileSync(path, 'utf8') === '') {
    if (Date.now() > deadline) throw new Error(`nothing was written to ${path}`)
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

/** A test file that writes its pid and run directory to `out`, then waits to be stopped. */
function blocksUntilStopped(out: string): string {
  return [
    "import { writeFileSync } from 'node:fs'",
    "import test from 'node:test'",
    "test('blocks', async () => {",
    `  writeFileSync(${JSON.stringify(out)}, JSON.stringify({ pid: process.pid, runDir: process.env.OPENCROFT_TEST_RUN_DIR }))`,
    '  await new Promise((resolve) => setTimeout(resolve, 120_000))',
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
  // A totals line in the report would be read by check-baseline as a suite's.
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

test('a PGLITE_PATH the caller exported is not handed to every file', () => {
  const out = join(scratch, 'pglite-path')
  const dir = workspace({ 'src/a.test.ts': records(out, "process.env.PGLITE_PATH ?? 'unset'") })

  const run = runIn(dir, { PGLITE_PATH: join(scratch, 'shared-datadir') })

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
  test(`${signal} to the runner${group ? "'s process group" : ' alone'} stops the files and removes the run directory`, async () => {
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
    const exited = once(runner, 'exit')
    let file: { pid: number; runDir: string } | undefined
    try {
      file = await whenWritten(out)
      assert.ok(existsSync(file.runDir), 'the run directory exists while the file runs')

      process.kill(group ? -(runner.pid as number) : (runner.pid as number), signal)
      const [code] = await exited

      assert.notEqual(code, 0, 'a stopped run is not a passing one')
      assert.ok(await stopsSoon(file.pid), 'the file stopped with the run')
      assert.equal(existsSync(file.runDir), false)
    } finally {
      if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
      if (file && isAlive(file.pid)) process.kill(file.pid, 'SIGKILL')
    }
  })
}

test('a signal during the global setup stops the run once the setup returns', async () => {
  const started = join(scratch, 'setup-started')
  const out = join(scratch, 'file-under-stopped-setup')
  const dir = workspace({
    'scripts/test-global-setup.mjs': [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid, runDir: process.env.OPENCROFT_TEST_RUN_DIR }))`,
      // Long enough for the signal to land while the runner waits on it.
      'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 3000)',
      '',
    ].join('\n'),
    'src/a.test.ts': blocksUntilStopped(out),
  })
  const tmp = mkdtempSync(join(scratch, 'tmp-'))
  const runner = spawn(process.execPath, [RUNNER, '.'], { cwd: dir, env: runnerEnv({ TMPDIR: tmp }), stdio: 'ignore' })
  const exited = once(runner, 'exit')
  try {
    const setup = await whenWritten(started)

    process.kill(runner.pid as number, 'SIGTERM')
    const [code] = await exited

    assert.notEqual(code, 0)
    assert.equal(existsSync(setup.runDir), false)
    // The files may have been started before the signal was handled; if so,
    // they were stopped with the run.
    if (existsSync(out)) {
      assert.ok(await stopsSoon((await whenWritten(out)).pid))
    }
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
  }
})
