import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtensionUpdate } from 'ui/extensions/extension-updates'

import type { UpdateOutcome } from './update-overview'
import { type RunSteps, runUpdates, takeOne, type UpdateResult } from './update-run'

function item(id: string): ExtensionUpdate {
  return { id, name: id, from: 'v1.0.0', to: 'v1.1.0', state: 'available' }
}

const updated: UpdateResult = { ok: true, changed: true, message: 'Updated to v1.1.0' }

// The steps a run is given, recording what it put on screen and what it was asked to do.
function harness(overrides: Partial<RunSteps> = {}) {
  const rows = new Map<string, UpdateOutcome>()
  const taken: string[] = []
  let progress: { done: number; total: number } | undefined
  const steps: RunSteps = {
    take: async (folder) => {
      taken.push(folder)
      return updated
    },
    reread: async () => {},
    record: (folder, outcome) => {
      if (outcome) {
        rows.set(folder, outcome)
      } else {
        rows.delete(folder)
      }
    },
    progress: (next) => {
      progress = next
    },
    ...overrides,
  }
  return { steps, rows, taken, progress: () => progress }
}

test('a run whose read-back fails on one update still takes the next, and leaves no row waiting', async () => {
  const run = harness({
    reread: async (folder) => {
      if (folder === 'a') {
        throw new Error('server function unreachable')
      }
    },
  })
  const tally = await runUpdates([item('a'), item('b')], run.steps)

  assert.deepEqual(run.taken, ['a', 'b'])
  assert.deepEqual(tally, { updated: 2, current: 0, failed: 0 })
  assert.equal(run.rows.get('a')?.state, 'updated')
  assert.match(
    run.rows.get('a')?.message ?? '',
    /Updated to v1\.1\.0\. Reading it back failed.*server function unreachable/,
  )
  assert.equal(run.rows.get('b')?.state, 'updated')
  assert.equal(
    [...run.rows.values()].some((row) => row.state === 'queued' || row.state === 'updating'),
    false,
  )
  assert.equal(run.progress(), undefined)
})

test('an update that throws is a failed row, and the run goes on', async () => {
  const run = harness({
    take: async (folder) => {
      run.taken.push(folder)
      if (folder === 'a') {
        throw new Error('install failed')
      }
      return folder === 'b' ? updated : { ok: true, changed: false, message: 'Already up to date' }
    },
  })
  const tally = await runUpdates([item('a'), item('b'), item('c')], run.steps)

  assert.deepEqual(run.taken, ['a', 'b', 'c'])
  assert.deepEqual(tally, { updated: 1, current: 1, failed: 1 })
  assert.deepEqual(run.rows.get('a'), { state: 'failed', message: 'install failed', from: 'v1.0.0', to: 'v1.1.0' })
})

test('progress counts an update as done once its outcome is on its row, before its read-back', async () => {
  const seen: Array<[string, string | undefined, { done: number; total: number } | undefined]> = []
  const run = harness({
    reread: async (folder) => {
      seen.push([folder, run.rows.get(folder)?.state, run.progress()])
    },
    take: async (folder) => {
      run.taken.push(folder)
      return folder === 'b' ? { ok: false, changed: false, message: 'did not build' } : updated
    },
  })
  await runUpdates([item('a'), item('b')], run.steps)

  assert.deepEqual(seen, [
    ['a', 'updated', { done: 1, total: 2 }],
    ['b', 'failed', { done: 2, total: 2 }],
  ])
  assert.equal(run.progress(), undefined)
})

test('a run a step throws out of puts the rows it never reached back as they were', async () => {
  const run = harness()
  const progress = run.steps.progress
  run.steps.progress = (next) => {
    if (next?.done === 1) {
      throw new Error('render failed')
    }
    progress(next)
  }
  await assert.rejects(runUpdates([item('a'), item('b'), item('c')], run.steps), /render failed/)

  assert.deepEqual(run.taken, ['a'])
  assert.deepEqual(
    [...run.rows.entries()].map(([id, row]) => [id, row.state]),
    [['a', 'updated']],
  )
  assert.equal(run.progress(), undefined)
})

test('one update whose read-back fails resolves with what the update did', async () => {
  const run = harness({
    reread: async () => {
      throw new Error('gone')
    },
  })
  const result = await takeOne('a', null, run.steps)

  assert.equal(result.ok, true)
  assert.match(result.message, /^Updated to v1\.1\.0\. Reading it back failed.*gone$/)
  assert.equal(run.rows.size, 0)
})
