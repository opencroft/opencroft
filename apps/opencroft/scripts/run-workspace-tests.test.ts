// The root `npm test` (scripts/run-workspace-tests.mjs), tested here for the
// same reason run-tests.test.ts is: this is where tooling tests run.
//
// Each case runs the real script over a scratch monorepo of its own, with real
// npm, so what is asserted is what `npm test` does from a repository root. The
// scratch workspaces' test scripts are small node programs that coordinate
// through files in a directory the case owns.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

const SCRIPT = join(import.meta.dirname, '..', '..', '..', 'scripts', 'run-workspace-tests.mjs')
const RUNNER = join(import.meta.dirname, '..', '..', '..', 'scripts', 'run-tests.mjs')

const scratch = mkdtempSync(join(tmpdir(), 'opencroft-run-workspace-tests-test-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * A monorepo whose workspaces are `packages/<name>`, each with `test.mjs` as
 * its test script when one is given, and none when it is `null`. Returns the
 * root and a directory the scripts can coordinate through (`MEET`).
 */
function monorepo(workspaces: Record<string, string | null>): { root: string; meet: string } {
  const root = mkdtempSync(join(scratch, 'repo-'))
  const meet = join(root, 'meet')
  mkdirSync(meet)
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'scratch', private: true, workspaces: ['packages/*'] }),
  )
  for (const [name, source] of Object.entries(workspaces)) {
    const dir = join(root, 'packages', name)
    mkdirSync(dir, { recursive: true })
    const scripts = source === null ? {} : { test: 'node test.mjs' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', scripts }))
    if (source !== null) {
      writeFileSync(join(dir, 'test.mjs'), source)
    }
  }
  return { root, meet }
}

function env(meet: string): NodeJS.ProcessEnv {
  return { ...process.env, MEET: meet }
}

/**
 * The environment for a root run whose workspaces use the repository's real
 * runner, with `concurrency` as OPENCROFT_TEST_CONCURRENCY or none at all.
 * NODE_TEST_CONTEXT marks this process as a file of the run it is part of; a
 * test runner that inherits it reports to a parent that is not listening. The
 * run directory and the cap are this run's, not the outer one's.
 */
function runnerEnv(meet: string, concurrency?: string): NodeJS.ProcessEnv {
  const {
    NODE_TEST_CONTEXT: _context,
    OPENCROFT_TEST_RUN_DIR: _outer,
    OPENCROFT_TEST_CONCURRENCY: _cap,
    ...inherited
  } = env(meet)
  return concurrency === undefined ? inherited : { ...inherited, OPENCROFT_TEST_CONCURRENCY: concurrency }
}

/** Makes `packages/<name>` a workspace whose tests the real runner runs from `src`. */
function runnerWorkspace(root: string, name: string, files: Record<string, string>) {
  const workspace = join(root, 'packages', name)
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name, version: '0.0.0', scripts: { test: `node ${JSON.stringify(RUNNER)}` } }),
  )
  for (const [file, source] of Object.entries(files)) {
    writeFileSync(join(workspace, 'src', file), source)
  }
}

