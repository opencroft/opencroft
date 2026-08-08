// Exercises the real database (embedded PGlite by default) -- see
// @opencroft/db's test-env for how this stays off the shared dev/production
// database regardless of the ambient environment.
//
// writePersistedSession/writePersistedConfigOption are each a read-modify-write
// over ONE settings row shared by every chat tab. Two calls for DIFFERENT tab
// keys that interleave used to both read the same snapshot, and whichever
// wrote second silently discarded the first's pointer -- the same lost-update
// shape already closed for extension storage, generalised here to the
// session store since an earlier change made it load-bearing from session
// creation, not just first prompt.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  deletePersistedSession,
  readPersistedConfigOptions,
  readPersistedSession,
  writePersistedConfigOption,
  writePersistedSession,
} from './acp-session-store'

test('two concurrent writePersistedSession() calls for different tab keys both survive', async () => {
  const a = `tab-a-${crypto.randomUUID()}`
  const b = `tab-b-${crypto.randomUUID()}`

  await Promise.all([writePersistedSession(a, 'session-a', false), writePersistedSession(b, 'session-b', false)])

  assert.deepEqual(await readPersistedSession(a), { id: 'session-a', prompted: false })
  assert.deepEqual(await readPersistedSession(b), { id: 'session-b', prompted: false })
})

test('many concurrent writePersistedSession() calls for distinct tab keys all survive', async () => {
  const count = 20
  const tabKeys = Array.from({ length: count }, () => `tab-${crypto.randomUUID()}`)

  await Promise.all(tabKeys.map((tabKey, i) => writePersistedSession(tabKey, `session-${i}`, false)))

  const results = await Promise.all(tabKeys.map((tabKey) => readPersistedSession(tabKey)))
  assert.deepEqual(
    results,
    tabKeys.map((_, i) => ({ id: `session-${i}`, prompted: false })),
  )
})

test('concurrent writePersistedSession() and deletePersistedSession() on different keys both take effect', async () => {
  const keep = `tab-keep-${crypto.randomUUID()}`
  const doomed = `tab-doomed-${crypto.randomUUID()}`
  const fresh = `tab-fresh-${crypto.randomUUID()}`
  await writePersistedSession(keep, 'session-keep', true)
  await writePersistedSession(doomed, 'session-doomed', true)

  await Promise.all([writePersistedSession(fresh, 'session-fresh', false), deletePersistedSession(doomed)])

  assert.deepEqual(await readPersistedSession(keep), { id: 'session-keep', prompted: true })
  assert.deepEqual(await readPersistedSession(fresh), { id: 'session-fresh', prompted: false })
  assert.equal(await readPersistedSession(doomed), null)
})

test('concurrent writePersistedConfigOption() calls for different tab keys both survive', async () => {
  // Same shared-row hazard, the second settings row this module owns.
  const a = `tab-cfg-a-${crypto.randomUUID()}`
  const b = `tab-cfg-b-${crypto.randomUUID()}`

  await Promise.all([
    writePersistedConfigOption(a, 'reasoning-effort', 'high'),
    writePersistedConfigOption(b, 'reasoning-effort', 'low'),
  ])

  assert.deepEqual(await readPersistedConfigOptions(a), { 'reasoning-effort': 'high' })
  assert.deepEqual(await readPersistedConfigOptions(b), { 'reasoning-effort': 'low' })
})
