// The wall-clock limit on every test file of a run, and the watchdog that
// holds each file to it. A file that keeps its process open -- a server left
// listening, a timer, a child process, a promise nothing settles -- would
// otherwise hold the whole run for as long as nobody kills it.
//
// Each file's process announces itself (test-file-watchdog.mjs) and its clock
// starts then. When the limit passes, the file is named on stderr, every
// process it started is killed, and the file is asked to report what is still
// running and exit; one that has not exited after a grace period is killed as
// well. The run carries on with the other files and ends failed.
//
// A file may need longer than the default. It says so in a comment of its own,
// with the reason beside the number:
//
//   // test-file-timeout: 300 s, because <why this file needs longer>
//
// A declaration without a reason, one that is not longer than
// DEFAULT_FILE_TIMEOUT_S, or more than one in a file, stops the run before any
// file starts. Whether a declaration is valid is a fact about the source alone:
// OPENCROFT_TEST_FILE_TIMEOUT changes how long files get, never which
// declarations stand. A file gets the longer of its declaration and the run's
// default.

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { relative, resolve } from 'node:path'

// Four times the slowest healthy file, so a host more loaded than when it was
// measured does not turn a slow file into a timed-out one. Measured in two
// root runs on the development host (2026-10-29, 524 files): the slowest file
// took 58 s and 60 s, the 99th percentile 26 s and 41 s. A hang costs the run
// at most this long, against five to seven minutes for the run itself.
export const DEFAULT_FILE_TIMEOUT_S = 240

// How long a timed-out file has, once asked, to report and exit before it is
// killed. Its report needs a moment to reach the runner; a file that cannot
// answer at all is blocked in synchronous code.
const KILL_GRACE_MS = 5000

// The longest delay a timer holds: setTimeout takes at most 2^31 - 1 ms and
// fires a longer delay after 1 ms instead. A limit beyond it, declared or
// requested, is held to this, which is over 24 days.
const MAX_TIMER_S = Math.floor((2 ** 31 - 1) / 1000)

const DECLARATION = /^[ \t]*\/\/[ \t]*test-file-timeout:(.*)$/gm
const DECLARED_VALUE = /^\s*(\d+)\s*s\b[\s,;:.-]*(.*?)\s*$/
const MIN_REASON_WORDS = 3

/**
 * The limit a file gets unless it declares one: OPENCROFT_TEST_FILE_TIMEOUT
 * seconds when set to a positive number, the default otherwise.
 */
export function defaultFileTimeout() {
  const requested = Number(process.env.OPENCROFT_TEST_FILE_TIMEOUT)
  return requested > 0 ? requested : DEFAULT_FILE_TIMEOUT_S
}

/**
 * Each file's limit in seconds, keyed by absolute path: the longer of its
 * declaration and `defaultSeconds`, the run's default. Also what is wrong with
 * the declarations that cannot be used, judged against DEFAULT_FILE_TIMEOUT_S.
 */
export function fileTimeouts(files, defaultSeconds) {
  const limits = new Map()
  const problems = []
  for (const file of files) {
    const declarations = [...readFileSync(file, 'utf8').matchAll(DECLARATION)]
    limits.set(resolve(file), defaultSeconds)
    if (declarations.length === 0) continue
    if (declarations.length > 1) {
      problems.push(`${file}: declares test-file-timeout ${declarations.length} times; one is the file's limit.`)
      continue
    }
    const value = DECLARED_VALUE.exec(declarations[0][1])
    if (!value) {
      problems.push(`${file}: test-file-timeout is written "// test-file-timeout: <seconds> s, <reason>".`)
      continue
    }
    const seconds = Number(value[1])
    if (value[2].split(/\s+/).filter(Boolean).length < MIN_REASON_WORDS) {
      problems.push(`${file}: test-file-timeout: ${seconds} s has no reason beside it.`)
      continue
    }
    if (seconds <= DEFAULT_FILE_TIMEOUT_S) {
      problems.push(
        `${file}: test-file-timeout: ${seconds} s is not longer than the default of ${DEFAULT_FILE_TIMEOUT_S} s.`,
      )
      continue
    }
    limits.set(resolve(file), Math.max(seconds, defaultSeconds))
  }
  return { limits, problems }
}

/**
 * Listens on `socket` for test file processes and holds each to its limit;
 * resolves once it is listening. `stop()` kills whatever is still in its grace period and closes the socket;
 * `timedOut` lists the files that passed their limit, as `{ file, seconds }`.
 */
export function startWatchdog(socket, limits, defaultSeconds) {
  const timedOut = []
  const killPending = new Set()
  const server = createServer((connection) => {
    let announced = ''
    let timer
    let kill
    connection.setEncoding('utf8')
    connection.on('error', () => {
      // A process that died mid-line; 'close' follows.
    })
    connection.on('data', (chunk) => {
      if (timer) return
      announced += chunk
      if (!announced.includes('\n')) return
      const { pid, file } = JSON.parse(announced.slice(0, announced.indexOf('\n')))
      const seconds = limits.get(file) ?? defaultSeconds
      timer = setTimeout(() => {
        const name = relative('.', file)
        timedOut.push({ file: name, seconds })
        console.error(`${name}: timed out after ${seconds} s; killing it and every process it started.`)
        killTree(pid, { self: false })
        connection.write(`timeout ${seconds}\n`)
        kill = () => killTree(pid, { self: true })
        killPending.add(kill)
        setTimeout(() => {
          if (killPending.delete(kill)) kill()
        }, KILL_GRACE_MS).unref()
      }, Math.min(seconds, MAX_TIMER_S) * 1000)
    })
    connection.on('close', () => {
      clearTimeout(timer)
      killPending.delete(kill)
    })
  })
  server.unref()
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socket, () =>
      resolve({
        timedOut,
        stop() {
          for (const kill of killPending) kill()
          killPending.clear()
          server.close()
        },
      }),
    )
  })
}

// Every process descended from `pid`, and `pid` itself when `self`, killed
// outright. Found from the process table at the moment of the kill: a process
// that has since left the tree (one that detached itself, or whose parent
// exited) is out of reach.
function killTree(pid, { self }) {
  const targets = descendantsOf(pid)
  if (self) targets.push(pid)
  for (const target of targets) {
    try {
      process.kill(target, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function descendantsOf(pid) {
  const children = new Map()
  for (const [child, parent] of processTable()) {
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(child)
  }
  const found = []
  const queue = [pid]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

// [pid, parent pid] for every process: from /proc where there is one, from
// `ps` elsewhere.
function processTable() {
  if (!existsSync('/proc/self/status')) {
    const ps = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' })
    return (ps.stdout ?? '')
      .split('\n')
      .map((line) => line.trim().split(/\s+/).map(Number))
      .filter(([child, parent]) => child > 0 && parent >= 0)
  }
  const table = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const parent = /^PPid:\s*(\d+)$/m.exec(readFileSync(`/proc/${entry}/status`, 'utf8'))
      if (parent) table.push([Number(entry), Number(parent[1])])
    } catch {
      // Exited while the table was read.
    }
  }
  return table
}
