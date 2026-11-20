// Flake detector: runs each given test file several times and prints, per
// file, how its runs went and which tests flipped between passing and failing.
//
//   node scripts/test-repeat.mjs <test-file>... [--times N] [--timeout S] [--load [--load-cap S]]
//
// --times N     runs per file, default 10.
// --timeout S   each run's file limit in seconds (OPENCROFT_TEST_FILE_TIMEOUT);
//               without it the runner's default applies. A file that declares
//               a longer limit keeps it.
// --load        keeps the host busy while the files run (test-repeat-load.mjs).
//               One --load per host at a time: a second one refuses (exit 3),
//               naming the run that holds it.
// --load-cap S  stops the load S seconds after it started, default 300,
//               however far the runs have got; the runs go on without it.
//
// Each run is one run of the project runner (run-tests.mjs) over that one
// file, from the file's workspace, so it gets the environment, preloads,
// database template and file limit a real run gives it. Runs go one after
// another. A file whose runs all pass proves nothing about a rare flake:
// this detects, it does not certify.
//
// Prints one line per file on stdout (format in test-repeat-report.mjs) and
// progress on stderr. The reports of runs that did not pass are kept in a
// directory named at the end. Exit 0 when every run of every file passed,
// 1 when any did not, 2 when the arguments are wrong, 3 when --load is
// refused.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { startLoad } from './test-repeat-load.mjs'
import { formatSummary, readTap, runOutcome, summarise } from './test-repeat-report.mjs'

const RUNNER = join(import.meta.dirname, 'run-tests.mjs')
const DEFAULT_TIMES = 10

// Long enough for a few runs of a slow file under load, short enough that a
// forgotten run does not hold the host for long.
const DEFAULT_LOAD_CAP_S = 300

const USAGE = 'usage: node scripts/test-repeat.mjs <test-file>... [--times N] [--timeout S] [--load [--load-cap S]]'

function usageError(message) {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

function parseArgs(argv) {
  const options = { files: [], times: DEFAULT_TIMES, timeout: undefined, load: false, loadCap: undefined }
  const numeric = { '--times': 'times', '--timeout': 'timeout', '--load-cap': 'loadCap' }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--load') {
      options.load = true
    } else if (Object.hasOwn(numeric, arg)) {
      const value = argv[++i]
      if (!/^[1-9]\d*$/.test(value ?? '')) usageError(`${arg} takes a whole number above 0, got ${value ?? 'nothing'}`)
      options[numeric[arg]] = Number(value)
    } else if (arg.startsWith('--')) {
      usageError(`unknown option ${arg}`)
    } else {
      options.files.push(arg)
    }
  }
  if (options.files.length === 0) usageError('no test file given')
  if (options.loadCap !== undefined && !options.load) usageError('--load-cap needs --load')
  options.loadCap ??= DEFAULT_LOAD_CAP_S
  return options
}

/**
 * The nearest directory above `file` with a package.json: the workspace
 * whose test script would run it. The file's own directory when there is
 * none.
 */
function workspaceOf(file) {
  for (let dir = dirname(file); ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'package.json'))) return dir
    if (dirname(dir) === dir) return dirname(file)
  }
}

function checkedFile(arg) {
  const file = resolve(arg)
  if (!existsSync(file) || !statSync(file).isFile()) usageError(`no file at ${arg}`)
  if (!/\.test\.tsx?$/.test(file)) usageError(`${arg} is not a *.test.ts(x) file`)
  return file
}

/**
 * The environment of each run. Settings a surrounding run left for its own
 * files are dropped, since the runner would take them for this run's: the
 * timings collector, the slot pool and the file limit.
 */
function runEnvironment(timeout) {
  const {
    OPENCROFT_TEST_TIMINGS: _timings,
    OPENCROFT_TEST_SLOTS: _slots,
    OPENCROFT_TEST_FILE_TIMEOUT: _limit,
    ...inherited
  } = process.env
  const env = { ...inherited, OPENCROFT_TEST_TAP: '1' }
  if (timeout !== undefined) env.OPENCROFT_TEST_FILE_TIMEOUT = String(timeout)
  return env
}

let current = null
let stopping = false
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    stopping = true
    if (current) current.kill('SIGTERM')
    else process.exit(130)
  })
}

/**
 * One run of the runner over `file`, given to it as `root` from `ws`: its
 * exit code, report and stderr.
 */
function runOnce(ws, root, env) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [RUNNER, root], {
      cwd: ws,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    current = child
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => {
      current = null
      resolvePromise({ exitCode: code, stdout, stderr })
    })
  })
}

const options = parseArgs(process.argv.slice(2))
const files = options.files.map(checkedFile)
const env = runEnvironment(options.timeout)
let reportsDir = null
let load = null
if (options.load) {
  load = await startLoad(options.loadCap, () =>
    console.error(`load: stopped at its ${options.loadCap} s cap; the runs go on without it`),
  )
  if (load.refused) {
    console.error(`load: refused, ${load.refused}`)
    process.exit(3)
  }
  console.error(`load: ${load.description}`)
}

let allPassed = true
for (const file of files) {
  const shown = relative(process.cwd(), file)
  const ws = workspaceOf(file)
  const root = relative(ws, file)
  const runs = []
  for (let i = 1; i <= options.times && !stopping; i++) {
    const started = performance.now()
    const { exitCode, stdout, stderr } = await runOnce(ws, root, env)
    if (stopping) break
    const results = readTap(stdout, root)
    // The runner's own line for a file it killed at the limit.
    const timedOut = stderr.includes(`Timed out: ${root} (limit `)
    const outcome = runOutcome({ exitCode, timedOut, results })
    runs.push({ outcome, results })
    const seconds = ((performance.now() - started) / 1000).toFixed(1)
    console.error(`${shown} run ${i}/${options.times}: ${outcome} (${seconds} s)`)
    if (outcome !== 'pass') {
      reportsDir ??= mkdtempSync(join(tmpdir(), 'test-repeat-'))
      const name = `${basename(file)}.run-${i}`
      writeFileSync(join(reportsDir, `${name}.tap`), stdout)
      writeFileSync(join(reportsDir, `${name}.stderr`), stderr)
    }
  }
  if (runs.length === 0) break
  const summary = summarise(shown, runs)
  if (summary.passes !== summary.runs) allPassed = false
  console.log(formatSummary(summary))
}

load?.stop()
if (reportsDir) console.error(`reports of the runs that did not pass: ${reportsDir}`)
if (stopping) process.exit(130)
process.exit(allPassed ? 0 : 1)
