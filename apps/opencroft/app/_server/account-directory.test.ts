// What a stamped handle shows a reader, against a real database, because the
// whole claim is about rows: that a rename reaches messages already written,
// and that a handle nobody holds resolves to nothing rather than to somebody.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test, { beforeEach } from 'node:test'

process.env.OPENCROFT_DB_MIGRATIONS_DIR = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
)
delete process.env.OPENCROFT_DATABASE_URL

const { db, space, user, username: usernames } = await import('@opencroft/db')
const { eq } = await import('drizzle-orm')
const store = await import('./usernames')
const { authorsByIdentifier, mentionableAccounts } = await import('./account-directory')

// One real agent node, seeded before anything reads the space registry.
await db.insert(space).values({
  slug: 'directory-space',
  name: 'Directory Space',
  data: JSON.stringify({
    nodes: [{ id: 'agent-m', type: 'builtin.core.agent', data: { name: 'Agent M' } }],
    edges: [],
  }),
})

beforeEach(async () => {
  await db.delete(usernames)
  await db.delete(user)
})

async function person(id: string, name: string, image?: string): Promise<void> {
  await db.insert(user).values({ id, name, email: `${id}@example.test`, emailVerified: false, image })
}

test('a handle resolves to the account holding it, with the face a reader sees', async () => {
  await person('person-1', 'Ada L', '/ada.png')
  await store.changeUsername({ kind: 'user', id: 'person-1' }, 'ada')

  assert.deepEqual(await authorsByIdentifier(['ada']), { ada: { name: 'Ada L', avatarUrl: '/ada.png' } })
})

test('an account with no picture resolves to a name and no picture, not to nothing', async () => {
  // The header draws a name without an avatar differently from an author it
  // could not resolve at all, so these two states must not collapse.
  await person('person-2', 'Bo')
  await store.changeUsername({ kind: 'user', id: 'person-2' }, 'bo')

  assert.deepEqual(await authorsByIdentifier(['bo']), { bo: { name: 'Bo', avatarUrl: null } })
})

test('a rename reaches messages already written, because the name is resolved and not stored', async () => {
  // The entire reason the handle is what gets stamped. A message sent when
  // this account was displayed as "Bo" shows its current name afterwards.
  await person('person-3', 'Bo')
  await store.changeUsername({ kind: 'user', id: 'person-3' }, 'bo')
  const before = await authorsByIdentifier(['bo'])
  assert.equal(before.bo?.name, 'Bo')

  await db.update(user).set({ name: 'Bo the Second' }).where(eq(user.id, 'person-3'))

  assert.equal((await authorsByIdentifier(['bo'])).bo?.name, 'Bo the Second')
})

test('a retired handle still resolves, and to the account that always held it', async () => {
  // A transcript keeps the handle it was stamped with. If retiring one made it
  // resolve to nothing, every message written before a rename would lose its
  // face at the moment its sender changed handle.
  await person('person-4', 'Ada L')
  await store.changeUsername({ kind: 'user', id: 'person-4' }, 'ada')
  await store.changeUsername({ kind: 'user', id: 'person-4' }, 'ada.l')

  const authors = await authorsByIdentifier(['ada', 'ada.l'])

  assert.deepEqual(authors.ada, { name: 'Ada L', avatarUrl: null }, 'the old stamp still lands on the same person')
  assert.deepEqual(authors['ada.l'], { name: 'Ada L', avatarUrl: null })
})

test('a handle no account has ever held is absent, not a placeholder', async () => {
  // Where every message stamped with a display name, before handles existed,
  // ends up. Absent is a state the header draws; a placeholder would be a
  // picture of somebody who did not send it.
  await person('person-5', 'Ada L')
  await store.changeUsername({ kind: 'user', id: 'person-5' }, 'ada')

  const authors = await authorsByIdentifier(['Ada L', 'nobody'])

  assert.deepEqual(authors, {})
})

test('a handle whose account has been deleted resolves to nothing rather than throwing', async () => {
  // The row pointing at a person outlives that person here only because the
  // handle table is cleared separately; the shape of the failure is what
  // matters -- one dangling reference must not take a whole transcript down.
  await person('person-6', 'Ada L')
  await store.changeUsername({ kind: 'user', id: 'person-6' }, 'ada')
  await db.delete(user).where(eq(user.id, 'person-6'))

  assert.deepEqual(await authorsByIdentifier(['ada']), {})
})

test('several handles are answered in one pass, resolved and unresolved together', async () => {
  await person('person-7', 'Ada L')
  await person('person-8', 'Bo')
  await store.changeUsername({ kind: 'user', id: 'person-7' }, 'ada')
  await store.changeUsername({ kind: 'user', id: 'person-8' }, 'bo')

  const authors = await authorsByIdentifier(['ada', 'Alice', 'bo', 'ada'])

  assert.deepEqual(Object.keys(authors).sort(), ['ada', 'bo'])
})

test('asking about nothing reads nothing', async () => {
  assert.deepEqual(await authorsByIdentifier([]), {})
})

test('everyone a mention can name is listed by the handle they go by now, in name order', async () => {
  await person('person-9', 'Zed', '/zed.png')
  await store.changeUsername({ kind: 'user', id: 'person-9' }, 'zed')
  await store.changeUsername({ kind: 'user', id: 'person-9' }, 'zed.z')
  // Has no handle yet, and is given one from the name.
  await person('person-10', 'Bea')
  // An agent node that is gone, with its handle still on record: a mention could not name it.
  await store.changeUsername({ kind: 'agent', id: 'agent-gone' }, 'agent.gone')

  const listed = await mentionableAccounts()

  assert.deepEqual(
    listed.map(({ handle, name }) => [handle, name]),
    [
      ['agent.agent.m', 'Agent M'],
      ['bea', 'Bea'],
      ['zed.z', 'Zed'],
    ],
  )
  assert.equal(listed[2].avatarUrl, '/zed.png')
  assert.equal(await store.currentUsername({ kind: 'user', id: 'person-10' }), 'bea', 'the given handle is kept')
  assert.equal(
    await store.currentUsername({ kind: 'agent', id: 'agent-m' }),
    'agent.agent.m',
    'an agent is given one from its directory name',
  )
})