function runIn(root: string, meet: string, environment: NodeJS.ProcessEnv = env(meet)) {
  // spawnSync keeps 1 MiB of output by default and drops the rest; a report
  // larger than that is what one case here is about. A run whose files never
  // get a slot would never end, and a test's own timeout cannot interrupt a
  // synchronous call, so the run is stopped here instead: SIGTERM, which it
  // passes on to every workspace.
  const result = spawnSync(process.execPath, [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

// Program fragments for the scratch workspaces' test scripts.
const PRELUDE = [
  "import { existsSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  'const meet = process.env.MEET',
  'async function waitFor(name) {',
  '  const deadline = Date.now() + 30_000',
  '  while (!existsSync(join(meet, name))) {',
  "    if (Date.now() > deadline) throw new Error(name + ' never appeared')",
  '    await new Promise((resolve) => setTimeout(resolve, 20))',
  '  }',
  '}',
  '',
].join('\n')

test('every workspace with a test script runs, all of them at the same time', () => {
  // Each one waits for the other to have started: run in turn, the first
  // waits out its deadline and fails.
  const meets = (self: string, other: string) =>
    `${PRELUDE}writeFileSync(join(meet, '${self}'), '')\nawait waitFor('${other}')\nconsole.log('${self} met ${other}')\n`
  const { root, meet } = monorepo({ a: meets('a', 'b'), b: meets('b', 'a'), c: null })

  const run = runIn(root, meet)

  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /^a met b$/m)
  assert.match(run.stdout, /^b met a$/m)
  assert.deepEqual(run.stdout.match(/^> \S+ test$/gm), ['> a@0.0.0 test', '> b@0.0.0 test'])
})

test("each workspace's output is printed whole, in npm's order, whichever finishes first", () => {
  // `a` prints half its output, then waits for `b` to have printed all of
  // its own and finished, then prints the rest: interleaved, b's lines would
  // land between a's.
  const { root, meet } = monorepo({
    a: `${PRELUDE}console.log('a: first')\nawait waitFor('b-done')\nconsole.log('a: second')\n`,
    b: `${PRELUDE}console.log('b: first')\nconsole.log('b: second')\nwriteFileSync(join(meet, 'b-done'), '')\n`,
  })

  const run = runIn(root, meet)

  assert.equal(run.status, 0, run.stdout + run.stderr)
  const lines = run.stdout.split('\n').filter((line) => /^[ab]: /.test(line))
  assert.deepEqual(lines, ['a: first', 'a: second', 'b: first', 'b: second'])
})

test('a report of several megabytes reaches a pipe whole', () => {
  // Read through a pipe, as check-baseline reads it. A full run's report is
  // megabytes; this one is about four.
  const { root, meet } = monorepo({
    a: "for (let i = 0; i < 50_000; i++) console.log('line ' + i + ' ' + 'x'.repeat(64))\nconsole.log('end of a')\n",
  })

  const run = runIn(root, meet)

  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^end of a$/m)
  assert.equal(run.stdout.match(/^line \d+ x+$/gm)?.length, 50_000)
})

test('a failing workspace fails the run, and every other workspace is still reported', () => {
  const { root, meet } = monorepo({
    a: "console.log('a ran')\nprocess.exit(3)\n",
    b: "console.log('b ran')\n",
  })

  const run = runIn(root, meet)

  assert.equal(run.status, 1)
  assert.match(run.stdout, /^a ran$/m)
  assert.match(run.stdout, /^b ran$/m)
  assert.match(run.stderr, /^a: tests exited [1-9]\d*$/m)
  assert.doesNotMatch(run.stderr, /^b: tests exited/m)
})

test('OPENCROFT_TEST_CONCURRENCY caps the whole run, half the cores when unset, and reaches every workspace', () => {
  const { root, meet } = monorepo({
    a: "console.log('a cap ' + process.env.OPENCROFT_TEST_CONCURRENCY)\n",
    b: "console.log('b cap ' + process.env.OPENCROFT_TEST_CONCURRENCY)\n",
  })

  const unset = runIn(root, meet, runnerEnv(meet))
  const set = runIn(root, meet, runnerEnv(meet, '3'))
  const half = Math.max(1, Math.floor(availableParallelism() / 2))

  assert.equal(unset.status, 0, unset.stderr)
  assert.match(unset.stdout, new RegExp(`^a cap ${half}$`, 'm'))
  assert.match(unset.stdout, new RegExp(`^b cap ${half}$`, 'm'))
  assert.equal(set.status, 0, set.stderr)
  assert.match(set.stdout, /^a cap 3$/m)
  assert.match(set.stdout, /^b cap 3$/m)
})

// A file that notes how many files are running when it starts, waits until it
// is not the only one, holds a while longer, notes again, then stops counting
// itself before it ends.
//
// The wait has a deadline so that a file left to run alone still ends. The
// hold keeps the files that are running together long enough for a runner
// that lets too many start to show it in the count. It is a fixed pause: on a
// slow machine a file let in over the cap can start after it, so the case can
// miss that bug there, but it cannot fail a correct runner. Six files one at a
// time take about 6 x (5 s + 1.5 s), inside runIn's limit, so a runner that
// never overlaps files fails the count below rather than being stopped.
const COUNTS_OVERLAP = [
  "import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  "import test from 'node:test'",
  "import { setTimeout as sleep } from 'node:timers/promises'",
  "test('overlaps', async () => {",
  "  const running = join(process.env.MEET ?? '', 'running')",
  '  mkdirSync(running, { recursive: true })',
  '  const self = join(running, String(process.pid))',
  "  writeFileSync(self, '')",
  "  const note = () => appendFileSync(join(process.env.MEET ?? '', 'seen'), readdirSync(running).length + '\\n')",
  '  note()',
  '  const deadline = Date.now() + 5_000',
  '  while (readdirSync(running).length < 2 && Date.now() < deadline) await sleep(20)',
  '  await sleep(1500)',
  '  note()',
  '  rmSync(self)',
  '})',
  '',
].join('\n')

test("every workspace's test files take turns in one cap for the whole run", { timeout: 120_000 }, () => {
  // Two workspaces of three files each, under a cap of 2. With a cap per
  // workspace instead, each would run 2 at once, 4 in all.
  const { root, meet } = monorepo({})
  const files = { 'one.test.ts': COUNTS_OVERLAP, 'two.test.ts': COUNTS_OVERLAP, 'three.test.ts': COUNTS_OVERLAP }
  runnerWorkspace(root, 'a', files)
  runnerWorkspace(root, 'b', files)

  const run = runIn(root, meet, runnerEnv(meet, '2'))

  assert.equal(run.status, 0, run.stdout + run.stderr)
  const seen = readFileSync(join(meet, 'seen'), 'utf8').trim().split('\n').map(Number)
  assert.equal(seen.length, 12, 'every file ran')
  assert.equal(Math.max(...seen), 2, `files running at once, as each counted: ${seen.join(' ')}`)
})

test('a test file that is killed hands its slot back', { timeout: 120_000 }, () => {
  // Under a cap of 1, the second file runs only once the first file's slot is
  // free again. The first is killed outright: nothing of its own runs to give
  // the slot back. It is the larger file, so it starts first.
  const { root, meet } = monorepo({})
  runnerWorkspace(root, 'a', {
    'killed.test.ts': `// ${'padding so this file is the larger and starts first '.repeat(4)}\nprocess.kill(process.pid, 'SIGKILL')\n`,
    'after.test.ts': [
      "import { writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import test from 'node:test'",
      "test('after', () => writeFileSync(join(process.env.MEET ?? '', 'after ran'), ''))",
      '',
    ].join('\n'),
  })

  const run = runIn(root, meet, runnerEnv(meet, '1'))

  assert.notEqual(run.status, 0, 'a killed file fails the run')
  assert.match(run.stdout, /killed\.test\.ts/)
  assert.ok(existsSync(join(meet, 'after ran')), run.stdout + run.stderr)
})

test('a process a test starts with its own preloads does not wait for a slot', { timeout: 120_000 }, () => {
  // Under a cap of 1 the file holds the only slot, so a child that queued for
  // one would wait for its own parent to end.
  const { root, meet } = monorepo({})
  runnerWorkspace(root, 'a', {
    'spawns.test.ts': [
      "import assert from 'node:assert/strict'",
      "import { spawnSync } from 'node:child_process'",
      "import test from 'node:test'",
      "test('spawns', () => {",
      "  const child = spawnSync(process.execPath, [...process.execArgv, '-e', \"console.log('child ran')\"], {",
      "    encoding: 'utf8',",
      '    timeout: 20_000,',
      '  })',
      "  assert.equal(child.stdout.trim(), 'child ran', child.stderr)",
      '})',
      '',
    ].join('\n'),
  })

  const run = runIn(root, meet, runnerEnv(meet, '1'))

  assert.equal(run.status, 0, run.stdout + run.stderr)
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function stopsSoon(pid: number): Promise<boolean> {
  const deadline = Date.now() + 10_000
  while (isAlive(pid)) {
    if (Date.now() > deadline) return false
    await sleep(20)
  }
  return true
}

// With a timeout: a file left running keeps the workspace's output pipe open,
// so the root run never sees it close, and without one this case would wait
// out the file's two minutes instead of failing.
test("SIGTERM to the root run stops each workspace's whole process tree", { timeout: 60_000 }, async () => {
  // The chain a real workspace runs -- npm, its `sh -c`, the repository's
  // runner, the test runner, the file -- over a test file that blocks.
  // A SIGTERM to npm alone leaves that file running, so this is reached only
  // by signalling the workspace's process group.
  const { root, meet } = monorepo({})
  runnerWorkspace(root, 'a', {
    'blocks.test.ts': [
      "import { writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import test from 'node:test'",
      "test('blocks', async () => {",
      "  writeFileSync(join(process.env.MEET ?? '', 'pid'), String(process.pid))",
      '  await new Promise((resolve) => setTimeout(resolve, 120_000))',
      '})',
      '',
    ].join('\n'),
  })
  const runner = spawn(process.execPath, [SCRIPT], { cwd: root, env: runnerEnv(meet), stdio: 'ignore' })
  const exited = once(runner, 'exit')
  let pid: number | undefined
  try {
    const deadline = Date.now() + 30_000
    while (!existsSync(join(meet, 'pid')) || readFileSync(join(meet, 'pid'), 'utf8') === '') {
      if (Date.now() > deadline) throw new Error('the workspace never started')
      await sleep(20)
    }
    pid = Number(readFileSync(join(meet, 'pid'), 'utf8'))

    runner.kill('SIGTERM')
    const [code] = await exited

    assert.notEqual(code, 0, 'a stopped run is not a passing one')
    assert.ok(await stopsSoon(pid), "the workspace's program stopped with the run")
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL')
    if (pid && isAlive(pid)) process.kill(pid, 'SIGKILL')
  }
})
