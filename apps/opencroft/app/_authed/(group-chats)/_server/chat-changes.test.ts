// Who hears a group chat's changes on their event stream: the chat's members
// after the change, and a person the change removed -- against a real
// database and real signed-in sessions, the same set-up model.test.ts uses.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

import { waitFor } from '@/test-support/wait'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-chat-changes-test-'))
process.env.OPENCROFT_DATA_DIR = join(workdir, 'data')
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

const { db, space } = await import('@opencroft/db')
const model = await import('./model')
const { ensureAuth } = await import('@opencroft/auth/server')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

// A real space graph with one agent node, which is what addMember validates
// an agent principal against.
await db.insert(space).values({
  slug: 'changes-space',
  name: 'Changes Space',
  data: JSON.stringify({
    nodes: [{ id: 'agent-a', type: 'builtin.core.agent', data: { name: 'Agent A' } }],
    edges: [],
  }),
})

interface TestUser {
  id: string
  cookie: string
}

async function makeUser(email: string): Promise<TestUser> {
  const result = await ensureAuth().api.signUpEmail({
    body: { name: email, email, password: 'password123456' },
    asResponse: true,
  })
  const cookie = result.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'sign-up must return a session cookie')
  const body = (await result.json()) as { user: { id: string } }
  return { id: body.user.id, cookie }
}

function reqAs(u: TestUser): Request {
  return new Request('http://localhost:9999/', { headers: { cookie: u.cookie } })
}

/**
 * One person's stream: the chat ids it was sent, and the chat ids of the
 * changes it has finished deciding on, each in order. A change in `decided`
 * but not in `heard` was decided against, not still in flight.
 */
function listen(u: TestUser): { heard: string[]; decided: string[]; stop: () => void } {
  const heard: string[] = []
  const decided: string[] = []
  const stop = model.streamOwnGroupChatChanges(
    reqAs(u),
    (groupChatId) => heard.push(groupChatId),
    (groupChatId) => decided.push(groupChatId),
  )
  return { heard, decided, stop }
}

// The deadline only bounds a hang: the stream's decisions wait on database
// reads, which a loaded host can slow down.
const DECISION_TIMEOUT_MS = 20_000

test('a member hears an agent added and a sender granted; a person outside the chat hears neither', async () => {
  const owner = await makeUser('changes-owner@example.test')
  const outsider = await makeUser('changes-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'changes heard')
  const ownerStream = listen(owner)
  const outsiderStream = listen(outsider)
  try {
    await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
    await model.addMember(reqAs(owner), chat.id, { kind: 'system', systemId: 'system.script' })
    await waitFor(() => ownerStream.decided.length >= 2, {
      what: 'the owner decides on both changes',
      timeoutMs: DECISION_TIMEOUT_MS,
    })
    await waitFor(() => outsiderStream.decided.length >= 2, {
      what: 'the outsider decides on both changes',
      timeoutMs: DECISION_TIMEOUT_MS,
    })

    assert.deepEqual(outsiderStream.decided, [chat.id, chat.id])
    assert.deepEqual(ownerStream.heard, [chat.id, chat.id])
    assert.deepEqual(outsiderStream.heard, [])
  } finally {
    ownerStream.stop()
    outsiderStream.stop()
  }
})

test('a person removed from a chat hears that removal, and nothing the chat does afterwards', async () => {
  const owner = await makeUser('removal-owner@example.test')
  const leaver = await makeUser('removal-leaver@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'changes removal')
  await model.addMember(reqAs(owner), chat.id, { kind: 'user', userId: leaver.id })
  const ownerStream = listen(owner)
  const leaverStream = listen(leaver)
  try {
    await model.removeMember(reqAs(owner), chat.id, { kind: 'user', userId: leaver.id })
    await waitFor(() => leaverStream.decided.length >= 1, {
      what: 'the leaver decides on the removal',
      timeoutMs: DECISION_TIMEOUT_MS,
    })
    await waitFor(() => ownerStream.decided.length >= 1, {
      what: 'the owner decides on the removal',
      timeoutMs: DECISION_TIMEOUT_MS,
    })
    await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
    await waitFor(() => leaverStream.decided.length >= 2, {
      what: 'the leaver decides on the addition',
      timeoutMs: DECISION_TIMEOUT_MS,
    })
    await waitFor(() => ownerStream.decided.length >= 2, {
      what: 'the owner decides on the addition',
      timeoutMs: DECISION_TIMEOUT_MS,
    })

    assert.deepEqual(leaverStream.decided, [chat.id, chat.id])
    assert.deepEqual(leaverStream.heard, [chat.id])
    assert.deepEqual(ownerStream.heard, [chat.id, chat.id])
  } finally {
    ownerStream.stop()
    leaverStream.stop()
  }
})

test('a stream that stopped hears nothing more', async () => {
  const owner = await makeUser('stopped-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'changes stopped')
  const stream = listen(owner)
  // A second stream of the same person, left open, shows the change was
  // announced and decided on. Announcing calls every subscriber at once, so a
  // stopped stream still subscribed would be deciding alongside it; that its
  // decision could land after the open one's is the hole left here.
  const control = listen(owner)
  stream.stop()
  try {
    await model.addMember(reqAs(owner), chat.id, { kind: 'system', systemId: 'system.script' })
    await waitFor(() => control.decided.length >= 1, {
      what: 'the open stream decides on the change',
      timeoutMs: DECISION_TIMEOUT_MS,
    })

    assert.deepEqual(control.heard, [chat.id])
    assert.deepEqual(stream.decided, [])
    assert.deepEqual(stream.heard, [])
  } finally {
    control.stop()
  }
})
