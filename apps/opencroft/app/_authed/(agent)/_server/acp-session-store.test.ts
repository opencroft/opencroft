// Exercises the real database (embedded PGlite by default) -- see
// @opencroft/db's test-env for how this stays off the shared dev/production
// database regardless of the ambient environment.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { readLastKnownUsage, writePersistedSession, writePersistedUsage } from './acp-session-store'

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
