// Shared by every workspace's own "test" script. Runs from that workspace's
// directory (as npm sets cwd for `npm run test -w <name>`), so tsx resolves
// that workspace's own tsconfig.json paths -- running from the repo root
// instead resolves the wrong (or no) path aliases and every `@/...` import
// fails to resolve.
//
// Finds every *.test.ts(x) under the given roots (directories or single test
// files, relative to cwd, default ["src"]) and runs them through Node's test runner via tsx, several files at
// once. Node gives every file its own process, and a process that touches the
// database gets its own throwaway PGlite datadir from the workspace preload
// (@opencroft/db's test-env) or from the suite itself -- so files running side
// by side never share one. Two processes on one datadir would corrupt it, or,
// since packages/db's advisory lock, refuse; either is a failed run, which is
// why an inherited OPENCROFT_PGLITE_PATH is cleared below rather than handed to every
// file at once.
//
// Every file runs under a wall-clock limit (test-file-limit.mjs). One that
// passes it is named, killed with the processes it started, and fails the
// run, which goes on with the other files.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { testConcurrency } from './test-concurrency.mjs'
import { testEnvironment } from './test-environment.mjs'
import { defaultFileTimeout, fileTimeouts, startWatchdog } from './test-file-limit.mjs'

// The repository's own tsx, as a loader of this node's rather than through
// `npx` or tsx's command line. Under npx a signal sent to this process stopped
// at npm's `sh -c` wrapper, which exits without passing it on, so the test
// files kept running after the run had ended; and from a directory outside the
// repository npx runs whatever tsx its own cache holds. tsx's command line puts
// its own preloads ahead of any given to it, and the first of them holds about
// 80 MB per process, where the slot gate below has to come first.
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

const SLOT_GATE = pathToFileURL(join(import.meta.dirname, 'test-slot.mjs')).href

const FILE_WATCHDOG = pathToFileURL(join(import.meta.dirname, 'test-file-watchdog.mjs')).href

const TIMINGS_REPORTER = pathToFileURL(join(import.meta.dirname, 'test-timings.mjs')).href

const RUN_DIR_PREFIX = 'opencroft-test-run-'

// How old a run directory must be before a later run removes it. Only a run
// that died where no handler runs -- SIGKILL, an OOM kill, a host going down
// -- leaves one, and each holds a migrated datadir. Six hours, as for
// test-env's datadirs and for the same reason: a run that is still going is
// never that old. A directory's mtime moves only when an entry directly inside
// it is added or removed, which happens as the run starts, so it is never
// earlier than the run's start.
const STALE_RUN_MS = 6 * 60 * 60 * 1000

// How many of them one run removes, so a backlog costs each run a bounded
// amount instead of one run all of it.
const MAX_SWEEP = 200

const roots = process.argv.slice(2)
if (roots.length === 0) {
  roots.push('src')
}

const testFiles = []

function isTestFile(name) {
  return name.endsWith('.test.ts') || name.endsWith('.test.tsx')
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full)
    } else if (isTestFile(entry)) {
      testFiles.push(full)
    }
  }
}

// A root is a directory to walk or a single test file. Any other file stops
// the run: it would otherwise run nothing and end as a pass.
for (const root of roots) {
  if (!existsSync(root)) continue
  if (statSync(root).isDirectory()) {
    walk(root)
  } else if (isTestFile(root)) {
    testFiles.push(root)
  } else {
    console.error(`${root} is neither a directory nor a *.test.ts(x) file.`)
    process.exit(1)
  }
}

// Largest first. Files start in this order as slots free up, so a long file
// started late is the last thing still running while every other slot sits
// idle -- and the longest files here are the largest. Size says nothing about
// a file that is slow because of what it imports, which is why this is an
// ordering and not a schedule. Path breaks ties, so the order is the same on
// every machine.
const sizes = new Map(testFiles.map((file) => [file, statSync(file).size]))
testFiles.sort((a, b) => sizes.get(b) - sizes.get(a) || (a < b ? -1 : 1))
console.log(`Found ${testFiles.length} test files.\n`)

