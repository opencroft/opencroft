// The stop path: that it is armed exactly once, and that releasing the database
// is safe to ask for twice.
//
// The handler itself is not invoked here. It ends in process.exit, so running it
// would end the test run and report whatever it exited with as the result —
// a test that cannot fail. What IS checked is the part that was actually wrong:
// the capability existing at all, and being armed once.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { closeDb } from '@opencroft/db'

import { registerShutdownHandlers } from './shutdown'

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

// Last, because it really does close the database this file opened.
test('asking to release the database twice is one release, not two', async () => {
  const first = closeDb()
  const second = closeDb()
  assert.equal(first, second, 'a second caller must join the release in progress rather than start another')
  await first
  await second
})
