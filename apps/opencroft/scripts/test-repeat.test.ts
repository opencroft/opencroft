// The flake detector (scripts/test-repeat.mjs), run as a child process over a
// scratch workspace of its own, so what is asserted is what a run prints and
// exits with. Which test fails in which run is decided by a counter the
// fixture keeps on disk, never by timing.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { waitFor } from '@/test-support/wait'

const repoRoot = join(import.meta.dirname, '..', '..', '..')
const TOOL = join(repoRoot, 'scripts', 'test-repeat.mjs')

const scratch = mkdtempSync(join(tmpdir(), 'opencroft-test-repeat-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

const STEADY = `
import test from 'node:test'
test('steady', () => {})
`

// Counts its own runs in a file beside it: 'alternates' fails on every even
// run, 'always red' on every run.
const FLIPPING = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
const counter = join(import.meta.dirname, 'runs')
const run = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1
writeFileSync(counter, String(run))
test('steady', () => {})
test('alternates', () => {
  if (run % 2 === 0) throw new Error('an even run')
})
test('always red', () => {
  throw new Error('red')
})
`

const HANGING = `
import test from 'node:test'
test('never settles', () => new Promise(() => setInterval(() => {}, 1_000)))
`

const EMPTY = `
export {}
`

/** A workspace holding `files` (relative path to source), for one case. */
function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, 'ws-'))
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n')
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), source)
  }
  return dir
}

// The load's host-wide lock, moved into the scratch directory so these cases
// neither wait on nor block a real --load run on the same host.
const LOCK = join(scratch, 'load.lock')

function toolEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  const {
    OPENCROFT_TEST_TIMINGS: _t,
    OPENCROFT_TEST_SLOTS: _s,
    OPENCROFT_TEST_FILE_TIMEOUT: _l,
    ...inherited
  } = process.env
  return { ...inherited, OPENCROFT_TEST_REPEAT_LOCK: LOCK, ...env }
}

function repeat(cwd: string, args: string[], env: Record<string, string> = {}) {
  // Bounded, so a tool that never ends fails the case instead of holding
  // this file open.
  const result = spawnSync(process.execPath, [TOOL, ...args], {
    cwd,
    encoding: 'utf8',
    env: toolEnv(env),
    timeout: 120_000,
    killSignal: 'SIGKILL',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('a file whose runs all pass reports every run passed, and the tool exits 0', () => {
  const dir = workspace({ 'src/steady.test.ts': STEADY })
  const { status, stdout, stderr } = repeat(dir, ['src/steady.test.ts', '--times', '3'])
  assert.equal(stdout, 'stable src/steady.test.ts: 3 runs, 3 passed, 0 failed, 0 timed out\n', stderr)
  assert.equal(status, 0)
  assert.doesNotMatch(stderr, /reports of the runs that did not pass/)
})

test('a test that fails in some runs is named as flipped; one that always fails is listed apart', () => {
  const dir = workspace({ 'src/flipping.test.ts': FLIPPING })
  const { status, stdout, stderr } = repeat(dir, ['src/flipping.test.ts', '--times', '4'])
  assert.equal(
    stdout,
    'failing src/flipping.test.ts: 4 runs, 0 passed, 4 failed, 0 timed out; flipped: "alternates" (failed 2 of 4); failed every run: "always red"\n',
    stderr,
  )
  assert.equal(status, 1)
  const kept = stderr.match(/reports of the runs that did not pass: (.+)/)?.[1]
  assert.ok(kept, stderr)
  assert.equal(readdirSync(kept).length, 8, 'a report and a stderr for each of the 4 runs')
  rmSync(kept, { recursive: true, force: true })
})

test('a run killed at its file limit counts as timed out, under the limit --timeout gives', () => {
  const dir = workspace({ 'src/hanging.test.ts': HANGING })
  const { status, stdout, stderr } = repeat(dir, ['src/hanging.test.ts', '--times', '1', '--timeout', '1'])
  assert.equal(stdout, 'failing src/hanging.test.ts: 1 runs, 0 passed, 0 failed, 1 timed out\n', stderr)
  assert.equal(status, 1)
  rmSync(stderr.match(/reports of the runs that did not pass: (.+)/)?.[1] ?? '', { recursive: true, force: true })
})

test('a run that runs no test is not a pass', () => {
  const dir = workspace({ 'src/empty.test.ts': EMPTY })
  const { status, stdout, stderr } = repeat(dir, ['src/empty.test.ts', '--times', '1'])
  assert.equal(stdout, 'failing src/empty.test.ts: 1 runs, 0 passed, 0 failed, 0 timed out, 1 ran no tests\n', stderr)
  assert.equal(status, 1)
  rmSync(stderr.match(/reports of the runs that did not pass: (.+)/)?.[1] ?? '', { recursive: true, force: true })
})

test('each file gets its own line, in the order given', () => {
  const dir = workspace({ 'a/steady.test.ts': STEADY, 'b/flipping.test.ts': FLIPPING })
  const { stdout, stderr } = repeat(dir, ['b/flipping.test.ts', 'a/steady.test.ts', '--times', '2'])
  const lines = stdout.trimEnd().split('\n')
  assert.equal(lines.length, 2, stderr)
  assert.match(lines[0], /^failing b\/flipping\.test\.ts: 2 runs/)
  assert.match(lines[1], /^stable a\/steady\.test\.ts: 2 runs, 2 passed/)
  rmSync(stderr.match(/reports of the runs that did not pass: (.+)/)?.[1] ?? '', { recursive: true, force: true })
})

test('the timings collector an outer run left does not collect the repeated runs', () => {
  const dir = workspace({ 'src/steady.test.ts': STEADY })
  const timings = mkdtempSync(join(scratch, 'timings-'))
  const { status, stderr } = repeat(dir, ['src/steady.test.ts', '--times', '1'], { OPENCROFT_TEST_TIMINGS: timings })
  assert.equal(status, 0, stderr)
  assert.deepEqual(readdirSync(timings), [])
})

test('with --load the files run and the tool still ends by itself', () => {
  const dir = workspace({ 'src/steady.test.ts': STEADY })
  const { status, stdout, stderr } = repeat(dir, ['src/steady.test.ts', '--times', '1', '--load'])
  assert.match(stderr, /^load: /m)
  assert.equal(stdout, 'stable src/steady.test.ts: 1 runs, 1 passed, 0 failed, 0 timed out\n', stderr)
  assert.equal(status, 0)
})

test('a second --load refuses while one runs, naming it; the lock goes with the run however it ends', async () => {
  const dir = workspace({ 'src/hanging.test.ts': HANGING, 'src/steady.test.ts': STEADY })
  // Killed below with SIGKILL, which leaves its runner behind until the
  // runner's own file limit ends it; the limit is short so that is soon.
  const first = spawn(process.execPath, [TOOL, 'src/hanging.test.ts', '--times', '1', '--timeout', '20', '--load'], {
    cwd: dir,
    env: toolEnv({}),
    stdio: 'ignore',
  })
  const exited = once(first, 'exit')
  try {
    await waitFor(
      () => existsSync(`${LOCK}.holder`) && readFileSync(`${LOCK}.holder`, 'utf8').includes(`${first.pid}`),
      {
        what: 'the first run holds the load',
        timeoutMs: 60_000,
      },
    )

    const second = repeat(dir, ['src/steady.test.ts', '--times', '1', '--load'])
    assert.equal(second.status, 3, second.stderr)
    assert.match(second.stderr, new RegExp(`load: refused, another --load run holds .*: pid ${first.pid} in `))
    assert.equal(second.stdout, '')
  } finally {
    first.kill('SIGKILL')
    await exited
  }

  const third = repeat(dir, ['src/steady.test.ts', '--times', '1', '--load'])
  assert.equal(third.status, 0, `the lock was let go when the first run was killed: ${third.stderr}`)
})

test('the load stops at its cap while the runs go on', () => {
  const dir = workspace({ 'src/hanging.test.ts': HANGING })
  const { status, stdout, stderr } = repeat(dir, [
    'src/hanging.test.ts',
    '--times',
    '1',
    '--timeout',
    '5',
    '--load',
    '--load-cap',
    '1',
  ])
  const lines = stderr.split('\n')
  const capped = lines.indexOf('load: stopped at its 1 s cap; the runs go on without it')
  const ran = lines.findIndex((line) => line.startsWith('src/hanging.test.ts run 1/1: timeout'))
  assert.ok(capped !== -1 && ran !== -1 && capped < ran, stderr)
  assert.match(stdout, /^failing src\/hanging\.test\.ts: 1 runs, 0 passed, 0 failed, 1 timed out\n$/)
  assert.equal(status, 1)
  rmSync(stderr.match(/reports of the runs that did not pass: (.+)/)?.[1] ?? '', { recursive: true, force: true })
})

test('wrong arguments exit 2 before any file runs', () => {
  // The valid file beside each mistake counts its runs, so a run that
  // started anyway leaves its counter behind.
  const dir = workspace({ 'src/flipping.test.ts': FLIPPING, 'src/helper.ts': 'export {}\n' })
  const valid = 'src/flipping.test.ts'
  const cases = [
    { name: 'no file', args: [], message: /no test file given/ },
    { name: 'a missing file', args: [valid, 'src/gone.test.ts'], message: /no file at src\/gone\.test\.ts/ },
    { name: 'not a test file', args: [valid, 'src/helper.ts'], message: /is not a \*\.test\.ts\(x\) file/ },
    { name: '--times 0', args: [valid, '--times', '0'], message: /--times takes a whole number/ },
    { name: '--times with no value', args: [valid, '--times'], message: /got nothing/ },
    { name: '--timeout not a number', args: [valid, '--timeout', 'soon'], message: /--timeout takes a whole number/ },
    { name: 'an unknown option', args: [valid, '--loud'], message: /unknown option --loud/ },
    { name: '--load-cap without --load', args: [valid, '--load-cap', '9'], message: /--load-cap needs --load/ },
  ]
  for (const { name, args, message } of cases) {
    const { status, stdout, stderr } = repeat(dir, args)
    assert.equal(status, 2, name)
    assert.match(stderr, message, name)
    assert.equal(stdout, '', name)
  }
  assert.equal(existsSync(join(dir, 'src', 'runs')), false, 'no run of the valid file started')
})
