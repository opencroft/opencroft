// Exercises the real database (embedded PGlite by default) -- see
// @opencroft/db's test-env for how this stays off the shared dev/production
// database regardless of the ambient environment.
//
// host.storage.set/delete/clear are a read-modify-write over ONE settings row
// shared by every extension. Two calls that interleave used to both read the
// same snapshot, and whichever wrote second silently discarded the first's
// key -- reproduced before this fix landed.
// These tests prove the in-process mutex + version-CAS retry closes it.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { createHost } from './host'

test('two concurrent set() calls on distinct keys both survive', async () => {
  const host = createHost(`storage-race-${crypto.randomUUID()}`)

  await Promise.all([host.storage.set('race-a', 'a'), host.storage.set('race-b', 'b')])

  assert.equal(await host.storage.get('race-a'), 'a')
  assert.equal(await host.storage.get('race-b'), 'b')
})

test('many concurrent set() calls on distinct keys all survive', async () => {
  const host = createHost(`storage-race-many-${crypto.randomUUID()}`)
  const count = 20

  await Promise.all(Array.from({ length: count }, (_, i) => host.storage.set(`key-${i}`, i)))

  const values = await Promise.all(Array.from({ length: count }, (_, i) => host.storage.get(`key-${i}`)))
  assert.deepEqual(
    values,
    Array.from({ length: count }, (_, i) => i),
  )
})

test('concurrent writers on DIFFERENT extensions do not clobber each other', async () => {
  // The shared row is keyed by extensionId prefix inside its JSON blob, so a
  // race between two different extensions' writers has to be just as safe as
  // a race within one extension's own calls.
  const hostA = createHost(`storage-race-cross-a-${crypto.randomUUID()}`)
  const hostB = createHost(`storage-race-cross-b-${crypto.randomUUID()}`)

  await Promise.all([hostA.storage.set('key', 'from-a'), hostB.storage.set('key', 'from-b')])

  assert.equal(await hostA.storage.get('key'), 'from-a')
  assert.equal(await hostB.storage.get('key'), 'from-b')
})

test('concurrent set() and delete() on different keys both take effect', async () => {
  const host = createHost(`storage-race-set-delete-${crypto.randomUUID()}`)
  await host.storage.set('keep', 'kept')
  await host.storage.set('doomed', 'gone-soon')

  await Promise.all([host.storage.set('new', 'value'), host.storage.delete('doomed')])

  assert.equal(await host.storage.get('keep'), 'kept')
  assert.equal(await host.storage.get('new'), 'value')
  assert.equal(await host.storage.get('doomed'), null)
})
