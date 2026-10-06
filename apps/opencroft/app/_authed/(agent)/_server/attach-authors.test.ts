// What happens to a message when the thing that would name its senders is
// unavailable.
//
// The claim under test is not "resolution works" -- that is the directory's own
// suite. It is that a message SURVIVES a resolution that does not, on every
// path, identically. Against a real database, because the failure being
// simulated is a database one and the resolver is the real one.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test, { beforeEach } from 'node:test'

import { buildDelivery } from 'agent-client/queue-tags'
import type { ChatEvent } from 'agent-client/types'

process.env.DB_MIGRATIONS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
)
delete process.env.DATABASE_URL
process.env.NODE_ENV = 'development'

const { db, user, username: usernames } = await import('@opencroft/db')
const { sql } = await import('drizzle-orm')
const store = await import('@/app/_server/usernames')
const { withAuthors } = await import('./attach-authors')

beforeEach(async () => {
  await db.delete(usernames)
  await db.delete(user)
})

const SENT_AT = '2026-03-04T09:12:00.000Z'

function delivered(sender: string, text: string): Extract<ChatEvent, { kind: 'user' }> {
  return { kind: 'user', text: buildDelivery({ kind: 'messages', messages: [{ sender, sentAt: SENT_AT, text }] }) }
}

test('a delivered turn carries the accounts its senders resolve to', async () => {
  await db.insert(user).values({ id: 'p1', name: 'Ada L', email: 'p1@example.test', emailVerified: false })
  await store.changeUsername({ kind: 'user', id: 'p1' }, 'ada')

  const event = await withAuthors(delivered('ada', 'check the build'))

  assert.deepEqual(event.authors, { ada: { name: 'Ada L', avatarUrl: null } })
})

test('a turn whose senders resolve to nothing carries no authors field at all', async () => {
  // Not an empty object: on the wire it must look exactly as it did before
  // this field existed, which is what keeps every old turn rendering.
  const event = await withAuthors(delivered('Ada L', 'check the build'))

  assert.ok(!('authors' in event), 'absent, not present and empty')
})

test('a resolution that fails sends the turn unauthored rather than losing it', async (t) => {
  // THE FINDING THIS TEST EXISTS FOR. Resolution reads the database and walks
  // the space graph; either can fail for reasons unrelated to this turn. If
  // that rejected, the frame would be dropped and a reader would simply be
  // missing a message, with nothing anywhere saying so.
  await db.insert(user).values({ id: 'p2', name: 'Ada L', email: 'p2@example.test', emailVerified: false })
  await store.changeUsername({ kind: 'user', id: 'p2' }, 'ada')

  // The real failure: the table the directory reads is gone underneath it.
  // A rename rather than a stub, so what rejects is the driver on a real query
  // -- a mocked resolver would only prove the catch catches what I threw at it.
  await db.execute(sql`alter table "Username" rename to "Username__hidden"`)
  t.after(async () => {
    await db.execute(sql`alter table "Username__hidden" rename to "Username"`)
  })

  const original = delivered('ada', 'check the build')
  const event = await withAuthors(original)

  assert.equal(event.kind === 'user' ? event.text : undefined, original.text, 'the message is intact')
  assert.ok(!('authors' in event), 'and degrades to the state a handle nobody holds already lands in')
})

test('a kind that carries no senders is returned untouched without asking the directory', async () => {
  const event: ChatEvent = { kind: 'agent_message', text: 'on it' }

  assert.equal(await withAuthors(event), event, 'the same object, not a copy')
})
