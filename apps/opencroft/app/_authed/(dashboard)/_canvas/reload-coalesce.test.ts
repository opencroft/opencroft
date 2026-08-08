// Pins coalesceReload's contract directly: a call arriving while one is
// already in flight must not run concurrently with it, and a burst of calls
// during one run must collapse into exactly one trailing extra run.
import assert from 'node:assert/strict'
import test from 'node:test'

import { coalesceReload, type ReloadCoalesceState } from './reload-coalesce'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

test('a second call while one is in flight does not run concurrently', async () => {
  const state: ReloadCoalesceState = { inFlight: false, pending: false, nextRun: null }
  const active: number[] = []
  let maxConcurrent = 0
  let runCount = 0
  const gate = deferred<void>()

  async function run(): Promise<void> {
    runCount += 1
    const id = runCount
    active.push(id)
    maxConcurrent = Math.max(maxConcurrent, active.length)
    if (id === 1) {
      await gate.promise
    }
    active.splice(active.indexOf(id), 1)
  }

  const first = coalesceReload(state, run)
  // First call is now mid-flight (blocked on the gate). A second call
  // arriving now must queue, not start its own concurrent run.
  assert.equal(state.inFlight, true)
  const second = coalesceReload(state, run)
  assert.equal(state.pending, true, 'the second call should mark pending rather than run immediately')
  assert.equal(runCount, 1, 'run must not have been invoked a second time yet')

  gate.resolve()
  await Promise.all([first, second])

  assert.equal(runCount, 2, 'the queued call runs exactly once after the first finishes')
  assert.equal(maxConcurrent, 1, 'the two runs must never have been in flight at the same time')
  assert.equal(state.inFlight, false)
  assert.equal(state.pending, false)
})

test('a burst of calls during one run collapses into a single trailing run', async () => {
  const state: ReloadCoalesceState = { inFlight: false, pending: false, nextRun: null }
  let runCount = 0
  const gate = deferred<void>()

  async function run(): Promise<void> {
    runCount += 1
    if (runCount === 1) {
      await gate.promise
    }
  }

  const calls = [coalesceReload(state, run), coalesceReload(state, run), coalesceReload(state, run)]
  assert.equal(runCount, 1, 'only the first call in the burst actually starts a run')

  gate.resolve()
  await Promise.all(calls)

  assert.equal(runCount, 2, 'three overlapping calls collapse to one run plus one trailing run, not three')
})

test('a burst of calls during one run executes the LATEST closure, not the first', async () => {
  // Each call's closure stands in for flow-editor.tsx's per-effect-run reload
  // closure, which captures that run's own `slug` -- re-running the FIRST
  // queued closure after several have arrived would apply a since-superseded
  // caller's state (e.g. a space navigated away from), not what the most
  // recent caller actually wants.
  const state: ReloadCoalesceState = { inFlight: false, pending: false, nextRun: null }
  const gate = deferred<void>()
  const ran: string[] = []

  const first = coalesceReload(state, async () => {
    ran.push('first')
    await gate.promise
  })
  assert.equal(state.inFlight, true)

  const second = coalesceReload(state, async () => {
    ran.push('second')
  })
  const third = coalesceReload(state, async () => {
    ran.push('third')
  })

  gate.resolve()
  await Promise.all([first, second, third])

  assert.deepEqual(ran, ['first', 'third'], 'the trailing run must be the LATEST queued closure, never the middle one')
})

test('calls that do not overlap each run independently', async () => {
  const state: ReloadCoalesceState = { inFlight: false, pending: false, nextRun: null }
  let runCount = 0
  await coalesceReload(state, async () => {
    runCount += 1
  })
  await coalesceReload(state, async () => {
    runCount += 1
  })
  assert.equal(runCount, 2)
})
