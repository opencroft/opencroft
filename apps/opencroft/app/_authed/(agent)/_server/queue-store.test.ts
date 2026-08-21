// This app's half of the durable queue, against a real database.
//
// The engine's half is tested in agent-client with a fake store; what belongs
// here is what only a database can get wrong: that queue ORDER survives a round
// trip when it is not the order things arrived in, that the two kinds of entry
// come back as themselves, and that one session's rows are not another's.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import type { QueuedPrompt } from 'agent-client/types'

import { queueStore } from './queue-store'

// A fresh key per test: these all run against one database and must not see
// each other's rows. Entry ids are namespaced by it for the same reason — `id`
// is the primary key across every session, not within one.
let counter = 0
function nextKey(): string {
  counter += 1
  return `agent:test:queue-store-${counter}`
}
const entryId = (key: string, name: string) => `${key}#${name}`

function message(key: string, name: string, text: string, sentAt: string): QueuedPrompt {
  return { id: entryId(key, name), kind: 'message', sender: 'Reader', sentAt, text }
}

function command(key: string, name: string, text: string): QueuedPrompt {
  return { id: entryId(key, name), kind: 'system', text }
}

const texts = async (key: string) => (await queueStore.load(key)).map((entry) => entry.text)

test('an appended queue comes back in the order it was queued', async () => {
  const key = nextKey()
  await queueStore.append(key, message(key, 'a', 'first', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(key, message(key, 'b', 'second', '2026-01-01T00:01:00.000Z'), 'end')
  assert.deepEqual(await texts(key), ['first', 'second'])
})

test('a front-inserted message comes back FIRST, not in arrival order', async () => {
  // Corrective guidance after a rejected permission jumps the line. Restoring
  // it in arrival order would deliver it after the thing it was correcting,
  // which is the one thing `front` exists to prevent.
  const key = nextKey()
  await queueStore.append(key, message(key, 'a', 'ordinary', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(key, message(key, 'b', 'corrective', '2026-01-01T00:01:00.000Z'), 'front')
  assert.deepEqual(await texts(key), ['corrective', 'ordinary'])
})

test('repeated front-inserts stack in front of each other, newest first', async () => {
  const key = nextKey()
  await queueStore.append(key, message(key, 'a', 'ordinary', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(key, message(key, 'b', 'first-correction', '2026-01-01T00:01:00.000Z'), 'front')
  await queueStore.append(key, message(key, 'c', 'second-correction', '2026-01-01T00:02:00.000Z'), 'front')
  assert.deepEqual(await texts(key), ['second-correction', 'first-correction', 'ordinary'])
})

test('order is not inferred from send times, which a command does not have', async () => {
  const key = nextKey()
  await queueStore.append(key, message(key, 'a', 'before', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(key, command(key, 'b', '/compact'), 'end')
  await queueStore.append(key, message(key, 'c', 'after', '2026-01-01T00:02:00.000Z'), 'end')
  assert.deepEqual(
    await texts(key),
    ['before', '/compact', 'after'],
    'the command stays between the two messages it was sent between',
  )
})

test('both kinds come back as themselves', async () => {
  // The kind decides how an entry leaves: messages batch and carry a tag, a
  // command is delivered alone and bare. Restoring one as the other would put a
  // tag in front of a slash command and stop it being one.
  const key = nextKey()
  await queueStore.append(key, message(key, 'a', 'hello', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(key, command(key, 'b', '/compact'), 'end')
  assert.deepEqual(await queueStore.load(key), [
    { id: entryId(key, 'a'), kind: 'message', sender: 'Reader', sentAt: '2026-01-01T00:00:00.000Z', text: 'hello' },
    { id: entryId(key, 'b'), kind: 'system', text: '/compact' },
  ])
})

test('a send time survives the round trip exactly, because the wait is measured from it', async () => {
  const key = nextKey()
  const sentAt = '2026-01-01T12:34:56.789Z'
  await queueStore.append(key, message(key, 'a', 'patient', sentAt), 'end')
  const [restored] = await queueStore.load(key)
  assert.equal(restored.kind === 'message' && restored.sentAt, sentAt)
})

test('removing takes only what was delivered', async () => {
  const key = nextKey()
  await queueStore.append(key, message(key, 'a', 'delivered', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(key, message(key, 'b', 'still-held', '2026-01-01T00:01:00.000Z'), 'end')
  await queueStore.remove(key, [entryId(key, 'a')])
  assert.deepEqual(await texts(key), ['still-held'])
})

test('removing nothing is not removing everything', async () => {
  // An empty id list reaching a DELETE without a guard would clear the session.
  const key = nextKey()
  await queueStore.append(key, message(key, 'a', 'held', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.remove(key, [])
  assert.deepEqual(await texts(key), ['held'])
})

test('clearing one session leaves every other session alone', async () => {
  const mine = nextKey()
  const theirs = nextKey()
  await queueStore.append(mine, message(mine, 'a', 'mine', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(theirs, message(theirs, 'a', 'theirs', '2026-01-01T00:00:00.000Z'), 'end')

  await queueStore.clear(theirs)
  assert.deepEqual(await texts(theirs), [])
  assert.deepEqual(await texts(mine), ['mine'])
})

test('positions are per session, so one queue cannot reorder another', async () => {
  // Both `max+1` and `min-1` are computed within a session key. Computed
  // globally, a busy session would push every other session's next append past
  // its own front-inserted corrections.
  const first = nextKey()
  const second = nextKey()
  await queueStore.append(first, message(first, 'a', 'f1', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(first, message(first, 'b', 'f2', '2026-01-01T00:01:00.000Z'), 'end')
  await queueStore.append(second, message(second, 'a', 's1', '2026-01-01T00:02:00.000Z'), 'end')
  await queueStore.append(second, message(second, 'b', 's2', '2026-01-01T00:03:00.000Z'), 'front')
  assert.deepEqual(await texts(first), ['f1', 'f2'])
  assert.deepEqual(await texts(second), ['s2', 's1'])
})

test('a key that was never used loads as an empty queue, not as an error', async () => {
  assert.deepEqual(await queueStore.load(nextKey()), [])
})
