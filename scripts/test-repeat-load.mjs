// The load scripts/test-repeat.mjs runs its files under with --load: busy
// threads, THREADS_PER_CPU for each CPU, so a test file gets a small share of
// the processor, as it does in a full `npm test` on a host other runs share.
//
// The number is where a known load-only failure starts to show, measured on a
// 12-CPU host on 2026-11-16 with a markdown editor test that fails only under
// a loaded full run: one busy thread per CPU, 6 of 6 runs passed; two, 10 of
// 10 passed; three, it failed 8 of 10 and passed 2; four, it failed 3 of 3.
// Three makes such a test flip rather than fail every run, which is what this
// tool reports on.
//
// The host is shared, and this slows everything else on it, so two guards:
// - one load per host: the load holds an flock on LOCK_PATH, taken without
//   waiting, and a second --load refuses while it is held;
// - a hard cap: the threads stop, and the lock is let go, `capSeconds` after
//   the start, however far the runs have got.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'

const THREADS_PER_CPU = 3

/** Host-wide, so every checkout's runs share it. A test points it elsewhere. */
const LOCK_PATH = process.env.OPENCROFT_TEST_REPEAT_LOCK ?? '/tmp/opencroft-test-repeat-load.lock'

/** Who holds the lock: written beside it once taken, read by a refused run. */
const HOLDER_PATH = `${LOCK_PATH}.holder`

const CONFLICT = 75

/**
 * Takes the lock. The lock is held by an `flock` child running `cat` on a pipe
 * from this process: when this process ends, however it ends, the pipe
 * closes, `cat` exits and the lock is released. Resolves to that child, or to
 * null when another run holds the lock.
 */
function takeLock() {
  return new Promise((resolve, reject) => {
    const holder = spawn('flock', ['-n', '-E', String(CONFLICT), LOCK_PATH, '-c', 'echo locked; exec cat'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    })
    holder.on('error', reject)
    holder.stdout.once('data', () => resolve(holder))
    holder.on('exit', (code) => {
      if (code === CONFLICT) resolve(null)
      else reject(new Error(`flock exited ${code} before taking ${LOCK_PATH}`))
    })
  })
}

function currentHolder() {
  try {
    return readFileSync(HOLDER_PATH, 'utf8').trim()
  } catch {
    return 'a run that has not said who it is'
  }
}

/**
 * Starts the load for at most `capSeconds`. Resolves to
 * `{ description, stop }`, or to `{ refused }` naming the run that holds the
 * load. The workers are threads of this process, so they end with it however
 * it ends. `onCap` is called if the cap stops the load.
 */
export async function startLoad(capSeconds, onCap) {
  const lock = await takeLock()
  if (!lock) {
    return { refused: `another --load run holds ${LOCK_PATH}: ${currentHolder()}` }
  }
  writeFileSync(HOLDER_PATH, `pid ${process.pid} in ${process.cwd()}, since ${new Date().toISOString()}\n`)
  const count = THREADS_PER_CPU * availableParallelism()
  const workers = Array.from({ length: count }, () => new Worker('for (;;) {}', { eval: true }))
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    clearTimeout(cap)
    for (const worker of workers) void worker.terminate()
    lock.stdin.end()
  }
  const cap = setTimeout(() => {
    stop()
    onCap()
  }, capSeconds * 1000)
  cap.unref()
  return { description: `${count} busy threads, ${THREADS_PER_CPU} per CPU, for at most ${capSeconds} s`, stop }
}
