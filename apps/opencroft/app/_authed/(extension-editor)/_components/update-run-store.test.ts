import assert from 'node:assert/strict'
import test from 'node:test'

import type { ExtensionUpdate } from 'ui/extensions/extension-updates'

import { runUpdates, type UpdateResult } from './update-run'
import { UpdateRunStore } from './update-run-store'

function item(id: string): ExtensionUpdate {
  return { id, name: id, from: 'v1.0.0', to: 'v1.1.0', state: 'available' }
}

const updated: UpdateResult = { ok: true, changed: true, message: 'Updated to v1.1.0' }

// A page as the store sees it: mounting attaches its read-back and runs its
// first check, which clears the outcomes; unmounting detaches it.
function mountPage(runs: UpdateRunStore) {
  const reread: string[] = []
  const detach = runs.attachReader(async (folder) => {
    reread.push(folder)
  })
  runs.clearOutcomes()
  return { reread, unmount: detach }
}

test('a batch whose first update remounts the page takes every update, and the new page shows and re-reads them', async () => {
  const runs = new UpdateRunStore()
  const first = mountPage(runs)
  let second: ReturnType<typeof mountPage> | undefined
  const taken: string[] = []
  const queuedWhenTaken: Record<string, string[]> = {}

  const tally = await runUpdates([item('a'), item('b'), item('c')], {
    take: async (folder) => {
      taken.push(folder)
      queuedWhenTaken[folder] = Object.entries(runs.getSnapshot().outcomes)
        .filter(([, outcome]) => outcome.state === 'queued')
        .map(([id]) => id)
      if (folder === 'a') {
        first.unmount()
        second = mountPage(runs)
      }
      return updated
    },
    reread: runs.reread,
    record: runs.record,
    progress: runs.progress,
  })

  assert.deepEqual(taken, ['a', 'b', 'c'])
  assert.deepEqual(tally, { updated: 3, current: 0, failed: 0 })
  // The remounted page's first check did not clear the run's waiting rows.
  assert.deepEqual(queuedWhenTaken, { a: ['b', 'c'], b: ['c'], c: [] })
  assert.deepEqual(
    Object.fromEntries(Object.entries(runs.getSnapshot().outcomes).map(([id, outcome]) => [id, outcome.state])),
    { a: 'updated', b: 'updated', c: 'updated' },
  )
  assert.equal(runs.getSnapshot().progress, undefined)
  assert.deepEqual(first.reread, [])
  assert.deepEqual(second?.reread, ['a', 'b', 'c'])
})

test('an update finished with no page mounted is still recorded, and nothing is read back', async () => {
  const runs = new UpdateRunStore()
  const page = mountPage(runs)
  page.unmount()
  await runUpdates([item('a')], {
    take: async () => updated,
    reread: runs.reread,
    record: runs.record,
    progress: runs.progress,
  })

  assert.equal(runs.getSnapshot().outcomes.a?.state, 'updated')
  assert.deepEqual(page.reread, [])
})

test('clearing the outcomes clears finished ones, and leaves everything while an update is under way', () => {
  const runs = new UpdateRunStore()
  runs.record('a', { state: 'updated', message: 'Updated to v1.1.0', from: 'v1.0.0', to: 'v1.1.0' })
  runs.record('b', { state: 'updating', from: 'v1.0.0', to: 'v1.1.0' })
  runs.clearOutcomes()
  assert.deepEqual(Object.keys(runs.getSnapshot().outcomes), ['a', 'b'])

  runs.record('b', { state: 'failed', message: 'did not build', from: 'v1.0.0', to: 'v1.1.0' })
  runs.clearOutcomes()
  assert.deepEqual(runs.getSnapshot().outcomes, {})
})

test('a page that unmounts after another has mounted does not detach the newer one', async () => {
  const runs = new UpdateRunStore()
  const older = mountPage(runs)
  const newer = mountPage(runs)
  older.unmount()
  await runs.reread('a')

  assert.deepEqual(newer.reread, ['a'])
  assert.deepEqual(older.reread, [])
})
