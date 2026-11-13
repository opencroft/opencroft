// A person's Recent, kept in their account, against a real database and real
// Better Auth sessions -- same setup as read-model.test.ts: what is under test
// is whose row a request reaches and which threads it may hold, which a mock
// would assume rather than show.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { and, eq } from 'drizzle-orm'

process.env.OPENCROFT_DB_MIGRATIONS_DIR = join(
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
delete process.env.OPENCROFT_DATABASE_URL

const { db, groupChatMember, groupChatThread, space } = await import('@opencroft/db')
const model = await import('./model')
const recent = await import('./recent-store')
const { ensureAuth } = await import('@opencroft/auth/server')

await db.insert(space).values({
  slug: 'recent-space',
  name: 'Recent Space',
  data: JSON.stringify({
    nodes: [{ id: 'agent-r', type: 'builtin.core.agent', data: { name: 'Agent R' } }],
    edges: [],
  }),
})

interface TestUser {
  id: string
  email: string
  cookie: string
}

function cookieOf(response: Response): string {
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'the auth call must return a session cookie')
  return cookie
}

async function makeUser(email: string): Promise<TestUser> {
  const response = await ensureAuth().api.signUpEmail({
    body: { name: email, email, password: 'password123456' },
    asResponse: true,
  })
  const cookie = cookieOf(response)
  const body = (await response.json()) as { user: { id: string } }
  return { id: body.user.id, email, cookie }
}

/** The same person signed in again: another device, with a session of its own. */
async function signInAgain(user: TestUser): Promise<TestUser> {
  const response = await ensureAuth().api.signInEmail({
    body: { email: user.email, password: 'password123456' },
    asResponse: true,
  })
  return { ...user, cookie: cookieOf(response) }
}

function reqAs(user: TestUser): Request {
  return new Request('http://localhost:9999/', { headers: { cookie: user.cookie } })
}

async function chatWithThreads(owner: TestUser, name: string, titles: string[]) {
  const chat = await model.createGroupChat(reqAs(owner), name)
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-r' })
  const ids: string[] = []
  for (const title of titles) {
    const [row] = await db
      .insert(groupChatThread)
      .values({
        groupChatId: chat.id,
        agentNodeId: 'agent-r',
        sessionKey: `group-chat:${chat.id}:agent-r:${title}`,
        title,
        createdByUserId: owner.id,
      })
      .returning({ id: groupChatThread.id })
    assert.ok(row)
    ids.push(row.id)
  }
  return { chat, ids }
}

const loose = (...threadIds: string[]) => threadIds.map((threadId) => ({ kind: 'thread' as const, threadId }))

test('a thread opened for the first time joins at the end, and opening one already there moves nothing', async () => {
  const owner = await makeUser('recent-order@example.test')
  const { ids } = await chatWithThreads(owner, 'Order chat', ['one', 'two', 'three'])
  const [one, two, three] = ids

  await recent.recordRecent(reqAs(owner), one)
  await recent.recordRecent(reqAs(owner), two)
  const before = await recent.recordRecent(reqAs(owner), three)
  assert.deepEqual(before.layout.entries, loose(one, two, three))

  const reopened = await recent.recordRecent(reqAs(owner), one)
  assert.deepEqual(reopened.layout.entries, loose(one, two, three))
  assert.equal(reopened.version, before.version, 'reopening writes nothing')
  assert.deepEqual(
    reopened.threads.map((thread) => thread.title),
    ['one', 'two', 'three'],
  )
})

test('a thread filed in a folder stays in it when it is opened again', async () => {
  const owner = await makeUser('recent-folder@example.test')
  const { ids } = await chatWithThreads(owner, 'Folder chat', ['a', 'b'])
  const [a, b] = ids
  await recent.recordRecent(reqAs(owner), a)
  const current = await recent.recordRecent(reqAs(owner), b)
  const filed = {
    entries: [{ kind: 'folder' as const, folder: { id: 'folder-x', name: 'Work', threadIds: [b] } }, ...loose(a)],
  }
  const saved = await recent.saveRecentLayout(reqAs(owner), filed, current.version)
  assert.ok(saved.ok)

  const reopened = await recent.recordRecent(reqAs(owner), b)
  assert.deepEqual(reopened.layout, filed)
})

test('the arrangement is the account’s: another session of the same person reads it, another person reads their own', async () => {
  const owner = await makeUser('recent-devices@example.test')
  const stranger = await makeUser('recent-stranger@example.test')
  const { chat, ids } = await chatWithThreads(owner, 'Devices chat', ['x', 'y'])
  const [x, y] = ids
  await recent.recordRecent(reqAs(owner), x)
  const current = await recent.recordRecent(reqAs(owner), y)
  const arranged = {
    entries: [{ kind: 'folder' as const, folder: { id: 'folder-d', name: 'Later', threadIds: [x] } }, ...loose(y)],
  }
  assert.ok((await recent.saveRecentLayout(reqAs(owner), arranged, current.version)).ok)

  const otherDevice = await signInAgain(owner)
  assert.notEqual(otherDevice.cookie, owner.cookie)
  const there = await recent.loadRecent(reqAs(otherDevice), [])
  assert.deepEqual(there.layout, arranged)
  assert.deepEqual(there.threads.map((thread) => thread.id).sort(), [x, y].sort())

  // The stranger is let into the chat, so the threads are readable to them
  // too: what keeps them out of the owner's Recent is whose row it is.
  await model.addMember(reqAs(owner), chat.id, { kind: 'user', userId: stranger.id })
  const theirs = await recent.loadRecent(reqAs(stranger), [])
  assert.deepEqual(theirs.layout.entries, [])
  assert.equal(theirs.userId, stranger.id)
})

