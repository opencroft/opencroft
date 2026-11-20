// The stop path: that it is armed exactly once, that a worker thread can be
// asked to stop, and that releasing the database is safe to ask for twice.
//
// The signal handler itself is not invoked here. It ends in process.exit, so
// running it would end the test run and report whatever it exited with as the
// result — a test that cannot fail. What IS checked is what the stop path
// depends on: that the capability exists at all, and that it is armed once. The
// worker-thread stop does not exit, so it is run for real, in a worker.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Worker } from 'node:worker_threads'

import { closeDb } from '@opencroft/db'
import { lockDatadir } from '@opencroft/db/datadir-lock'

import { registerShutdownHandlers } from './shutdown'
import { WORKER_STOP_REQUEST, WORKER_STOPPED } from './worker-stop'

type StopSignal = 'SIGTERM' | 'SIGINT'
type SignalListener = (...args: unknown[]) => void

const SIGNALS: readonly StopSignal[] = ['SIGTERM', 'SIGINT']

const globalForShutdown = globalThis as unknown as { __opencroftShutdownRegistered?: boolean }

function listenersOf(signal: StopSignal): SignalListener[] {
  return process.listeners(signal) as unknown as SignalListener[]
}

function counts(): number[] {
  return SIGNALS.map((signal) => listenersOf(signal).length)
}

test('the stop is armed once, however many times boot runs', () => {
  const before = new Map(SIGNALS.map((signal) => [signal, new Set(listenersOf(signal))]))
  const startingCounts = counts()
  try {
    registerShutdownHandlers()
    assert.deepEqual(
      counts(),
      startingCounts.map((count) => count + 1),
      'each stop signal must get a handler',
    )

    // Boot is idempotent and reachable from more than one entry point. A second
    // arming would release the database twice on one stop.
    registerShutdownHandlers()
    assert.deepEqual(
      counts(),
      startingCounts.map((count) => count + 1),
      'arming twice must not add a second handler',
    )
  } finally {
    // Removed again, and this matters beyond tidiness: the handler ends in
    // process.exit(0), so one left behind would turn an interrupted test run
    // into one that reports success.
    for (const signal of SIGNALS) {
      const known = before.get(signal)
      for (const listener of listenersOf(signal)) {
        if (!known?.has(listener)) {
          process.off(signal, listener)
        }
      }
    }
    globalForShutdown.__opencroftShutdownRegistered = false
  }
  assert.deepEqual(counts(), startingCounts, 'the test must leave no stop handler behind')
})

// A worker that never answers must fail the test, not hang the run: the deadline
// is on the wait itself, so the worker is still ended in `finally`.
const STOP_ANSWER_DEADLINE_MS = 30_000

test('a worker thread asked to stop releases its database and says so', async () => {
  // The worker opens a real datadir of its own, so its release is visible from
  // here as the datadir lock becoming free while the thread is still running.
  const workdir = mkdtempSync(join(tmpdir(), 'opencroft-shutdown-worker-test-'))
  const dataDir = join(workdir, 'pglite')
  const script = join(workdir, 'worker.mts')
  writeFileSync(
    script,
    [
      "import { parentPort } from 'node:worker_threads'",
      // The app's own imports are extensionless TypeScript.
      `const { register } = await import(${JSON.stringify(import.meta.resolve('tsx/esm/api'))})`,
      'register()',
      // Importing it opens the database, as it does in the app.
      `const { registerShutdownHandlers } = await import(${JSON.stringify(join(import.meta.dirname, 'shutdown.ts'))})`,
      'registerShutdownHandlers()',
      "parentPort.postMessage('ready')",
      '',
    ].join('\n'),
  )
  // No inherited execArgv: a runner's preloads would load before the worker
  // has registered tsx.
  const worker = new Worker(script, { env: { ...process.env, OPENCROFT_PGLITE_PATH: dataDir }, execArgv: [] })
  try {
    const [first] = await once(worker, 'message')
    assert.equal(first, 'ready')

    let timer: ReturnType<typeof setTimeout> | undefined
    const stopped = new Promise<void>((resolve, reject) => {
      // biome-ignore lint/plugin/noTestFixedTime: a deadline that only bounds failure, when the worker never answers
      timer = setTimeout(() => reject(new Error('the worker never answered the stop request')), STOP_ANSWER_DEADLINE_MS)
      worker.on('message', (message: { type?: unknown }) => {
        if (message?.type === WORKER_STOPPED) resolve()
      })
    })
    worker.postMessage({ type: WORKER_STOP_REQUEST })
    await stopped.finally(() => clearTimeout(timer))

    const lock = await lockDatadir(dataDir, { siblingWaitMs: 0 })
    await lock.release()
  } finally {
    await worker.terminate()
    rmSync(workdir, { recursive: true, force: true })
  }
})

// Last, because it really does close the database this file opened.
test('asking to release the database twice is one release, not two', async () => {
  const first = closeDb()
  const second = closeDb()
  assert.equal(first, second, 'a second caller must join the release in progress rather than start another')
  await first
  await second
})
