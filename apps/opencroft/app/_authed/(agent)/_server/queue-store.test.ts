// This app's half of the durable queue, against a real database.
//
// The engine's half is tested in agent-client with a fake store; what belongs
// here is what only a database can get wrong: that queue ORDER survives a round
// trip when it is not the order things arrived in, that the two kinds of entry
// come back as themselves, that one session's rows are not another's — and
// that the record/forget pair commutes, so a forgotten entry stays forgotten
// whichever of the two writes lands last.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { agentQueueEntry, db } from '@opencroft/db'
import type { QueuedPrompt } from 'agent-client/types'
import { eq } from 'drizzle-orm'

import { dropWaitingEntries, moveQueueEntries, queueStore, sweepRemovedEntries } from './queue-store'

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

// ── the commutative half: a forgotten entry stays forgotten ───────────────

test('a remove that lands before its append still wins', async () => {
  // The engine issues the append first, but this store must not depend on
  // that order surviving all the way to disk: whichever of the two writes
  // lands last, the entry must not come back.
  const key = nextKey()
  const entry = message(key, 'a', 'delivered-before-recorded', '2026-01-01T00:00:00.000Z')
  await queueStore.remove(key, [entry.id])
  await queueStore.append(key, entry, 'end')
  assert.deepEqual(await texts(key), [], 'the late append must not resurrect a forgotten entry')
})

test('appending the same entry twice records it once', async () => {
  const key = nextKey()
  const entry = message(key, 'a', 'once', '2026-01-01T00:00:00.000Z')
  await queueStore.append(key, entry, 'end')
  await queueStore.append(key, entry, 'end')
  assert.deepEqual(await texts(key), ['once'])
})

test('a removed entry is kept as a marked row until the sweep, which only ever takes marked rows', async () => {
  const key = nextKey()
  await queueStore.append(key, message(key, 'a', 'delivered', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(key, message(key, 'b', 'waiting', '2026-01-01T00:01:00.000Z'), 'end')
  await queueStore.remove(key, [entryId(key, 'a')])

  // The forget is a marked row, not an absence — the row is what a late
  // append conflicts with.
  const markedRow = async () => await db.select().from(agentQueueEntry).where(eq(agentQueueEntry.id, entryId(key, 'a')))
  const [marked] = await markedRow()
  assert.ok(marked?.removedAt, 'removing marks the row rather than deleting it')

  // A cutoff in the past leaves a fresh mark in place to keep blocking.
  await sweepRemovedEntries(new Date(Date.now() - 60_000))
  assert.equal((await markedRow()).length, 1)

  // Even the most aggressive cutoff can only take marked rows: the message
  // still waiting has no mark, whatever its age, so it is structurally out of
  // the sweep's reach.
  await sweepRemovedEntries(new Date(Date.now() + 60_000))
  assert.equal((await markedRow()).length, 0)
  assert.deepEqual(await texts(key), ['waiting'])
})

test('marking an entry removed drops its content and leaves the waiting entries whole', async () => {
  // The mark is all a removed row is for. Its text and pictures, kept until
  // the sweep, would hold every delivered message at full size for a day.
  const key = nextKey()
  const picture = { id: 'att-1', name: 'shot.png', mimeType: 'image/png', message: 0 }
  await queueStore.append(key, { ...message(key, 'a', 'delivered', '2026-01-01T00:00:00.000Z'), attachments: [picture] }, 'end')
  await queueStore.append(key, message(key, 'b', 'waiting', '2026-01-01T00:01:00.000Z'), 'end')
  await queueStore.remove(key, [entryId(key, 'a')])

  const [marked] = await db
    .select({ text: agentQueueEntry.text, attachments: agentQueueEntry.attachments, removedAt: agentQueueEntry.removedAt })
    .from(agentQueueEntry)
    .where(eq(agentQueueEntry.id, entryId(key, 'a')))
  assert.ok(marked?.removedAt)
  assert.deepEqual({ text: marked.text, attachments: marked.attachments }, { text: '', attachments: null })
  assert.deepEqual(await texts(key), ['waiting'])
})

test('closing a session to new messages drops the content of what was waiting', async () => {
  const key = nextKey()
  await queueStore.append(key, message(key, 'a', 'never-delivered', '2026-01-01T00:00:00.000Z'), 'end')
  await dropWaitingEntries(key)

  const rows = await db
    .select({ text: agentQueueEntry.text, removedAt: agentQueueEntry.removedAt })
    .from(agentQueueEntry)
    .where(eq(agentQueueEntry.sessionKey, key))
  assert.deepEqual(
    rows.map((row) => ({ text: row.text, marked: row.removedAt !== null })),
    [{ text: '', marked: true }],
  )
})

test('waiting entries that add up past one SELECT load whole and in order', async () => {
  // Two 10 MB entries: more than the embedded database returns from one query.
  const key = nextKey()
  const text = 'w'.repeat(10 * 1024 * 1024)
  await queueStore.append(key, message(key, 'a', `first:${text}`, '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(key, message(key, 'b', `second:${text}`, '2026-01-01T00:01:00.000Z'), 'end')
  const loaded = await queueStore.load(key)
  assert.deepEqual(
    loaded.map((entry) => [entry.id, entry.text.slice(0, entry.text.indexOf(':')), entry.text.length]),
    [
      [entryId(key, 'a'), 'first', text.length + 6],
      [entryId(key, 'b'), 'second', text.length + 7],
    ],
  )
})

test('a rename carries the queue onto the new key instead of stranding it', async () => {
  // A session key is derived from something renameable. Rows left under the old
  // one are unreachable for good — every later call addresses the new key, so
  // nothing can load, mark or clear them — and a message that was genuinely
  // waiting is simply never delivered, with nothing reporting it.
  const from = nextKey()
  const to = nextKey()
  await queueStore.append(from, message(from, 'a', 'still-waiting', '2026-01-01T00:00:00.000Z'), 'end')

  await moveQueueEntries([{ from, to }])

  assert.deepEqual(await texts(to), ['still-waiting'])
  assert.deepEqual(await queueStore.load(from), [], 'nothing may answer under the retired key')
})

test('a rename carries a mark too, so a delivered entry stays delivered across it', async () => {
  // The move must not resurrect anything: a row whose entry was already
  // forgotten arrives under the new key still forgotten, rather than becoming a
  // message the next open would deliver a second time.
  const from = nextKey()
  const to = nextKey()
  await queueStore.append(from, message(from, 'a', 'already-delivered', '2026-01-01T00:00:00.000Z'), 'end')
  await queueStore.append(from, message(from, 'b', 'still-waiting', '2026-01-01T00:01:00.000Z'), 'end')
  await queueStore.remove(from, [entryId(from, 'a')])

  await moveQueueEntries([{ from, to }])

  assert.deepEqual(await texts(to), ['still-waiting'])
})

test('a queued entry keeps what it carries beside its text', async () => {
  // A picture must survive the wait exactly as the words do: a restart while a
  // cadence holds the message is the case this table exists for.
  const key = nextKey()
  const picture = { id: 'att-1', name: 'shot.png', mimeType: 'image/png', message: 0 }
  await queueStore.append(key, { ...message(key, 'a', '', '2026-01-01T00:00:00.000Z'), attachments: [picture] }, 'end')
  await queueStore.append(key, message(key, 'b', 'plain', '2026-01-01T00:01:00.000Z'), 'end')
  const [withPicture, plain] = await queueStore.load(key)
  assert.deepEqual(withPicture.attachments, [picture])
  assert.equal('attachments' in plain, false, 'an entry that carried nothing comes back carrying nothing')
})
