// The root `npm test`, and what check-baseline.mjs runs: every workspace's own
// `test` script, all at once, from the directory it is started in.
//
// `npm run test --workspaces` runs them one after another, and most of that
// time is spent waiting rather than computing -- a workspace whose files sleep,
// poll or wait on a child process holds the whole run for as long as it takes.
// Started together, the run takes about as long as its longest workspace.
//
// How many test files run at once is one number for the whole run, not one per
// workspace: half the cores, or OPENCROFT_TEST_CONCURRENCY (see
// test-concurrency.mjs). Each test process of a root run holds a slot of this
// script's for as long as it lives (see test-slot.mjs), and the workspaces take
// them from one pool, first come first served. A cap per workspace would add
// up: started together, the workspaces would run several times that many files
// at once.
//
// Each workspace's output is held until it finishes and then printed whole, in
// the order npm lists the workspaces, so the report reads as it did when they
// ran in turn. check-baseline parses that report: it pairs each `> <pkg> test`
// banner with the `Found N test files.` line and the TAP totals after it, and
// output from two workspaces interleaved line by line would break that
// pairing. Within a workspace, stdout and stderr are each kept in order but
// printed separately, as they were when npm's output was captured through a
// pipe.

import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { testConcurrency } from './test-concurrency.mjs'

const workspaces = listWorkspaces()

const slots = testConcurrency()
const slotDir = mkdtempSync(join(tmpdir(), 'opencroft-test-slots-'))
const slotSocket = join(slotDir, 'slots.sock')
process.on('exit', () => rmSync(slotDir, { recursive: true, force: true }))
const slotServer = await serveSlots(slots, slotSocket)

// A workspace's runner is several processes deep -- npm, its `sh -c`, the
// runner, the test runner, the files -- and the shell passes no signal
// on. So each workspace runs in a process group of its own, and a signal is
// sent to the whole group. SIGHUP goes on as SIGTERM, as run-tests.mjs does
// with it.
const running = new Set()
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    for (const child of running) {
      try {
        process.kill(-child.pid, signal === 'SIGHUP' ? 'SIGTERM' : signal)
      } catch {
        // Already gone.
      }
    }
  })
}

const results = workspaces.map(run)
let failed = false
for (const result of results) {
  const { name, stdout, stderr, code, signal } = await result
  process.stdout.write(Buffer.concat(stdout))
  process.stderr.write(Buffer.concat(stderr))
  if (code !== 0) {
    failed = true
    console.error(`${name}: tests ${signal ? `killed by ${signal}` : `exited ${code}`}`)
  }
}
slotServer.close()
// Not process.exit(): writes to a pipe finish asynchronously, and exiting
// drops whatever has not drained yet. The report is megabytes, so a caller
// reading it through a pipe -- check-baseline does -- got the first part and
// a clean exit status.
process.exitCode = failed ? 1 : 0

// The workspaces npm would run for `npm run test --workspaces --if-present`:
// those with a test script, in npm's order. Read from the workspace globs in
// package.json, as npm reads them, rather than from the installed tree, which
// `npm query` would need and a fresh checkout does not have.
function listWorkspaces() {
  const query = spawnSync('npm', ['pkg', 'get', 'scripts.test', '--workspaces', '--json'], { encoding: 'utf8' })
  if (query.status !== 0) {
    process.stderr.write(query.stderr)
    console.error('npm pkg get failed; cannot tell which workspaces to test.')
    process.exit(1)
  }
  // Keyed by package name; a workspace without the script maps to `{}`.
  return Object.entries(JSON.parse(query.stdout))
    .filter(([, script]) => typeof script === 'string')
    .map(([name]) => name)
}

// The pool: a test process connects, and holds a slot from the byte it is sent
// until its connection closes. The connection closes when the process ends,
// however it ends -- a file that crashes or is killed hands its slot back as
// surely as one that passes. Waiting processes are served in the order they
// asked.
function serveSlots(count, socket) {
  let free = count
  const holding = new Set()
  const waiting = []
  const grant = (connection) => {
    free -= 1
    holding.add(connection)
    connection.write('1')
  }
  const server = createServer((connection) => {
    connection.on('error', () => {
      // A process that died mid-handshake; 'close' follows.
    })
    connection.on('close', () => {
      if (!holding.delete(connection)) {
        waiting.splice(waiting.indexOf(connection), 1)
        return
      }
      free += 1
      const next = waiting.shift()
      if (next) grant(next)
    })
    if (free > 0) {
      grant(connection)
    } else {
      waiting.push(connection)
    }
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () => resolve(server))
  })
}

function run(name) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['run', 'test', '--workspace', name], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      // run-tests.mjs runs at most this many files of its own at once, and
      // has each one take a slot from this run's pool before it starts.
      env: { ...process.env, OPENCROFT_TEST_CONCURRENCY: String(slots), OPENCROFT_TEST_SLOTS: slotSocket },
    })
    running.add(child)
    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    const started = Date.now()
    child.on('close', (code, signal) => {
      running.delete(child)
      // Straight away rather than with the report, which waits for the
      // workspaces listed before this one: a run that prints nothing for
      // minutes looks the same as one that hangs.
      console.error(`${name}: finished in ${Math.round((Date.now() - started) / 1000)} s`)
      resolve({ name, stdout, stderr, code, signal })
    })
  })
}
