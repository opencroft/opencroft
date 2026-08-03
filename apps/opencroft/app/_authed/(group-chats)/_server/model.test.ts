// Proves the access rule against a real database, not mocks — the point is
// that the table definitions, the migration and the membership queries
// actually agree, the same reason token-actions.test.ts is set up this way.
//
// PGLITE_PATH and the migrations folder are set before importing anything
// that touches the db package — `@opencroft/db` opens the connection and
// migrates at import time, so the environment has to be in place first.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-group-chats-test-'))
process.env.PGLITE_PATH = join(workdir, 'pglite')
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
// No BETTER_AUTH_SECRET in a test process — Better Auth needs a secret
// configured before it will sign or verify a session at all.
process.env.NODE_ENV = 'development'

const { db, space, groupChatMember, groupChatThread } = await import('@opencroft/db')
const model = await import('./model')
const { ensureAuth } = await import('@opencroft/auth/server')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

// Seeded once, before any test runs (and before `addMember`'s first call to
// `listAgentNodesImpl`, which loads and then caches the space registry for
// the life of this process) — a real space graph with two real agent nodes,
// the same shape `ai-panel.tsx` reads, rather than a mocked module.
// Node-module namespace exports are non-configurable, so `mock.method`
// cannot stand in for either `getSessionUser` or the agents module here
// (confirmed: it throws "Cannot redefine property"); everything below is a
// real signed-in session and a real seeded row instead.
await db.insert(space).values({
  slug: 'test-space',
  name: 'Test Space',
  data: JSON.stringify({
    nodes: [
      { id: 'agent-a', type: 'agent', data: { name: 'Agent A' } },
      { id: 'agent-b', type: 'agent', data: { name: 'Agent B' } },
      { id: 'agent-solo', type: 'agent', data: { name: 'Agent Solo' } },
    ],
    edges: [],
  }),
})

interface TestUser {
  id: string
  cookie: string
}

// A real Better Auth session, not a stand-in for one: sign up, capture the
// `Set-Cookie` the real sign-up response returns, and reuse it verbatim on
// later requests. This is what `getSessionUser` (packages/auth/src/server.ts)
// actually authenticates against, so a test built on it proves the same path
// a real browser request goes through.
async function makeUser(email: string): Promise<TestUser> {
  const result = await ensureAuth().api.signUpEmail({
    body: { name: email, email, password: 'password123456' },
    asResponse: true,
  })
  const setCookie = result.headers.get('set-cookie')
  assert.ok(setCookie, 'sign-up must return a session cookie')
  const cookie = setCookie.split(';')[0]
  assert.ok(cookie, 'the session cookie must be parseable')
  const body = (await result.json()) as { user: { id: string } }
  return { id: body.user.id, cookie }
}

function reqAs(u: TestUser): Request {
  return new Request('http://localhost:9999/', { headers: { cookie: u.cookie } })
}

function reqAnonymous(): Request {
  return new Request('http://localhost:9999/')
}

/** The refusal a call produces, so two of them can be compared field by field. */
async function captureRefusal(run: () => Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await run()
  } catch (error) {
    assert.ok(error instanceof model.GroupChatAccessError, 'expected a group-chat refusal')
    return { code: error.code, message: error.message }
  }
  throw new Error('expected the call to be refused, but it resolved')
}

// ---------------------------------------------------------------------------
// THE ACCESS RULE. This is the proof the access rule calls
// for: a request that bypasses the UI entirely — no route, no component, a
// direct call to the same function a server endpoint would call — refused by
// the server for a user who is not a member, not merely absent from a list.
// ---------------------------------------------------------------------------

test('a non-member is refused a thread directly, not just omitted from a list', async () => {
  const owner = await makeUser('owner@example.test')
  const outsider = await makeUser('outsider@example.test')

  const chat = await model.createGroupChat(reqAs(owner), 'incident review')
  const [agentRow] = await db
    .insert(groupChatMember)
    .values({ groupChatId: chat.id, principalType: 'agent', agentNodeId: 'agent-node-1' })
    .returning()
  assert.ok(agentRow)

  // Direct insert rather than startThread, so this test does not depend on a
  // live agent process existing — the access rule is what is under test, not
  // the ACP session machinery, which is exercised separately below.
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-node-1',
      sessionKey: 'group-chat:test:agent-node-1:fixture',
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  // The owner, a real member, can read it.
  const asOwner = await model.getThread(reqAs(owner), thread.id)
  assert.equal(asOwner.id, thread.id, 'a member must be able to read the thread they created')

  // A signed-in user who was never added is refused — the actual proof.
  await assert.rejects(
    () => model.getThread(reqAs(outsider), thread.id),
    (error: unknown) => {
      assert.ok(error instanceof model.GroupChatAccessError, 'must be the access error, not some other failure')
      assert.equal(error.code, 'not-found')
      return true
    },
    'a non-member must be refused the thread directly, not shown an empty result',
  )

  // Listing the group chat's threads must not leak the thread's existence
  // either — the same rule, exercised through the list path.
  await assert.rejects(() => model.listThreadsInGroupChat(reqAs(outsider), chat.id), model.GroupChatAccessError)

  // And an anonymous request — no session at all — is refused before
  // membership is even checked.
  await assert.rejects(
    () => model.getThread(reqAnonymous(), thread.id),
    (error: unknown) => {
      assert.ok(error instanceof model.GroupChatAccessError)
      assert.equal(error.code, 'unauthenticated')
      return true
    },
  )
})

