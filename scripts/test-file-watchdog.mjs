// Preloaded by run-tests.mjs into every test file's process, after the slot
// gate and before tsx, so a file's limit starts when it may run rather than
// while it waits for a slot. It tells the runner's watchdog
// (test-file-limit.mjs) which file this process runs and its pid; the
// watchdog keeps the clock and does the killing.
//
// When the limit passes the watchdog sends one line back. This then runs
// node:test's own handler for an event loop that ran dry with tests pending,
// so every test still running is reported by name, as cancelled, and the
// process exits failed. A process too busy to read the line (blocked in
// synchronous code) never gets here; the watchdog kills it after a grace
// period, and only the file is named.
//
// The socket is taken out of the environment once connected, so a process the
// test starts (a fork inherits the preloads) does not announce itself as the
// file.

import { connect } from 'node:net'

// How long the report has to reach the runner before the process exits: the
// cancelled tests are written to stdout through a stream, a few ticks later.
// Well inside the watchdog's grace period.
const REPORT_FLUSH_MS = 1000

const socket = process.env.OPENCROFT_TEST_WATCHDOG
if (socket) {
  delete process.env.OPENCROFT_TEST_WATCHDOG
  // Waited for, so a file never runs unwatched: one that cannot reach the
  // watchdog fails here instead.
  const watchdog = await new Promise((resolve, reject) => {
    const connection = connect(socket)
    connection.once('connect', () => resolve(connection))
    connection.once('error', (error) => reject(new Error(`no test watchdog at ${socket}: ${error.message}`)))
  })
  watchdog.on('error', () => {
    // The runner is gone; there is nobody left to report to.
  })
  // Held open without keeping the process alive. A file that is done exits as
  // it would without the watchdog, and its closed connection tells the
  // watchdog so.
  watchdog.unref()
  watchdog.setEncoding('utf8')
  watchdog.write(`${JSON.stringify({ pid: process.pid, file: process.argv[1] })}\n`)
  watchdog.on('data', (line) => {
    if (!line.startsWith('timeout ')) return
    const seconds = line.slice('timeout '.length).trim()
    console.error(`Timed out after ${seconds} s. Tests still running are reported as cancelled.`)
    process.exitCode = 1
    process.emit('beforeExit', 1)
    setTimeout(() => process.exit(1), REPORT_FLUSH_MS)
  })
}