test('a save at a version someone else has moved past is refused with the arrangement that is there', async () => {
  const owner = await makeUser('recent-race@example.test')
  const { ids } = await chatWithThreads(owner, 'Race chat', ['p', 'q'])
  const [p, q] = ids
  const first = await recent.recordRecent(reqAs(owner), p)
  const second = await recent.recordRecent(reqAs(owner), q)

  const stale = await recent.saveRecentLayout(reqAs(owner), { entries: loose(q, p) }, first.version)
  assert.equal(stale.ok, false)
  assert.ok(!stale.ok && stale.current.version === second.version)
  assert.ok(!stale.ok && JSON.stringify(stale.current.layout) === JSON.stringify({ entries: loose(p, q) }))
})

test('a removed thread leaves, its folder stays, and opening it again brings it back at the end', async () => {
  const owner = await makeUser('recent-remove@example.test')
  const { ids } = await chatWithThreads(owner, 'Remove chat', ['r1', 'r2', 'r3'])
  const [r1, r2, r3] = ids
  for (const id of ids) {
    await recent.recordRecent(reqAs(owner), id)
  }
  const current = await recent.loadRecent(reqAs(owner), [])
  const arranged = {
    entries: [{ kind: 'folder' as const, folder: { id: 'folder-r', name: 'Kept', threadIds: [r1] } }, ...loose(r2, r3)],
  }
  assert.ok((await recent.saveRecentLayout(reqAs(owner), arranged, current.version)).ok)

  const removed = await recent.removeRecent(reqAs(owner), r1)
  assert.deepEqual(removed.layout.entries, [
    { kind: 'folder', folder: { id: 'folder-r', name: 'Kept', threadIds: [] } },
    ...loose(r2, r3),
  ])
  const back = await recent.recordRecent(reqAs(owner), r1)
  assert.deepEqual(back.layout.entries.slice(1), loose(r2, r3, r1))
})

test('a deleted thread and a thread in a chat the person left drop out; one they cannot read is never recorded', async () => {
  const owner = await makeUser('recent-prune@example.test')
  const other = await makeUser('recent-prune-other@example.test')
  const { ids } = await chatWithThreads(owner, 'Prune chat', ['kept', 'deleted'])
  const [kept, deleted] = ids
  const left = await chatWithThreads(other, 'Left chat', ['left'])
  await model.addMember(reqAs(other), left.chat.id, { kind: 'user', userId: owner.id })
  const foreign = await chatWithThreads(other, 'Foreign chat', ['foreign'])

  for (const id of [kept, deleted, left.ids[0]]) {
    await recent.recordRecent(reqAs(owner), id)
  }
  const refused = await recent.recordRecent(reqAs(owner), foreign.ids[0])
  assert.ok(!refused.layout.entries.some((entry) => entry.kind === 'thread' && entry.threadId === foreign.ids[0]))

  await db.delete(groupChatThread).where(eq(groupChatThread.id, deleted))
  await db
    .delete(groupChatMember)
    .where(and(eq(groupChatMember.groupChatId, left.chat.id), eq(groupChatMember.userId, owner.id)))

  const pruned = await recent.loadRecent(reqAs(owner), [])
  assert.deepEqual(pruned.layout.entries, loose(kept))
  assert.deepEqual(
    pruned.threads.map((thread) => thread.id),
    [kept],
  )
  // Rejoining does not bring a pruned thread back: it is opened again, or not.
  await model.addMember(reqAs(other), left.chat.id, { kind: 'user', userId: owner.id })
  assert.deepEqual((await recent.loadRecent(reqAs(owner), [])).layout.entries, loose(kept))
})

test('a browser’s own list is brought in once, in its order and after what the account holds', async () => {
  const owner = await makeUser('recent-import@example.test')
  const { ids } = await chatWithThreads(owner, 'Import chat', ['held', 'newest', 'older'])
  const [held, newest, older] = ids
  await recent.recordRecent(reqAs(owner), held)

  // Newest first, as the browser kept it, with an id nobody can read.
  const imported = await recent.loadRecent(reqAs(owner), [newest, 'no-such-thread', held, older])
  assert.deepEqual(imported.layout.entries, loose(held, newest, older))

  const again = await recent.loadRecent(reqAs(owner), [newest, older])
  assert.equal(again.version, imported.version, 'a repeated import writes nothing')
  assert.deepEqual(again.layout.entries, loose(held, newest, older))
})

test('a layout that is not threads and folders is refused before it is stored', () => {
  for (const bad of [
    null,
    {},
    { entries: 'x' },
    { entries: [{ kind: 'thread' }] },
    { entries: [{ kind: 'folder', folder: { id: 'f', name: 'n' } }] },
    { entries: [{ kind: 'folder', folder: { id: 'f', name: 'n', threadIds: [1] } }] },
    { entries: [{ kind: 'other', threadId: 't' }] },
  ]) {
    assert.throws(() => recent.parseRecentLayoutInput(bad), /Expected a layout/, JSON.stringify(bad))
  }
  const good = {
    entries: [
      { kind: 'folder', folder: { id: 'f', name: 'n', threadIds: ['t'] } },
      { kind: 'thread', threadId: 'u' },
    ],
  }
  assert.deepEqual(recent.parseRecentLayoutInput(good), good)
})