// REGRESSION TEST for a defect found in testing.
//
// The version of this test that shipped asserted only that both cases threw a
// GroupChatAccessError, and argued in its own comment that message text "is
// not a contract". That was wrong twice over: the message is precisely what a
// caller reads, and the two cases were in fact sending different codes AND
// different messages (`No such group chat` vs `You are not a member of this
// group chat`). The screen mapped both to the same words, which hid it from
// the UI but not from anyone reading the response.
//
// So this now captures both refusals and compares them to EACH OTHER, field
// by field. Comparing against a literal would drift; comparing the two is the
// property itself.
test('a nonexistent group chat and one the caller is not a member of are indistinguishable', async () => {
  const outsider = await makeUser('checker@example.test')
  const owner = await makeUser('owner2@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'a chat the checker is not in')

  const fabricated = await captureRefusal(() => model.getGroupChat(reqAs(outsider), crypto.randomUUID()))
  const real = await captureRefusal(() => model.getGroupChat(reqAs(outsider), chat.id))

  assert.equal(fabricated.code, real.code, 'the codes must not tell the two apart')
  assert.equal(fabricated.message, real.message, 'the messages must not tell the two apart either')
  assert.equal(
    real.message.includes('member'),
    false,
    'the refusal must not mention membership — that is what revealed the real id',
  )

  // Same property for threads, which have their own pair of refusal sites.
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:indistinguishable`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const fakeThread = await captureRefusal(() => model.getThread(reqAs(outsider), crypto.randomUUID()))
  const realThread = await captureRefusal(() => model.getThread(reqAs(outsider), thread.id))
  assert.equal(fakeThread.code, realThread.code)
  assert.equal(fakeThread.message, realThread.message)
})

test("one user's group chat does not appear in another's list", async () => {
  const alice = await makeUser('alice2@example.test')
  const bob = await makeUser('bob2@example.test')

  const chat = await model.createGroupChat(reqAs(alice), "alice's chat")

  const bobsList = await model.listGroupChatsForUser(reqAs(bob))
  assert.equal(
    bobsList.some((c) => c.id === chat.id),
    false,
    'a group chat must not appear in a list scoped to a user who is not a member',
  )

  const alicesList = await model.listGroupChatsForUser(reqAs(alice))
  assert.ok(
    alicesList.some((c) => c.id === chat.id),
    'the creator must see their own group chat',
  )
})

// ---------------------------------------------------------------------------
// The membership model itself.
// ---------------------------------------------------------------------------

test('an agent must exist in the graph to be added as a member', async () => {
  const owner = await makeUser('owner3@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent validation')

  await assert.rejects(
    () => model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'does-not-exist' }),
    /No such agent node/,
    'an agent node id that is not in any space graph must be refused at membership-add, not accepted as a dangling reference',
  )
})

test('adding the same member twice does not duplicate the row', async () => {
  const owner = await makeUser('owner4@example.test')
  const other = await makeUser('other4@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'idempotent add')

  await model.addMember(reqAs(owner), chat.id, { kind: 'user', userId: other.id })
  await model.addMember(reqAs(owner), chat.id, { kind: 'user', userId: other.id })

  const members = await model.listMembers(reqAs(owner), chat.id)
  assert.equal(
    members.filter((m) => m.userId === other.id).length,
    1,
    'adding the same user twice must not produce two membership rows',
  )
})

// ---------------------------------------------------------------------------
// The two write paths that matter — `addMember` because "any existing member
// may add another" makes it the single most attackable call in the file, and
// `sendMessageInThread` because it is the one call that reaches a live agent.
// The existing idempotency/validation tests above prove `addMember` behaves
// correctly for a member; these prove a non-member is refused outright.
// ---------------------------------------------------------------------------

test('a non-member calling addMember to add themselves is refused', async () => {
  const owner = await makeUser('addself-owner@example.test')
  const outsider = await makeUser('addself-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'no self-invite')

  await assert.rejects(
    () => model.addMember(reqAs(outsider), chat.id, { kind: 'user', userId: outsider.id }),
    (error: unknown) => {
      assert.ok(error instanceof model.GroupChatAccessError, 'must be the access error, not some other failure')
      assert.equal(error.code, 'not-found')
      return true
    },
    'a non-member must not be able to add themselves as a member',
  )

  const members = await model.listMembers(reqAs(owner), chat.id)
  assert.equal(
    members.some((m) => m.userId === outsider.id),
    false,
    'the refused call must not have created a membership row',
  )
})

test('a non-member calling sendMessageInThread is refused before any agent session is touched', async () => {
  const owner = await makeUser('sendmsg-owner@example.test')
  const outsider = await makeUser('sendmsg-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'no eavesdropping')

  await db
    .insert(groupChatMember)
    .values({ groupChatId: chat.id, principalType: 'agent', agentNodeId: 'agent-node-send' })
  // Direct insert, same reason as the read-side proof above: this test
  // exercises the access rule in sendMessageInThread's own hand-rolled gate,
  // not the ACP session machinery a real thread would have gone through.
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-node-send',
      sessionKey: 'group-chat:test:agent-node-send:fixture-send',
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  await assert.rejects(
    () => model.sendMessageInThread(reqAs(outsider), thread.id, 'let me in'),
    (error: unknown) => {
      assert.ok(error instanceof model.GroupChatAccessError, 'must be the access error, not some other failure')
      assert.equal(error.code, 'not-found')
      return true
    },
    'a non-member must be refused before the call ever reaches the live agent session',
  )
})

// ---------------------------------------------------------------------------
// The ordinary path:
// create a group chat with a topic, add two agents and a user, confirm the
// second agent sees the group chat, confirm an outside agent sees neither.
//
// "Sees" for an agent is `isAgentMember`-shaped visibility, not a server
// endpoint — there is no independent agent caller of these functions (see
// the header of model.ts for why), so this exercises the membership table
// directly, the same layer `startThread`'s own agent-membership check reads.
//
// `agent-a` and `agent-b` are real nodes in the space seeded at the top of
// this file — `addMember` validates agent existence against the live space
// graph, so a fabricated id here would be refused before membership is ever
// recorded.
// ---------------------------------------------------------------------------

test('membership visibility holds in both directions for agents', async () => {
  const owner = await makeUser('owner5@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'both directions')

  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-b' })

  const members = await model.listMembers(reqAs(owner), chat.id)
  const agentIds = members.filter((m) => m.principalType === 'agent').map((m) => m.agentNodeId)
  assert.deepEqual(new Set(agentIds), new Set(['agent-a', 'agent-b']), 'both added agents must be members')
  assert.equal(
    agentIds.includes('agent-outsider'),
    false,
    'an agent never added must not appear as a member of this group chat',
  )
})

// ---------------------------------------------------------------------------
// listGroupChatsForAgent — a name-based lookup, not an authorization check
// (a deliberate design choice). Agent names
// are taken to be unique, also a deliberate choice — no collision
// case to test here. `agent-solo` is the node seeded at the top of this file.
// ---------------------------------------------------------------------------

test('listGroupChatsForAgent returns exactly the group chats that agent is a member of', async () => {
  const owner = await makeUser('agentlookup-owner@example.test')
  const inChat = await model.createGroupChat(reqAs(owner), 'agent-solo is in this one')
  const notInChat = await model.createGroupChat(reqAs(owner), 'agent-solo is not in this one')
  await model.addMember(reqAs(owner), inChat.id, { kind: 'agent', agentNodeId: 'agent-solo' })

  const chats = await model.listGroupChatsForAgent('Agent Solo')
  const chatIds = chats.map((c) => c.id)
  assert.ok(chatIds.includes(inChat.id), 'must include a group chat the named agent is a member of')
  assert.equal(
    chatIds.includes(notInChat.id),
    false,
    'must not include a group chat the named agent was never added to',
  )
})

test('listGroupChatsForAgent refuses an unknown name as an ordinary not-found', async () => {
  await assert.rejects(
    () => model.listGroupChatsForAgent('No Such Agent'),
    (error: unknown) => {
      assert.ok(error instanceof model.GroupChatAccessError, 'must be the access error, not some other failure')
      assert.equal(error.code, 'not-found')
      return true
    },
  )
})

// THE PROPERTY THE TRANSPORT SEAM EXISTS TO PRESERVE.
//
// The composer in a group-chat thread routes its sends through this function
// rather than through `promptLocal`, which is addressed by session id and
// checks nothing. So "a non-member cannot send" has to hold HERE, and it has
// to hold before any agent session is touched — the refusal below happens
// ahead of `ensureLocalSessionImpl`, which is why this is testable without a
// live agent process.
test('a non-member cannot send into a thread', async () => {
  const owner = await makeUser('send-owner@example.test')
  const outsider = await makeUser('send-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'sending')
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:send-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const refusal = await captureRefusal(() => model.sendMessageInThread(reqAs(outsider), thread.id, 'let me in'))
  assert.equal(refusal.code, 'not-found')

  // And a fabricated thread id refuses identically, so sending is not a way to
  // probe which threads exist either.
  const fabricated = await captureRefusal(() =>
    model.sendMessageInThread(reqAs(outsider), crypto.randomUUID(), 'hello'),
  )
  assert.equal(fabricated.code, refusal.code)
  assert.equal(fabricated.message, refusal.message)
})

test('an anonymous request cannot send into a thread', async () => {
  const owner = await makeUser('send-owner2@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'anon sending')
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:anon-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const refusal = await captureRefusal(() => model.sendMessageInThread(reqAnonymous(), thread.id, 'hello'))
  assert.equal(refusal.code, 'unauthenticated')
})
