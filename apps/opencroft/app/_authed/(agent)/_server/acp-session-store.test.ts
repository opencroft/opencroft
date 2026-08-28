// Exercises the real database (embedded PGlite by default) -- see
// @opencroft/db's test-env for how this stays off the shared dev/production
// database regardless of the ambient environment.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  copyTabKeys,
  dropTabKeys,
  readLastKnownUsage,
  readPersistedConfigOptions,
  readPersistedPresence,
  readPersistedSession,
  writePersistedConfigOption,
  writePersistedPresence,
  writePersistedSession,
  writePersistedUsage,
} from './acp-session-store'

test('readLastKnownUsage resolves through the durable pointer to the usage its session left behind', async () => {
  const sessionKey = `offline-usage-${crypto.randomUUID()}`
  const sessionId = `session-${crypto.randomUUID()}`
  await writePersistedSession(sessionKey, sessionId, true)
  await writePersistedUsage(sessionId, { used: 12_345, size: 200_000 })

  const usage = await readLastKnownUsage(sessionKey)
  assert.ok(usage, 'a session key with a pointer and a persisted reading must resolve one')
  assert.equal(usage.used, 12_345)
  assert.equal(usage.size, 200_000)
  assert.equal(typeof usage.at, 'number', 'the freshness marker is the wall-clock time it was written')
})

test('readLastKnownUsage is null for a key with no durable pointer at all', async () => {
  const usage = await readLastKnownUsage(`never-seen-${crypto.randomUUID()}`)
  assert.equal(usage, null)
})

test("readLastKnownUsage is null when the pointer's session never reported usage", async () => {
  const sessionKey = `offline-no-usage-${crypto.randomUUID()}`
  await writePersistedSession(sessionKey, `session-${crypto.randomUUID()}`, true)

  const usage = await readLastKnownUsage(sessionKey)
  assert.equal(usage, null, 'a pointer with nothing persisted under its session id is exactly as unknown as no pointer')
})

// MOVING A TAB KEY. `copyTabKeys` runs TWICE -- once before the rename that
// makes the destination the live address, once after, so a write that landed
// under the old key in between is not lost. That second pass is why neither row
// can take the incoming value wholesale: by then the destination may hold the
// fresher reading of the two.

test('copyTabKeys carries the pointer and the options onto the new key, leaving the old one alone', async () => {
  const from = `move-src-${crypto.randomUUID()}`
  const to = `move-dst-${crypto.randomUUID()}`
  const sessionId = `session-${crypto.randomUUID()}`
  await writePersistedSession(from, sessionId, true)
  await writePersistedConfigOption(from, 'thought_level', 'high')

  await copyTabKeys([{ from, to }])

  assert.equal((await readPersistedSession(to))?.id, sessionId)
  assert.deepEqual(await readPersistedConfigOptions(to), { thought_level: 'high' })
  assert.equal((await readPersistedSession(from))?.id, sessionId, 'the old key still resolves until it is dropped')

  await dropTabKeys([{ from, to }])
  assert.equal(await readPersistedSession(from), null)
  assert.deepEqual(await readPersistedConfigOptions(from), {})
  assert.equal((await readPersistedSession(to))?.id, sessionId, 'dropping the old key must not disturb the new one')
})

test('copyTabKeys carries the reading cadence, which decides whether messages wait at all', async () => {
  // A cadence left behind does not merely go missing: nothing is found under the
  // new key, so the engine keeps its own default of realtime, and a session its
  // reader had set to hourly hands over everything it was holding at once. The
  // reader is never told, because a reverted setting and a setting nobody chose
  // look identical.
  const from = `presence-src-${crypto.randomUUID()}`
  const to = `presence-dst-${crypto.randomUUID()}`
  await writePersistedPresence(from, { kind: 'hourly' })

  await copyTabKeys([{ from, to }])
  assert.deepEqual(await readPersistedPresence(to), { kind: 'hourly' })
  assert.deepEqual(await readPersistedPresence(from), { kind: 'hourly' }, 'the old key holds until it is dropped')

  await dropTabKeys([{ from, to }])
  assert.equal(await readPersistedPresence(from), null)
  assert.deepEqual(await readPersistedPresence(to), { kind: 'hourly' }, 'dropping must not disturb the new key')
})

test('a cadence set under the destination mid-rename survives the second copy', async () => {
  // Same rule the pointer and the options get, for the same reason: after the
  // rename commits the destination is the live address, so a reader who changes
  // the cadence in that window has made the current choice.
  const from = `presence-merge-src-${crypto.randomUUID()}`
  const to = `presence-merge-dst-${crypto.randomUUID()}`
  await writePersistedPresence(from, { kind: 'hourly' })
  await copyTabKeys([{ from, to }])

  await writePersistedPresence(to, { kind: 'realtime' })
  await copyTabKeys([{ from, to }])

  assert.deepEqual(
    await readPersistedPresence(to),
    { kind: 'realtime' },
    'the second pass must not put the pre-rename cadence back over the reader’s newer choice',
  )
})

test('a second copy never undoes what landed under the destination in between', async () => {
  const from = `merge-src-${crypto.randomUUID()}`
  const to = `merge-dst-${crypto.randomUUID()}`
  const sessionId = `session-${crypto.randomUUID()}`
  // The state at staging time: never prompted, one option set.
  await writePersistedSession(from, sessionId, false)
  await writePersistedConfigOption(from, 'thought_level', 'low')
  await copyTabKeys([{ from, to }])

  // Past the commit the destination is the live address, so these are what a
  // real first message and a reader's own change look like landing on it.
  await writePersistedSession(to, sessionId, true)
  await writePersistedConfigOption(to, 'thought_level', 'high')

  // The re-copy before the old key is retired.
  await copyTabKeys([{ from, to }])

  assert.equal(
    (await readPersistedSession(to))?.prompted,
    true,
    'prompted only ever moves false -> true; reverting it re-injects opening context the agent already has',
  )
  assert.deepEqual(
    await readPersistedConfigOptions(to),
    { thought_level: 'high' },
    "the destination is live, so a reader's setting there wins over the value staged before the rename",
  )
})

test('an option held only by the old key is still carried across by the second copy', async () => {
  const from = `merge-fill-src-${crypto.randomUUID()}`
  const to = `merge-fill-dst-${crypto.randomUUID()}`
  await writePersistedConfigOption(from, 'thought_level', 'low')
  await copyTabKeys([{ from, to }])
  await writePersistedConfigOption(from, 'model', 'something-else')

  await copyTabKeys([{ from, to }])

  assert.deepEqual(await readPersistedConfigOptions(to), { thought_level: 'low', model: 'something-else' })
})
