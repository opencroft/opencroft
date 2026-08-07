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

// Safe to import statically, above the env setup below: none of these opens a
// database connection (agent-client is host-agnostic, `slug` is dependency-free
// and drizzle-orm's `eq` is a pure query builder), so hoisting them cannot make
// `@opencroft/db` connect before PGLITE_PATH is in place.
import type { AgentConnection } from 'agent-client/connection'
import { buildSpawnConfig } from 'agent-client/resolve'
import type { AgentSelection } from 'agent-client/types'
import { and, eq } from 'drizzle-orm'

import { slug } from '@/app/_authed/(server)/_server/types'

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
// Dynamic like the rest: it reads and writes the settings table, so importing
// it statically would touch the database before PGLITE_PATH is set above.
const sessionStore = await import('@/app/_authed/(agent)/_server/acp-session-store')
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
      // Carries a full provider/adapter/model triple, unlike the three above,
      // so `ensureLocalSessionImpl` can build a real AgentSelection for it and
      // the delete-ordering test below can open an actual session against a
      // seeded mock connection.
      {
        id: 'agent-session',
        type: 'agent',
        data: { name: 'Agent Session', providerId: 'test-provider', adapterId: 'openclaw', model: 'test-model' },
      },
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

// ---------------------------------------------------------------------------
// DELETE ORDERING. The thread row is the only handle anything has on a
// sessionKey, so if the row goes first and the teardown then fails, the ACP
// session and its agent subprocess are left running with nothing pointing at
// them: no screen lists them, and a retried delete finds no row to work from.
//
// The property is an ordering one, and ordering is only observable from inside
// the teardown — so this asserts it there, from the mock connection's own
// `closeSession`, which is the last thing `forgetLocalSessionImpl` drives
// before it returns. If the row is still readable at that moment, teardown ran
// first. Reverting model.ts to delete-then-teardown fails this on the
// `rowVisibleDuringTeardown` assertion, not on a crash.
// ---------------------------------------------------------------------------
test('deleteThread tears the session down before dropping the row it is reachable through', async () => {
  const owner = await makeUser('delete-order-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'delete ordering')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  // What the teardown saw. `closeSession` reads the thread table directly
  // rather than going through the model, so the observation is of the row
  // itself and not of a membership-gated view of it.
  let closeSessionCalls = 0
  let rowVisibleDuringTeardown: boolean | null = null
  let threadId = ''

  const connection = {
    newSession: async () => ({ sessionId: `test-session-${crypto.randomUUID()}` }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => {
      closeSessionCalls += 1
      const rows = await db.select().from(groupChatThread).where(eq(groupChatThread.id, threadId))
      rowVisibleDuringTeardown = rows.length === 1
      return {}
    },
  } as unknown as AgentConnection

  // Same spawn-config key `ensureLocalSessionImpl` will derive for this node,
  // so the client reuses this connection instead of spawning a real process.
  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first message')
  threadId = started.thread.id

  await model.deleteThread(reqAs(owner), threadId)

  assert.equal(closeSessionCalls, 1, 'the delete must actually reach the live session, not skip teardown')
  assert.equal(
    rowVisibleDuringTeardown,
    true,
    'the thread row must still exist while the session is being torn down — otherwise a teardown failure strands a live agent process nothing can reach',
  )
  const remaining = await db.select().from(groupChatThread).where(eq(groupChatThread.id, threadId))
  assert.equal(remaining.length, 0, 'and the row is gone once the delete completes')
})

// ---------------------------------------------------------------------------
// REMOVING A MEMBER.
//
// The rule that makes removal mean anything is server-side: a removed agent's
// threads are deliberately kept (they stay readable), and they carry the
// sessionKey, so without a check every send through them would still reach the
// agent. Removal that only dimmed a row in a list would be decoration.
// ---------------------------------------------------------------------------

test('removing an agent stops sends into its existing threads, which are kept, not deleted', async () => {
  const owner = await makeUser('remove-agent-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'removing an agent')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:remove-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  await model.removeMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  // The membership is gone.
  const members = await model.listMembers(reqAs(owner), chat.id)
  assert.equal(
    members.some((m) => m.agentNodeId === 'agent-a'),
    false,
    'the agent must no longer be a member',
  )

  // The thread is NOT gone -- the conversation stays readable.
  const kept = await db.select().from(groupChatThread).where(eq(groupChatThread.id, thread.id))
  assert.equal(kept.length, 1, 'the thread must survive removal; only sending into it stops')

  // And sending into it is refused, with a code distinct from the not-found
  // collapse: the caller is a member and can see the thread, so telling them
  // why is not a leak.
  const refusal = await captureRefusal(() => model.sendMessageInThread(reqAs(owner), thread.id, 'still there?'))
  assert.equal(refusal.code, 'agent-not-a-member')
})

// THE REASON THREADS ARE KEPT AT ALL.
//
// Removal stops the agent's process, and there are two ways to do that: one
// keeps the durable tabKey->sessionId pointer, the other deletes it. They look
// identical straight afterwards -- no live process either way -- and differ
// only later, when the thread is reopened: with the pointer the session
// resumes and the conversation is there, without it the thread comes back as a
// brand-new empty session. Keeping a thread whose history is unreachable is
// keeping nothing, so this asserts the pointer survives.
test('removing an agent leaves its threads resumable — the persisted session pointer survives', async () => {
  const owner = await makeUser('remove-history-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'history survives removal')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  const sessionKey = `group-chat:${chat.id}:agent-a:history-fixture`
  const [thread] = await db
    .insert(groupChatThread)
    .values({ groupChatId: chat.id, agentNodeId: 'agent-a', sessionKey, createdByUserId: owner.id })
    .returning()
  assert.ok(thread)

  // The pointer a real session would have left behind. Written directly rather
  // than by opening a session, so this test is about the pointer's survival and
  // not about the session machinery.
  await sessionStore.writePersistedSession(sessionKey, 'persisted-session-id')

  await model.removeMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  assert.equal(
    await sessionStore.readPersistedSession(sessionKey),
    'persisted-session-id',
    'the durable session pointer must survive removal — without it the kept thread reopens empty and its history is unreachable',
  )
})

test('a non-member cannot remove a member', async () => {
  const owner = await makeUser('remove-guard-owner@example.test')
  const outsider = await makeUser('remove-guard-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'guarded removal')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-b' })

  const refusal = await captureRefusal(() =>
    model.removeMember(reqAs(outsider), chat.id, { kind: 'agent', agentNodeId: 'agent-b' }),
  )
  assert.equal(refusal.code, 'not-found')

  const members = await model.listMembers(reqAs(owner), chat.id)
  assert.equal(
    members.some((m) => m.agentNodeId === 'agent-b'),
    true,
    'the refused call must not have removed anything',
  )
})

// Visibility is derived from user membership, so a chat whose last person left
// would not be deleted -- it would be stranded: still in the database, in
// nobody's list, with no member left who could add anyone back.
test('the last user member cannot be removed, and a second one can', async () => {
  const owner = await makeUser('last-member-owner@example.test')
  const other = await makeUser('last-member-other@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'last one out')

  const refusal = await captureRefusal(() =>
    model.removeMember(reqAs(owner), chat.id, { kind: 'user', userId: owner.id }),
  )
  assert.equal(refusal.code, 'last-user-member')

  // With a second person present, removing one is fine -- including removing
  // yourself, which is how leaving works.
  await model.addMember(reqAs(owner), chat.id, { kind: 'user', userId: other.id })
  await model.removeMember(reqAs(owner), chat.id, { kind: 'user', userId: owner.id })

  const members = await model.listMembers(reqAs(other), chat.id)
  assert.equal(
    members.some((m) => m.userId === owner.id),
    false,
    'the departing user must be gone',
  )
  // And having left, they can no longer reach it at all.
  const afterLeaving = await captureRefusal(() => model.listMembers(reqAs(owner), chat.id))
  assert.equal(afterLeaving.code, 'not-found')
})

// Same ordering property `deleteThread` has, and for the same reason: while the
// membership row is still there the removal is visible and retryable. Asserted
// from inside the teardown, which is the only place the order is observable.
test('removing an agent tears its session down before dropping the membership row', async () => {
  const owner = await makeUser('remove-order-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'removal ordering')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  let closeSessionCalls = 0
  let stillMemberDuringTeardown: boolean | null = null

  const connection = {
    newSession: async () => ({ sessionId: `test-session-${crypto.randomUUID()}` }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => {
      closeSessionCalls += 1
      const rows = await db
        .select()
        .from(groupChatMember)
        .where(and(eq(groupChatMember.groupChatId, chat.id), eq(groupChatMember.agentNodeId, 'agent-session')))
      stillMemberDuringTeardown = rows.length === 1
      return {}
    },
  } as unknown as AgentConnection

  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first message')
  await model.removeMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  assert.equal(closeSessionCalls, 1, 'removal must actually reach the live session, not just drop the row')
  assert.equal(
    stillMemberDuringTeardown,
    true,
    'the membership row must still exist while the session is torn down — otherwise a failed teardown leaves a running agent behind a member nobody can see to remove again',
  )
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

// `promptLocalImpl` hands the message to the client's queue and returns; the
// queue then dispatches to the connection without the caller awaiting it (see
// agent-client's `void connection.prompt(...)`). So a test that inspects what
// the agent received has to wait for the dispatch rather than assume it has
// already happened -- asserting straight after the call is a race that passes
// on a fast machine.
async function waitForPrompts(prompts: string[], count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (prompts.length >= count) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`expected ${count} prompt(s) to reach the agent, saw ${prompts.length}`)
}

// ---------------------------------------------------------------------------
// NAME AND TOPIC. Two fields for two audiences: the name is what people read
// and no agent is ever told it; the topic is what an agent is told a chat is
// for, and it is read at the moment a thread opens its session.
// ---------------------------------------------------------------------------

test('creation names the chat and seeds the topic from that name', async () => {
  const owner = await makeUser('naming-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), '  Release train  ')

  assert.equal(chat.name, 'Release train', 'the name is trimmed')
  assert.equal(chat.topic, 'Release train', 'with no topic given, the name is the honest default')
})

test('creation keeps an explicit topic separate from the name', async () => {
  const owner = await makeUser('naming-owner2@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Release train', 'Ship the June release without regressions')

  assert.equal(chat.name, 'Release train')
  assert.equal(chat.topic, 'Ship the June release without regressions')
})

test('renaming changes the name and leaves the topic untouched, and vice versa', async () => {
  const owner = await makeUser('rename-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'first name', 'the original purpose')

  await model.renameGroupChat(reqAs(owner), chat.id, '  second name  ')
  let after = await model.getGroupChat(reqAs(owner), chat.id)
  assert.equal(after.name, 'second name')
  assert.equal(after.topic, 'the original purpose', 'a rename must not touch what agents are told')

  await model.setGroupChatTopic(reqAs(owner), chat.id, 'a revised purpose')
  after = await model.getGroupChat(reqAs(owner), chat.id)
  assert.equal(after.name, 'second name', 'editing the topic must not touch what people read')
  assert.equal(after.topic, 'a revised purpose')
})

test('a non-member can neither rename a chat nor change its topic', async () => {
  const owner = await makeUser('edit-owner@example.test')
  const outsider = await makeUser('edit-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'not yours')

  const rename = await captureRefusal(() => model.renameGroupChat(reqAs(outsider), chat.id, 'mine now'))
  const retopic = await captureRefusal(() => model.setGroupChatTopic(reqAs(outsider), chat.id, 'mine now'))

  // The same refusal every other non-member path gives, so a write is not a way
  // to learn which chat ids are real either.
  assert.equal(rename.code, 'not-found')
  assert.equal(retopic.code, 'not-found')
  assert.equal(rename.message, retopic.message)

  const untouched = await model.getGroupChat(reqAs(owner), chat.id)
  assert.equal(untouched.name, 'not yours', 'the refusal must also mean nothing was written')
  assert.equal(untouched.topic, 'not yours')
})

// WHAT AN OPEN SESSION IS TOLD WHEN THE STANDING CONTEXT MOVES. A changed
// topic (or pin set) rides the NEXT message into the thread, exactly once --
// not with every message, which would put the whole block in front of every
// turn for no new information.
//
// Asserted from the mock connection's own `prompt`, so what is checked is the
// text an agent actually receives rather than the arguments the model was
// called with.
test('a changed topic rides the next send into an open thread, once', async () => {
  const owner = await makeUser('topic-delivery-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'delivery', 'the first purpose')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `topic-session-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((block) => block.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection

  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  const first = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)
  assert.match(prompts[0] ?? '', /the first purpose/, 'a new thread is told the topic as it stands')

  // Nothing has changed, so an ordinary send carries nothing extra.
  await model.sendMessageInThread(reqAs(owner), first.thread.id, 'an ordinary message')
  await waitForPrompts(prompts, 2)
  assert.doesNotMatch(prompts[1] ?? '', /the first purpose/, 'unchanged context is not restated on every turn')

  await model.setGroupChatTopic(reqAs(owner), chat.id, 'the second purpose')

  await model.sendMessageInThread(reqAs(owner), first.thread.id, 'a message after the edit')
  await waitForPrompts(prompts, 3)
  assert.match(prompts[2] ?? '', /the second purpose/, 'the change rides the next message into the open thread')

  // ONCE. The thread has now been told, so the message after it is plain again.
  await model.sendMessageInThread(reqAs(owner), first.thread.id, 'and one more')
  await waitForPrompts(prompts, 4)
  assert.doesNotMatch(prompts[3] ?? '', /the second purpose/, 'and is not repeated on every message afterwards')

  // A thread started now is told the edited topic at session-init, from the
  // same assembler rather than a second code path that has to remember.
  await model.startThread(reqAs(owner), chat.id, 'agent-session', 'a fresh thread')
  await waitForPrompts(prompts, 5)
  assert.match(prompts[4] ?? '', /the second purpose/)
  assert.doesNotMatch(prompts[4] ?? '', /the first purpose/)
})

test('a changed pin set rides the next send the same way the topic does', async () => {
  const owner = await makeUser('pin-change-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'pin change', 'the purpose')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `pin-change-session-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((block) => block.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection

  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store)
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  const thread = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)

  const pin = await model.addPin(reqAs(owner), chat.id, 'do not deploy on a Friday')
  await model.sendMessageInThread(reqAs(owner), thread.thread.id, 'after pinning')
  await waitForPrompts(prompts, 2)
  assert.match(prompts[1] ?? '', /do not deploy on a Friday/, 'a new pin reaches the open thread')

  // And unpinning everything is itself a change: the block goes away, and the
  // thread is not told about pins it no longer has.
  await model.removePin(reqAs(owner), pin.id)
  await model.sendMessageInThread(reqAs(owner), thread.thread.id, 'after unpinning')
  await waitForPrompts(prompts, 3)
  assert.doesNotMatch(prompts[2] ?? '', /do not deploy on a Friday/, 'an unpinned note stops being delivered')
  assert.doesNotMatch(prompts[2] ?? '', /standing guidance/, 'and no empty reminder block is sent in its place')
})

test('the name is never delivered to an agent', async () => {
  const owner = await makeUser('name-privacy-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'A name no agent should see', 'the stated purpose')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `name-session-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((block) => block.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection

  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store)
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  await model.startThread(reqAs(owner), chat.id, 'agent-session', 'hello')

  await waitForPrompts(prompts, 1)
  assert.match(prompts[0] ?? '', /the stated purpose/)
  assert.doesNotMatch(
    prompts[0] ?? '',
    /A name no agent should see/,
    'the name is presentation — a rename must never be able to change what an agent was told',
  )
})

// ---------------------------------------------------------------------------
// PINNED NOTES. Standing guidance on the chat, delivered to the agents in its
// threads. This file covers the notes themselves and what a NEW thread is
// told; delivery into an already-open session is its own slice.
// ---------------------------------------------------------------------------

test('pins are kept in the order they were pinned, and trimmed', async () => {
  const owner = await makeUser('pin-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'pinning')

  await model.addPin(reqAs(owner), chat.id, '  first note  ')
  await model.addPin(reqAs(owner), chat.id, 'second note')

  const pins = await model.listPins(reqAs(owner), chat.id)
  assert.deepEqual(
    pins.map((p) => p.text),
    ['first note', 'second note'],
  )
})

test('unpinning leaves the surviving order intact and does not reuse a position', async () => {
  const owner = await makeUser('pin-order-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'ordering')

  await model.addPin(reqAs(owner), chat.id, 'one')
  const two = await model.addPin(reqAs(owner), chat.id, 'two')
  await model.addPin(reqAs(owner), chat.id, 'three')

  await model.removePin(reqAs(owner), two.id)
  const four = await model.addPin(reqAs(owner), chat.id, 'four')

  // The gap left by 'two' is not refilled: reusing its position would put the
  // new pin in the middle of a list nobody reordered.
  assert.ok(four.position > 2, 'a new pin goes after the highest position, not into the gap')
  const pins = await model.listPins(reqAs(owner), chat.id)
  assert.deepEqual(
    pins.map((p) => p.text),
    ['one', 'three', 'four'],
  )
})

test('the pin cap is a refusal the person can act on, not a fault', async () => {
  const owner = await makeUser('pin-cap-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'capped')

  for (let i = 0; i < model.MAX_PINS_PER_GROUP_CHAT; i += 1) {
    await model.addPin(reqAs(owner), chat.id, `note ${i}`)
  }

  const refusal = await captureRefusal(() => model.addPin(reqAs(owner), chat.id, 'one too many'))
  assert.equal(refusal.code, 'pin-limit')

  // And the limit is a real stop, not a warning.
  const pins = await model.listPins(reqAs(owner), chat.id)
  assert.equal(pins.length, model.MAX_PINS_PER_GROUP_CHAT)
})

test('any member may edit or unpin any pin, whoever wrote it', async () => {
  const owner = await makeUser('pin-author@example.test')
  const other = await makeUser('pin-editor@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'shared pins')
  await model.addMember(reqAs(owner), chat.id, { kind: 'user', userId: other.id })

  const pin = await model.addPin(reqAs(owner), chat.id, 'the original wording')
  await model.editPin(reqAs(other), pin.id, 'reworded by someone else')

  let pins = await model.listPins(reqAs(owner), chat.id)
  assert.equal(pins[0]?.text, 'reworded by someone else')

  await model.removePin(reqAs(other), pin.id)
  pins = await model.listPins(reqAs(owner), chat.id)
  assert.equal(pins.length, 0)
})

test('a non-member can neither read, add, edit nor remove pins', async () => {
  const owner = await makeUser('pin-gate-owner@example.test')
  const outsider = await makeUser('pin-gate-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'gated pins')
  const pin = await model.addPin(reqAs(owner), chat.id, 'members only')

  const list = await captureRefusal(() => model.listPins(reqAs(outsider), chat.id))
  const add = await captureRefusal(() => model.addPin(reqAs(outsider), chat.id, 'mine now'))
  const edit = await captureRefusal(() => model.editPin(reqAs(outsider), pin.id, 'mine now'))
  const remove = await captureRefusal(() => model.removePin(reqAs(outsider), pin.id))

  for (const refusal of [list, add, edit, remove]) {
    assert.equal(refusal.code, 'not-found')
  }
  // A real pin id and a fabricated one refuse identically, so a pin id is not a
  // way to learn which pins exist either.
  const fabricated = await captureRefusal(() => model.editPin(reqAs(outsider), crypto.randomUUID(), 'probe'))
  assert.equal(fabricated.code, edit.code)
  assert.equal(fabricated.message, edit.message)

  const untouched = await model.listPins(reqAs(owner), chat.id)
  assert.equal(untouched[0]?.text, 'members only', 'a refused write must also have written nothing')
})

// The signature is what decides whether an agent is still up to date, so what
// counts as a change is worth pinning down rather than trusting to a hash.
test('the standing signature distinguishes order, content, emptiness and ambiguous joins', async () => {
  const { standingSignature } = model

  assert.notEqual(standingSignature('t', ['a', 'b']), standingSignature('t', ['b', 'a']), 'reordering is a change')
  assert.notEqual(standingSignature('t', ['a']), standingSignature('t', ['a!']), 'an edit is a change')
  assert.notEqual(standingSignature('t', []), standingSignature('t', ['']), 'no pins is not one empty pin')
  assert.notEqual(
    standingSignature('t', ['ab', 'c']),
    standingSignature('t', ['a', 'bc']),
    'two different lists must not collide by concatenating to the same string',
  )
  // The topic is part of the same fingerprint: it and the pins are one block
  // from the agent's side, so either moving is a change worth re-delivering.
  assert.notEqual(standingSignature('t', ['a']), standingSignature('t2', ['a']), 'the topic counts too')
  assert.equal(standingSignature('t', ['a', 'b']), standingSignature('t', ['a', 'b']), 'the same state is the same')
})

test('a new thread is told the pins, and records what it was told', async () => {
  const owner = await makeUser('pin-delivery-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'pin delivery', 'the stated purpose')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addPin(reqAs(owner), chat.id, 'always check the runbook first')

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `pin-session-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((block) => block.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection

  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store)
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'hello')
  await waitForPrompts(prompts, 1)

  const envelope = prompts[0] ?? ''
  assert.match(envelope, /always check the runbook first/, 'the pin must reach the agent')
  assert.match(envelope, /standing guidance, not a new request/, 'and be marked as guidance rather than a request')
  assert.match(envelope, /the stated purpose/, 'without displacing the topic')

  // What it was told is recorded, so a later change can be recognised as one.
  const [row] = await db
    .select({ signature: groupChatThread.deliveredContextSignature })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, started.thread.id))
  assert.equal(row?.signature, model.standingSignature('the stated purpose', ['always check the runbook first']))
})

test('a chat with nothing pinned sends the envelope it sent before pins existed', async () => {
  const owner = await makeUser('pin-empty-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'no pins', 'the stated purpose')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `empty-pin-session-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((block) => block.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection

  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store)
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'hello')
  await waitForPrompts(prompts, 1)

  assert.doesNotMatch(prompts[0] ?? '', /standing guidance/, 'no pins must mean no reminder block at all')

  // But the empty set is still recorded as delivered, so the first pin added
  // afterwards reads as a change rather than as "nothing has happened yet".
  const [row] = await db
    .select({ signature: groupChatThread.deliveredContextSignature })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, started.thread.id))
  assert.equal(row?.signature, model.standingSignature('the stated purpose', []))
  assert.notEqual(row?.signature, null)
})

// THE RECORD FOLLOWS THE DELIVERY, NEVER PRECEDES IT. Both delivery paths
// write the signature only once the message carrying the context has been
// accepted. Recording it earlier would mark a thread's agent as told when the
// send threw, and nothing would tell it until something else changed — the
// quiet kind of loss, since the row looks complete either way.
test('a first prompt that fails leaves the context unrecorded, and a later send delivers it', async () => {
  const owner = await makeUser('start-failure-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'start failure', 'the purpose that must arrive')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addPin(reqAs(owner), chat.id, 'and the pin that must arrive with it')

  const prompts: string[] = []
  let failNextSession = true
  const connection = {
    newSession: async () => {
      if (failNextSession) {
        failNextSession = false
        // What an agent node being down looks like from here.
        throw new Error('agent process unavailable')
      }
      return { sessionId: `retry-session-${crypto.randomUUID()}` }
    },
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((block) => block.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection

  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store)
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  await assert.rejects(
    () => model.startThread(reqAs(owner), chat.id, 'agent-session', 'the message that never lands'),
    'a thread whose session cannot be opened must not resolve as if it had',
  )
  assert.equal(prompts.length, 0, 'nothing reached the agent')

  // The row survives the failure -- it is written before the session is opened
  // on purpose, so the thread is not lost -- but nothing may be recorded as
  // delivered through it.
  const [row] = await db
    .select({ id: groupChatThread.id, signature: groupChatThread.deliveredContextSignature })
    .from(groupChatThread)
    .where(eq(groupChatThread.groupChatId, chat.id))
  assert.ok(row, 'the thread row is kept so the thread is not silently lost')
  assert.equal(row.signature, null, 'a context that never went anywhere must not be recorded as delivered')

  // And because it is NULL rather than recorded, the ordinary once-on-change
  // path re-delivers it on the next send -- no second recovery mechanism.
  await model.sendMessageInThread(reqAs(owner), row.id, 'trying again')
  await waitForPrompts(prompts, 1)
  assert.match(prompts[0] ?? '', /the purpose that must arrive/, 'the topic reaches the agent on the retry')
  assert.match(prompts[0] ?? '', /and the pin that must arrive with it/, 'and so do the pins')

  const [after] = await db
    .select({ signature: groupChatThread.deliveredContextSignature })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, row.id))
  assert.equal(
    after?.signature,
    model.standingSignature('the purpose that must arrive', ['and the pin that must arrive with it']),
    'and now it is recorded, because this time it was accepted',
  )
})

// ---------------------------------------------------------------------------
// THE AGENT-FACING SURFACE. Gated on the CALLING agent's membership rather
// than a user's, and reaching the agent through the same delivery path a
// person's send uses.
// ---------------------------------------------------------------------------

test('an agent sees the chats it is a member of, with their threads, and no others', async () => {
  const owner = await makeUser('agent-view-owner@example.test')
  const inChat = await model.createGroupChat(reqAs(owner), 'the one it is in', 'the purpose')
  const notInChat = await model.createGroupChat(reqAs(owner), 'the one it is not in')
  await model.addMember(reqAs(owner), inChat.id, { kind: 'agent', agentNodeId: 'agent-solo' })
  await model.addMember(reqAs(owner), notInChat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: inChat.id,
      agentNodeId: 'agent-solo',
      sessionKey: `group-chat:${inChat.id}:agent-solo:view-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const chats = await model.listGroupChatsForAgentView('Agent Solo')

  // Scoped to this test's own fixtures: the file shares one database, so a
  // total count would be asserting about every other test's chats as well.
  const mine = chats.find((c) => c.ref === inChat.id)
  assert.ok(mine, 'the chat this agent was added to must be listed')
  assert.equal(mine.name, 'the one it is in')
  assert.equal(mine.topic, 'the purpose')
  assert.equal(mine.threads.length, 1)
  assert.equal(mine.threads[0]?.ref, thread.id, 'the thread reference is what a send takes back')

  assert.equal(
    chats.find((c) => c.ref === notInChat.id),
    undefined,
    'a chat this agent is not a member of must not appear',
  )
})

test('an unrecognised agent name is refused, not answered with an empty list', async () => {
  // An empty list reads as "you are in no group chats", which is an answer.
  // A caller who is not a recognised agent has not been given one.
  const refusal = await captureRefusal(() => model.listGroupChatsForAgentView('No Such Agent'))
  assert.equal(refusal.code, 'not-found')
})

test('an agent can send into a thread of a chat it is in, through the shared delivery path', async () => {
  const owner = await makeUser('agent-send-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'delegation', 'the standing purpose')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-solo' })
  await model.addPin(reqAs(owner), chat.id, 'the pin that rides along')

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `agent-send-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((b) => b.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection

  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store)
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  // A person starts the thread; the delivering agent is a DIFFERENT member.
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)

  await model.sendMessageInThreadAsAgent('Agent Solo', started.thread.id, '  please review the change  ')
  await waitForPrompts(prompts, 2)

  assert.match(prompts[1] ?? '', /please review the change/, 'the message reaches the thread agent')
  assert.doesNotMatch(prompts[1] ?? '', / {2}please/, 'and is trimmed')
})

test('an agent cannot send into a thread of a chat it is not in, and cannot tell that from a bad reference', async () => {
  const owner = await makeUser('agent-gate-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'not for you')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:gate-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  // 'Agent Solo' is a real agent, and not a member of this chat.
  const outsider = await captureRefusal(() => model.sendMessageInThreadAsAgent('Agent Solo', thread.id, 'hello'))
  const fabricated = await captureRefusal(() =>
    model.sendMessageInThreadAsAgent('Agent Solo', crypto.randomUUID(), 'hello'),
  )

  assert.equal(outsider.code, 'not-found')
  // Identical, so a reference is not a way to learn which threads exist.
  assert.equal(fabricated.code, outsider.code)
  assert.equal(fabricated.message, outsider.message)
})

// THE DELEGATION CASE, and the reason the anti-loop rule is written the way it
// is: an agent sending into a thread whose agent is ITSELF is allowed, because
// that is how work reaches a fresh-context instance of the same agent.
test('an agent may send into a thread whose agent is itself', async () => {
  const owner = await makeUser('self-delegate-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'self delegation', 'review the queue')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `self-delegate-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((b) => b.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection

  const workspaceSlug = slug('Agent Session')
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', workspaceSlug),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store)
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)

  // Same agent on both ends: the sender and the thread's agent.
  await model.sendMessageInThreadAsAgent('Agent Session', started.thread.id, 'take the next review')
  await waitForPrompts(prompts, 2)
  assert.match(prompts[1] ?? '', /take the next review/)
})

test('a removed agent cannot be reached by an agent sender either', async () => {
  const owner = await makeUser('agent-removed-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'removal holds both ways')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-solo' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:removed-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  await model.removeMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  // The sender is still a member; the thread's agent is not. The rule lives in
  // the shared delivery path, so it holds for whoever is sending.
  const refusal = await captureRefusal(() => model.sendMessageInThreadAsAgent('Agent Solo', thread.id, 'still there?'))
  assert.equal(refusal.code, 'agent-not-a-member')
})