if (testFiles.length === 0) {
  process.exit(0)
}

// Each file's wall-clock limit (see test-file-limit.mjs). A declaration that
// cannot be used is fixed before anything runs, not discovered when the file
// it was meant for times out.
const defaultSeconds = defaultFileTimeout()
const { limits, problems } = fileTimeouts(testFiles, defaultSeconds)
if (problems.length > 0) {
  for (const problem of problems) console.error(problem)
  process.exit(1)
}

const args = []
// Under the root run, each file first waits for a slot of the run's pool, so
// the concurrency below is the most this workspace runs at once, and the cap
// is the pool's, shared by every workspace. Before tsx, so a file that waits
// has loaded nothing yet: about 45 MB RSS, against about 250 MB behind tsx.
if (process.env.OPENCROFT_TEST_SLOTS) {
  args.push('--import', SLOT_GATE)
}
// After the slot gate, so a file's clock starts once it may run.
args.push('--import', FILE_WATCHDOG)
args.push('--import', TSX)
// A workspace-local preload -- e.g. one that gives DB-touching suites a
// default throwaway datadir -- is opted into by placing it at this path.
if (existsSync('scripts/test-setup.mjs')) {
  args.push('--import', './scripts/test-setup.mjs')
}
args.push('--test', `--test-concurrency=${testConcurrency()}`)
// Node picks its reporter from whether stdout is a terminal, so a caller that
// captures this output gets one format interactively and another through a
// pipe. A caller that parses the results asks for the machine-readable one by
// name rather than depending on which side of that default it landed on.
//
// Naming any reporter replaces that default, so when the timings reporter is
// added the report on stdout is named too, as Node would have picked it.
const timingsDir = process.env.OPENCROFT_TEST_TIMINGS
if (process.env.OPENCROFT_TEST_TAP || timingsDir) {
  const report = process.env.OPENCROFT_TEST_TAP || !process.stdout.isTTY ? 'tap' : 'spec'
  args.push(`--test-reporter=${report}`, '--test-reporter-destination=stdout')
}
// Each finished test's time, for the slowest-tests list the root run ends
// with (test-timings.mjs). One file per workspace, named by this process.
if (timingsDir) {
  args.push(
    `--test-reporter=${TIMINGS_REPORTER}`,
    `--test-reporter-destination=${join(timingsDir, `${process.pid}.jsonl`)}`,
  )
}
args.push(...testFiles.map((f) => relative('.', f)))

// Only the variables test-environment.mjs lists reach a file; credentials and
// anything else the caller's shell holds stay behind. These dropped ones
// matter here in particular:
// - TSX_TSCONFIG_PATH: a caller with one exported would decide what every
//   workspace compiles against. A tsconfig from elsewhere resolves path
//   aliases this package cannot, so files that fail to load under the
//   package's own configuration load under someone else's and run different
//   code -- and a file the named tsconfig does not claim is compiled with no
//   tsconfig at all, losing settings the package depends on. The package's own
//   is set below.
// - OPENCROFT_PGLITE_PATH (and its former name PGLITE_PATH, which the database
//   code still honours): inherited by every file at once, one datadir would be
//   shared by all of them. Left unset, each process makes its own (see the
//   header).
// - BETTER_AUTH_SECRET and SECRETS_KEY, former names that could otherwise
//   stand in for the two keys set below.
const env = testEnvironment(process.env)
// Set for every file, so no test that signs a session or encrypts a secret
// falls through to the instance key file, which would be created in the data
// directory of the checkout the run started from. Tests of the key file
// itself unset them and point OPENCROFT_DATA_DIR at a directory of their own.
env.OPENCROFT_AUTH_SECRET = 'test-auth-secret-not-a-real-one'
env.OPENCROFT_SECRETS_KEY = 'test-secrets-key-not-a-real-one'
// A workspace-local tsconfig.test.json is the test runner's own answer to
// rendering JSX: the shared tsconfig leaves the transform to the bundler
// (`jsx: preserve`), which the runner has none of, so a component throws
// `React is not defined` under its classic-transform fallback. tsx loads one
// tsconfig for the whole process -- this one when named, otherwise whatever it
// finds searching up from the working directory -- so this reaches only the
// runner, and the workspace's real tsconfig.json, read by typecheck and the
// build, is untouched.
if (existsSync('tsconfig.test.json')) {
  env.TSX_TSCONFIG_PATH = resolve('tsconfig.test.json')
}

// One scratch directory for the whole run, shared by every file in it. Test
// files reach it through OPENCROFT_TEST_RUN_DIR. It is removed when the run
// ends, or, if the run dies where the exit hook cannot run, by a later run's
// sweep.
sweepStaleRunDirs()
const runDir = mkdtempSync(join(tmpdir(), RUN_DIR_PREFIX))
env.OPENCROFT_TEST_RUN_DIR = runDir
process.on('exit', () => rmSync(runDir, { recursive: true, force: true }))

// Forwarded rather than left to their default, which ends this process
// without the exit hook above and leaves the files running. The run ends
// when the child does. The test runner stops its files on SIGINT and SIGTERM
// but not on SIGHUP, which ends it alone and leaves the files running, so a
// SIGHUP is sent on as SIGTERM. The setup blocks the event loop, so a
// signal that arrives during it is handled once it returns, and stops the
// files instead. One that arrives before then, while the watchdog starts,
// has no files to stop and ends the run.
let child
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => (child ? child.kill(signal === 'SIGHUP' ? 'SIGTERM' : signal) : process.exit(1)))
}

// In the run directory, so it goes with it.
env.OPENCROFT_TEST_WATCHDOG = join(runDir, 'watchdog.sock')
const watchdog = await startWatchdog(env.OPENCROFT_TEST_WATCHDOG, limits, defaultSeconds)

runGlobalSetup()
child = spawn(process.execPath, args, { stdio: 'inherit', env })
child.on('close', (code) => {
  watchdog.stop()
  // On stderr, as the last lines of the run: the report on stdout shows a
  // timed-out file only as failed, among every other failure. The run fails
  // without help: a timed-out file exits failed or is killed, and the test
  // runner counts either as a failed file.
  for (const { file, seconds } of watchdog.timedOut) {
    console.error(`Timed out: ${file} (limit ${seconds} s).`)
  }
  process.exit(code ?? 1)
})

// Removes run directories left by runs that died before their exit hook ran.
// Directories only: lstat, so a link with this prefix is never followed.
function sweepStaleRunDirs() {
  const root = tmpdir()
  const cutoff = Date.now() - STALE_RUN_MS
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return
  }
  let collected = 0
  for (const entry of entries) {
    if (collected >= MAX_SWEEP) {
      return
    }
    if (!entry.startsWith(RUN_DIR_PREFIX)) {
      continue
    }
    const full = join(root, entry)
    try {
      const stat = lstatSync(full)
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true })
        collected += 1
      }
    } catch {
      // Raced with that run's own cleanup, or not ours to remove; the next
      // run asks again.
    }
  }
}

// A workspace-local scripts/test-global-setup.mjs runs once, before any test
// file, with the same environment they get. It prepares what every file would
// otherwise build for itself -- a migrated database, for a workspace whose
// suites open one -- and leaves it in the run directory.
//
// A setup that fails is reported and the run goes on without it: what it
// prepares only saves time, so each file still builds its own, and whatever
// broke the setup then fails the suites it breaks, where the run reports it.
function runGlobalSetup() {
  if (!existsSync('scripts/test-global-setup.mjs')) {
    return
  }
  // Its stdout goes to stderr: stdout is the test report, which a caller may
  // parse line by line.
  const setup = spawnSync(process.execPath, ['--import', TSX, 'scripts/test-global-setup.mjs'], {
    stdio: ['ignore', 2, 2],
    env,
  })
  if (setup.status !== 0) {
    console.error(
      `scripts/test-global-setup.mjs failed (${setup.signal ?? `exit ${setup.status}`}); running without it.`,
    )
  }
}
