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
import { handleUpdate } from 'agent-client/agent-client'
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

const {
  db,
  space,
  groupChat,
  groupChatMember,
  groupChatPin,
  groupChatSlugAlias,
  groupChatThread,
  groupChatThreadAlias,
  groupChatThreadArtifact,
} = await import('@opencroft/db')
const model = await import('./model')
// Dynamic like the rest: it reads and writes the settings table, so importing
// it statically would touch the database before PGLITE_PATH is set above.
const sessionStore = await import('@/app/_authed/(agent)/_server/acp-session-store')
// The live session registry a rename has to carry the session across -- same
// singleton the app uses, imported dynamically for the same reason as above.
const { agentClient } = await import('@/app/_authed/(agent)/_server/agent-client-instance')
const { ensureAuth } = await import('@opencroft/auth/server')
// The production wiring this test process never runs (it imports model.ts
// directly, not through server.ts's ensureServerStarted) — see
// server/startup.ts for the real registration. Without this, a group-chat
// sessionKey resolves to nothing and every compactThread call below throws
// "No agent/job resolved for session" before performCompact ever runs.
const { registerSessionWakeResolver, registerStandingContextResolver } = await import(
  '@/app/_authed/(extension-runtime)/_server/stream'
)
registerStandingContextResolver(model.groupChatStandingContext)
// Same reason, for waking an offline thread ahead of a compact — without
// this, every offline-compact test below throws "Session cannot be resumed"
// before requestCompactOnGraph's graph-vs-resolver fallback ever gets a
// group-chat answer.
registerSessionWakeResolver(model.groupChatWakeSession)

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
      // These two carry a full provider/adapter/model triple, unlike the three
      // above, so `ensureLocalSessionImpl` can build a real AgentSelection for
      // them and the tests below can open actual sessions against seeded mock
      // connections. Two of them, because a mock connection is keyed on the
      // agent's own spawn config: telling "the addressed agent received it"
      // apart from "an agent received it" needs two separate inboxes.
      {
        id: 'agent-session',
        type: 'agent',
        data: { name: 'Agent Session', providerId: 'test-provider', adapterId: 'openclaw', model: 'test-model' },
      },
      {
        id: 'agent-session-2',
        type: 'agent',
        data: { name: 'Agent Session Two', providerId: 'test-provider', adapterId: 'openclaw', model: 'test-model' },
      },
      // TWO NODES, ONE NAME. Nothing makes agent node names unique, and a
      // session key's agent segment is `slugify(name)` -- so these two mint the
      // same segment, which is what lets a rename pass a check scoped to
      // (chat, agent, slug) and still target a key another thread holds.
      {
        id: 'agent-twin-a',
        type: 'agent',
        data: { name: 'Twin Agent', providerId: 'test-provider', adapterId: 'openclaw', model: 'test-model' },
      },
      {
        id: 'agent-twin-b',
        type: 'agent',
        data: { name: 'Twin Agent', providerId: 'test-provider', adapterId: 'openclaw', model: 'test-model' },
      },
      // Wired into `agent-a` below. A thread's standing context has to carry
      // the agent's OWN instruction nodes, not just the chat's topic and
      // pins — that is the whole point of the edge existing.
      { id: 'instr-a', type: 'agent-instruction', data: { name: 'Tone', instruction: 'Answer in English.' } },
      { id: 'instr-blank', type: 'agent-instruction', data: { name: 'Blank', instruction: '   ' } },
    ],
    edges: [
      { id: 'e-instr-a', source: 'instr-a', target: 'agent-a', targetHandle: 'instructions-in' },
      { id: 'e-instr-blank', source: 'instr-blank', target: 'agent-a', targetHandle: 'instructions-in' },
    ],
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

// A group-chat thread is an ordinary session with its agent, so it must carry
// that agent's own instruction nodes — the same blocks a 1:1 chat and a
// send-message node both deliver. This was the ONE surface that dropped them:
// standing context was assembled from the chat alone, so an agent whose
// identity lives on instruction nodes woke up in a thread without any of it,
// silently. Pinned here because nothing else fails when it regresses.
test("a thread's standing context carries the agent's own instruction nodes", async () => {
  const owner = await makeUser('instr-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'instruction delivery')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:instructions`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const standing = await model.groupChatStandingContext(thread.sessionKey)
  assert.ok(standing, 'a real thread key must resolve to standing context')
  assert.ok(
    standing.instructions.includes('Answer in English.'),
    `the agent's wired instruction must be delivered, got: ${JSON.stringify(standing.instructions)}`,
  )
  // Whitespace-only instruction nodes contribute nothing rather than an empty
  // block, matching how the envelope already treats a blank instruction.
  assert.equal(
    standing.instructions.some((text) => text.trim().length === 0),
    false,
    'a blank instruction node must not become an empty block',
  )
  // In the signature too, so editing an instruction node re-delivers on the
  // next message exactly as editing a pin does.
  assert.ok(standing.signature.includes('Answer in English.'), 'the instruction must take part in the signature')
})

test("an agent's instructions are absent from a thread whose agent has none wired", async () => {
  const owner = await makeUser('instr-owner2@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'no instruction delivery')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-b' })

  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-b',
      sessionKey: `group-chat:${chat.id}:agent-b:no-instructions`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const standing = await model.groupChatStandingContext(thread.sessionKey)
  assert.ok(standing)
  assert.deepEqual(standing.instructions, [], 'an agent with nothing wired contributes nothing')
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
    () => model.sendMessageInThread(reqAs(outsider), thread.id, 'let me in', { queue: 'wait' }),
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

  const refusal = await captureRefusal(() =>
    model.sendMessageInThread(reqAs(outsider), thread.id, 'let me in', { queue: 'wait' }),
  )
  assert.equal(refusal.code, 'not-found')

  // And a fabricated thread id refuses identically, so sending is not a way to
  // probe which threads exist either.
  const fabricated = await captureRefusal(() =>
    model.sendMessageInThread(reqAs(outsider), crypto.randomUUID(), 'hello', { queue: 'wait' }),
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
// CLEAR. Same membership gate as delete (found first, then the same single
// refusal for a missing thread and a non-member), but the row survives --
// that's the one thing worth pinning here beyond "the gate works", since
// forgetLocalSessionImpl's own teardown correctness is already covered by
// the delete-ordering test above (same primitive, both call it the same way).
// No mock ACP connection needed: a thread with no live session started for
// it (inserted directly, the same fixture pattern the draft/removal tests
// below use) exercises forgetLocalSessionImpl's own no-entry guard, which is
// exactly what a thread that was never opened, or was already idle, hits in
// practice -- clearSession has to be safe to call in that state, not only
// when there happens to be a live process to tear down.
// ---------------------------------------------------------------------------
test('a member can clear a thread and the row survives; a non-member is refused and nothing is torn down', async () => {
  const owner = await makeUser('clear-owner@example.test')
  const outsider = await makeUser('clear-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'clear guard')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:clear-guard-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const refusal = await captureRefusal(() => model.clearThread(reqAs(outsider), thread.id))
  assert.equal(refusal.code, 'not-found')
  const untouched = await db.select().from(groupChatThread).where(eq(groupChatThread.id, thread.id))
  assert.equal(untouched.length, 1, 'a refused clear must not touch the row')

  await model.clearThread(reqAs(owner), thread.id)
  const survives = await db.select().from(groupChatThread).where(eq(groupChatThread.id, thread.id))
  assert.equal(
    survives.length,
    1,
    'unlike deleteThread, the row survives -- the thread reopens onto a fresh session next access, it does not disappear',
  )

  // A fabricated thread id refuses identically, so clearing is not a way to
  // probe which threads exist either -- same property sendMessageInThread's
  // own test asserts for sends.
  const fabricated = await captureRefusal(() => model.clearThread(reqAs(outsider), crypto.randomUUID()))
  assert.equal(fabricated.code, refusal.code)
})

// ---------------------------------------------------------------------------
// DELETING THE CHAT ITSELF.
//
// The ordering property `deleteThread` has, one level up and multiplied: a
// chat delete drops EVERY thread row at once by cascade, so a teardown that
// has not finished when the rows go leaves one stranded agent process per
// thread, none of them reachable from any screen. Asserted the same way the
// single-thread test asserts it -- from inside the mock connection's own
// `closeSession`, which is the last thing forgetLocalSessionImpl drives before
// returning. If the rows are still readable at that moment, teardown ran
// first.
//
// TWO threads, on two different agents: one would not distinguish "tears down
// every thread" from "tears down the first one and then deletes". Two agents
// rather than two threads on one, because a mock connection is keyed on the
// agent's own spawn config, so two agents is what gives two observable
// teardowns.
// ---------------------------------------------------------------------------
test('deleteGroupChat tears down every thread session before the rows they are reachable through go', async () => {
  const owner = await makeUser('chat-delete-order-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'chat delete ordering')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session-2' })

  let closeSessionCalls = 0
  let rowsVisibleDuringEveryTeardown = true
  let chatVisibleDuringEveryTeardown = true

  const observingConnection = () =>
    ({
      newSession: async () => ({ sessionId: `test-session-${crypto.randomUUID()}` }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
      cancel: async () => {},
      setSessionConfigOption: async () => ({}),
      closeSession: async () => {
        closeSessionCalls += 1
        // Read the tables directly rather than through the model: the
        // observation is of the rows themselves, not of a membership-gated
        // view of them.
        const threadRows = await db.select().from(groupChatThread).where(eq(groupChatThread.groupChatId, chat.id))
        if (threadRows.length !== 2) {
          rowsVisibleDuringEveryTeardown = false
        }
        const chatRows = await db.select().from(groupChat).where(eq(groupChat.id, chat.id))
        if (chatRows.length !== 1) {
          chatVisibleDuringEveryTeardown = false
        }
        return {}
      },
    }) as unknown as AgentConnection

  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  for (const agentName of ['Agent Session', 'Agent Session Two']) {
    const selection: AgentSelection = {
      providerId: 'test-provider',
      adapterId: 'openclaw',
      model: 'test-model',
      apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
      cwd: join(process.cwd(), 'data', 'agent-workspace', slug(agentName)),
      baseUrl: process.env.OPENCLAW_GATEWAY_URL,
    }
    store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
      connection: observingConnection(),
      lastSessionId: null,
      loadSession: false,
      initialized: Promise.resolve(),
    })
  }

  await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first')
  await model.startThread(reqAs(owner), chat.id, 'agent-session-2', 'second')

  await model.deleteGroupChat(reqAs(owner), chat.id)

  assert.equal(closeSessionCalls, 2, 'every thread’s session must be torn down, not just the first')
  assert.equal(
    rowsVisibleDuringEveryTeardown,
    true,
    'every thread row must still exist while any session is being torn down — otherwise a teardown failure strands live agent processes nothing can reach',
  )
  assert.equal(chatVisibleDuringEveryTeardown, true, 'and so must the chat, since its cascade is what drops them')

  const threadsAfter = await db.select().from(groupChatThread).where(eq(groupChatThread.groupChatId, chat.id))
  assert.equal(threadsAfter.length, 0, 'and the threads are gone once the delete completes')
  const chatAfter = await db.select().from(groupChat).where(eq(groupChat.id, chat.id))
  assert.equal(chatAfter.length, 0, 'as is the chat')
})

// ---------------------------------------------------------------------------
// The gate, and the cascade. The cascade half is asserted rather than trusted
// to the schema: the question is specifically whether artifacts, pins and
// membership rows go with the chat or are left orphaned, and a foreign key
// that says `cascade` in schema.ts is only the answer if the migration that
// built the table agrees. This test runs against the real migrated database,
// so it is the two of them agreeing that passes it.
// ---------------------------------------------------------------------------
test('a non-member cannot delete a chat, and a member’s delete leaves no pin, member, thread or artifact behind', async () => {
  const owner = await makeUser('chat-delete-owner@example.test')
  const outsider = await makeUser('chat-delete-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'cascade check')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  await model.addPin(reqAs(owner), chat.id, 'a pinned note')
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:cascade-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)
  await db.insert(groupChatThreadArtifact).values({ threadId: thread.id, title: 'note', content: 'body' })

  const refusal = await captureRefusal(() => model.deleteGroupChat(reqAs(outsider), chat.id))
  assert.equal(refusal.code, 'not-found')
  const untouched = await db.select().from(groupChat).where(eq(groupChat.id, chat.id))
  assert.equal(untouched.length, 1, 'a refused delete must not touch the chat')

  // A fabricated id refuses identically, so deleting is not a way to probe
  // which chats exist -- the same property the read and send paths assert.
  const fabricated = await captureRefusal(() => model.deleteGroupChat(reqAs(outsider), crypto.randomUUID()))
  assert.equal(fabricated.code, refusal.code)

  await model.deleteGroupChat(reqAs(owner), chat.id)

  assert.equal((await db.select().from(groupChat).where(eq(groupChat.id, chat.id))).length, 0, 'chat')
  assert.equal(
    (await db.select().from(groupChatMember).where(eq(groupChatMember.groupChatId, chat.id))).length,
    0,
    'membership rows cascade',
  )
  assert.equal(
    (await db.select().from(groupChatPin).where(eq(groupChatPin.groupChatId, chat.id))).length,
    0,
    'pins cascade',
  )
  assert.equal(
    (await db.select().from(groupChatThread).where(eq(groupChatThread.groupChatId, chat.id))).length,
    0,
    'threads cascade',
  )
  assert.equal(
    (await db.select().from(groupChatThreadArtifact).where(eq(groupChatThreadArtifact.threadId, thread.id))).length,
    0,
    'and a thread’s artifacts cascade with the thread — nothing is orphaned',
  )
})

// ---------------------------------------------------------------------------
// A THREAD STARTED WHILE THE DELETE IS RUNNING.
//
// Tearing a session down reaches a subprocess, so the loop is a real window,
// and a thread started inside it lands in a chat that is about to be deleted.
// Read the thread list once at the top and that thread's session is never torn
// down while the cascade removes its row moments later -- the stranded process
// the ordering rule exists to prevent, reached from the other direction.
//
// The window is simulated exactly rather than approximated: the mock
// connection's `closeSession` IS the middle of forgetLocalSessionImpl, so
// inserting a row there is a thread arriving mid-teardown. It is given a
// session key that already has a live session, so its teardown is observable
// as a third closeSession call rather than having to be inferred.
// ---------------------------------------------------------------------------
test('deleteGroupChat drains threads started while it is tearing down, instead of stranding them', async () => {
  const owner = await makeUser('chat-delete-drain-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'drain race')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const stragglerKey = `group-chat:${chat.id}:agent-session:arrived-late`
  let closeSessionCalls = 0
  let inserted = false

  const connection = {
    newSession: async () => ({ sessionId: `test-session-${crypto.randomUUID()}` }),
    prompt: async () => ({ stopReason: 'end_turn' }),
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => {
      closeSessionCalls += 1
      // Exactly once, on the first teardown: a second member starts a thread
      // in this chat while the delete is mid-flight.
      if (!inserted) {
        inserted = true
        await db.insert(groupChatThread).values({
          groupChatId: chat.id,
          agentNodeId: 'agent-session',
          sessionKey: stragglerKey,
          slug: 'arrived-late',
          createdByUserId: owner.id,
        })
      }
      return {}
    },
  } as unknown as AgentConnection

  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', slug('Agent Session')),
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

  await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first')
  // The straggler's session, opened ahead of time under the key the row
  // inserted mid-teardown will carry -- so there is a real session for the
  // drain pass to tear down, and closeSession fires when it does.
  const { ensureLocalSessionImpl } = await import('@/app/_authed/(agent)/_server/acp-impl')
  await ensureLocalSessionImpl({ agentNodeId: 'agent-session', jobNodeId: '', tabKey: stragglerKey })

  await model.deleteGroupChat(reqAs(owner), chat.id)

  assert.equal(inserted, true, 'the test must actually have inserted a thread mid-teardown')
  assert.equal(
    closeSessionCalls,
    2,
    'the original thread and the straggler that arrived during its teardown — a loop that read the thread list once tears down only the original, leaving the straggler’s live session to be cascaded away underneath it',
  )
  assert.equal(
    (await db.select().from(groupChatThread).where(eq(groupChatThread.groupChatId, chat.id))).length,
    0,
    'and everything, straggler included, is gone',
  )
})

// ---------------------------------------------------------------------------
// A SESSION RE-CREATED AFTER ITS THREAD WAS TORN DOWN.
//
// The drain covers a thread that did not exist when the loop started. It
// cannot cover this: an EXISTING thread, already torn down, whose session a
// delivery re-opens while the loop is still working through the others. Every
// delivery path resolves the thread row first, and the rows survive until the
// cascade, so that re-creation is reachable for the whole remainder of the
// delete -- and `tornDown` filters the key out of every later pass by design,
// so no amount of draining revisits it. Without the post-cascade sweep the
// cascade then removes the row underneath a live session: a running agent
// process plus a fresh durable pointer, reachable from nothing.
//
// Simulated at the point it really happens: `closeSession` is the middle of
// forgetLocalSessionImpl, so re-opening the FIRST thread's session from inside
// the SECOND thread's teardown is exactly a delivery landing mid-delete.
// ---------------------------------------------------------------------------
test('deleteGroupChat sweeps a session re-created after its own thread was torn down', async () => {
  const owner = await makeUser('chat-delete-recreate-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'recreate race')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session-2' })

  const { ensureLocalSessionImpl, findTargetSessionImpl } = await import('@/app/_authed/(agent)/_server/acp-impl')

  let firstKey = ''
  let reopened = false
  let closeSessionCalls = 0

  const connectionFor = (agentNodeId: string) =>
    ({
      newSession: async () => ({ sessionId: `test-session-${crypto.randomUUID()}` }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
      cancel: async () => {},
      setSessionConfigOption: async () => ({}),
      closeSession: async () => {
        closeSessionCalls += 1
        // While tearing down the SECOND thread, a delivery arrives for the
        // FIRST -- whose row is still there, because nothing is deleted until
        // the cascade -- and re-opens its session.
        if (agentNodeId === 'agent-session-2' && !reopened) {
          reopened = true
          await ensureLocalSessionImpl({ agentNodeId: 'agent-session', jobNodeId: '', tabKey: firstKey })
        }
        return {}
      },
    }) as unknown as AgentConnection

  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  for (const [agentNodeId, agentName] of [
    ['agent-session', 'Agent Session'],
    ['agent-session-2', 'Agent Session Two'],
  ] as const) {
    const selection: AgentSelection = {
      providerId: 'test-provider',
      adapterId: 'openclaw',
      model: 'test-model',
      apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
      cwd: join(process.cwd(), 'data', 'agent-workspace', slug(agentName)),
      baseUrl: process.env.OPENCLAW_GATEWAY_URL,
    }
    store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
      connection: connectionFor(agentNodeId),
      lastSessionId: null,
      loadSession: false,
      initialized: Promise.resolve(),
    })
  }

  const first = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first')
  firstKey = first.thread.sessionKey
  await model.startThread(reqAs(owner), chat.id, 'agent-session-2', 'second')

  await model.deleteGroupChat(reqAs(owner), chat.id)

  assert.equal(reopened, true, 'the test must actually have re-created a session mid-delete')
  assert.equal(
    await findTargetSessionImpl({ baseKey: firstKey }),
    null,
    'the re-created session must not survive the delete — its thread row is gone, so nothing could ever reach it again to shut it down',
  )
  // The sweep is what closes it, so it shows up as an extra teardown beyond
  // the two threads' own.
  assert.ok(
    closeSessionCalls >= 3,
    `the sweep must actually tear the re-created session down (saw ${closeSessionCalls})`,
  )
})

// ---------------------------------------------------------------------------
// THE ROWS THAT REAL DATABASES HOLD, not the tidy ones a fixture builds.
//
// `slug` is nullable on both GroupChatThread and GroupChatThreadAlias, and
// deliberately so: threads predating slugs have none and keep resolving on
// their original uuid-shaped session keys, and the unique indexes rely on
// Postgres treating NULLs as distinct so any number of them coexist. Real data
// holds exactly this -- scratch chats with null-slug threads on old-shape keys,
// and a thread-alias row whose slug is null (and whose sessionKey may be too).
//
// So the delete has to be indifferent to slug and to key SHAPE. It is, by
// construction rather than by care: it selects `sessionKey` (which is notNull)
// and nothing else, and hands it to forgetLocalSessionImpl, which uses it as an
// opaque map key and no-ops when there is no entry -- nothing anywhere parses a
// group-chat key. This test is what stops that quietly stopping being true.
//
// A legacy thread and a modern one in the SAME chat, because a delete that
// coped with only one shape at a time would still be broken for a real chat.
// ---------------------------------------------------------------------------
test('deleteGroupChat copes with legacy null-slug threads on old-shape session keys', async () => {
  const owner = await makeUser('chat-delete-legacy-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'legacy shapes')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  // Pre-slug: no slug, no title, and a session key that is a bare uuid rather
  // than the `group-chat:<chat>:<agent>:<slug>` form current code mints.
  const legacyKey = crypto.randomUUID()
  const [legacy] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: legacyKey,
      slug: null,
      title: null,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(legacy)

  // A second legacy row, to prove the null-slug unique index really does admit
  // more than one of them -- if it did not, a chat like this could not exist
  // and the rest of this test would be theatre.
  const [legacyTwo] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-b',
      sessionKey: crypto.randomUUID(),
      slug: null,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(legacyTwo, 'two null-slug threads must be able to coexist in one chat')

  const [modern] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-solo',
      sessionKey: `group-chat:${chat.id}:agent-solo:tidy`,
      slug: 'tidy',
      title: 'Tidy',
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(modern)

  // The freed-address row seen in real data: null slug AND null sessionKey.
  await db.insert(groupChatThreadAlias).values({
    threadId: legacy.id,
    groupChatId: chat.id,
    agentNodeId: 'agent-a',
    sessionKey: null,
    slug: null,
  })
  await db.insert(groupChatThreadArtifact).values({ threadId: legacy.id, title: 'old note', content: 'body' })

  // The whole point: this must not throw on the legacy rows.
  await model.deleteGroupChat(reqAs(owner), chat.id)

  assert.equal((await db.select().from(groupChat).where(eq(groupChat.id, chat.id))).length, 0, 'the chat is gone')
  assert.equal(
    (await db.select().from(groupChatThread).where(eq(groupChatThread.groupChatId, chat.id))).length,
    0,
    'both legacy threads and the modern one go together',
  )
  assert.equal(
    (await db.select().from(groupChatThreadAlias).where(eq(groupChatThreadAlias.groupChatId, chat.id))).length,
    0,
    'and the null-slug alias row cascades rather than being left pointing at a thread that no longer exists',
  )
  assert.equal(
    (await db.select().from(groupChatThreadArtifact).where(eq(groupChatThreadArtifact.threadId, legacy.id))).length,
    0,
    'as do a legacy thread’s artifacts',
  )
})

test('a member can save and clear a thread draft; a non-member is refused and changes nothing', async () => {
  const owner = await makeUser('draft-owner@example.test')
  const outsider = await makeUser('draft-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'draft guard')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:draft-guard-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const refusal = await captureRefusal(() => model.setThreadDraft(reqAs(outsider), thread.id, 'sneaked in'))
  assert.equal(refusal.code, 'not-found')
  const untouched = await model.getThread(reqAs(owner), thread.id)
  assert.equal(untouched.draft, null, 'a refused write must not have reached the row')

  await model.setThreadDraft(reqAs(owner), thread.id, 'work in progress')
  const saved = await model.getThread(reqAs(owner), thread.id)
  assert.equal(saved.draft, 'work in progress')

  await model.setThreadDraft(reqAs(owner), thread.id, '')
  const cleared = await model.getThread(reqAs(owner), thread.id)
  assert.equal(cleared.draft, '', 'an empty string clears it, the same as the 1:1 chat')
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
  const refusal = await captureRefusal(() =>
    model.sendMessageInThread(reqAs(owner), thread.id, 'still there?', { queue: 'wait' }),
  )
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
  await sessionStore.writePersistedSession(sessionKey, 'persisted-session-id', true)

  await model.removeMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  assert.deepEqual(
    await sessionStore.readPersistedSession(sessionKey),
    { id: 'persisted-session-id', prompted: true },
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

  const refusal = await captureRefusal(() =>
    model.sendMessageInThread(reqAnonymous(), thread.id, 'hello', { queue: 'wait' }),
  )
  assert.equal(refusal.code, 'unauthenticated')
})

// `promptLocalImpl` hands the message to the client's queue and returns; the
// queue then dispatches to the connection without the caller awaiting it (see
// agent-client's `void connection.prompt(..., { queue: 'wait' })`). So a test that inspects what
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
  const chat = await model.createGroupChat(reqAs(owner), 'Release train explicit topic', 'Ship it without regressions')

  assert.equal(chat.name, 'Release train explicit topic')
  assert.equal(chat.topic, 'Ship it without regressions')
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
  await model.sendMessageInThread(reqAs(owner), first.thread.id, 'an ordinary message', { queue: 'wait' })
  await waitForPrompts(prompts, 2)
  assert.doesNotMatch(prompts[1] ?? '', /the first purpose/, 'unchanged context is not restated on every turn')

  await model.setGroupChatTopic(reqAs(owner), chat.id, 'the second purpose')

  await model.sendMessageInThread(reqAs(owner), first.thread.id, 'a message after the edit', { queue: 'wait' })
  await waitForPrompts(prompts, 3)
  assert.match(prompts[2] ?? '', /the second purpose/, 'the change rides the next message into the open thread')

  // ONCE. The thread has now been told, so the message after it is plain again.
  await model.sendMessageInThread(reqAs(owner), first.thread.id, 'and one more', { queue: 'wait' })
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
  await model.sendMessageInThread(reqAs(owner), thread.thread.id, 'after pinning', { queue: 'wait' })
  await waitForPrompts(prompts, 2)
  assert.match(prompts[1] ?? '', /do not deploy on a Friday/, 'a new pin reaches the open thread')

  // And unpinning everything is itself a change: the block goes away, and the
  // thread is not told about pins it no longer has.
  await model.removePin(reqAs(owner), pin.id)
  await model.sendMessageInThread(reqAs(owner), thread.thread.id, 'after unpinning', { queue: 'wait' })
  await waitForPrompts(prompts, 3)
  assert.doesNotMatch(prompts[2] ?? '', /do not deploy on a Friday/, 'an unpinned note stops being delivered')
  assert.doesNotMatch(prompts[2] ?? '', /standing guidance/, 'and no empty reminder block is sent in its place')
})

// ---------------------------------------------------------------------------
// COMPACTION. Before this, `group-chat:<chatId>:<agent>:<uuid>` session keys
// could not be compacted at all: `requestCompactOnGraph` resolved sessions
// via `parseSessionKey`'s `/^agent:.../` regex plus graph reachability, and a
// group-chat key matches neither, so it threw "No agent/job resolved for
// session" before `performCompact` ever ran.
// ---------------------------------------------------------------------------

test('a group-chat thread can be compacted at all', async () => {
  const owner = await makeUser('compact-basic-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'compact basics', 'the starting topic')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `compact-basic-session-${crypto.randomUUID()}` }),
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

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)

  const ack = await model.compactThread(reqAs(owner), started.thread.id)
  assert.equal(ack.accepted, true, 'the group-chat: key must resolve instead of throwing before performCompact runs')

  await waitForPrompts(prompts, 3) // opening, then '/compact', then the restore
  assert.equal(prompts[1], '/compact')
  assert.match(prompts[2] ?? '', /the starting topic/, 'the restore re-delivers the thread standing context')

  const status = await model.threadCompactStatus(reqAs(owner), started.thread.id)
  assert.equal(status.state, 'done')
  assert.equal(status.result?.instructionsRestored, true)
})

// THE POINT OF THE POST-COMPACTION DELIVERY POINT IN THE STANDING-CONTEXT
// ARCHITECTURE: the restore re-assembles standing context FROM CURRENT STATE
// at restore time, not from whatever the thread was told when it opened — so
// a topic/pin change the once-on-change path has not delivered yet still
// survives a compaction that lands in between.
test('compaction restores CURRENT topic and pins, not what the thread was told when it opened', async () => {
  const owner = await makeUser('compact-current-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'compact current', 'topic one')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `compact-current-session-${crypto.randomUUID()}` }),
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

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)
  assert.match(prompts[0] ?? '', /topic one/)

  // Changed WITHOUT an intervening send, so the once-on-change path has not
  // reached the thread yet — as far as it knows, the topic is still "topic
  // one" and it has never heard of this pin.
  await model.setGroupChatTopic(reqAs(owner), chat.id, 'topic two')
  await model.addPin(reqAs(owner), chat.id, 'a note pinned after the thread opened')

  const ack = await model.compactThread(reqAs(owner), started.thread.id)
  assert.equal(ack.accepted, true)

  await waitForPrompts(prompts, 3)
  assert.equal(prompts[1], '/compact')
  assert.match(
    prompts[2] ?? '',
    /topic two/,
    'the restore reads current state, not what was true when the thread opened',
  )
  assert.match(prompts[2] ?? '', /a note pinned after the thread opened/)
  assert.doesNotMatch(prompts[2] ?? '', /topic one/)
})

test('compactThread is refused for a non-member the same way sendMessageInThread is', async () => {
  const owner = await makeUser('compact-nonmember-owner@example.test')
  const outsider = await makeUser('compact-nonmember-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'compact non-member')
  await db.insert(groupChatMember).values({ groupChatId: chat.id, principalType: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:compact-nonmember-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const refusal = await captureRefusal(() => model.compactThread(reqAs(outsider), thread.id))
  assert.equal(refusal.code, 'not-found')
})

test("compactThread is refused once the thread's agent is no longer a member", async () => {
  const owner = await makeUser('compact-agent-removed-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'compact agent removed')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:compact-agent-removed-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  await model.removeMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  const refusal = await captureRefusal(() => model.compactThread(reqAs(owner), thread.id))
  assert.equal(refusal.code, 'agent-not-a-member')
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
  await model.sendMessageInThread(reqAs(owner), row.id, 'trying again', { queue: 'wait' })
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
    mine.threads[0]?.contextUsage,
    null,
    'a thread whose session has never been loaded reports unknown usage, not zero',
  )

  assert.equal(
    chats.find((c) => c.ref === notInChat.id),
    undefined,
    'a chat this agent is not a member of must not appear',
  )
})

test("a thread's contextUsage mirrors its session's own usage, the same source the ring renders", async () => {
  const owner = await makeUser('context-usage-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'watched for size', 'stay small')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  seedMockConnection(prompts)
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)

  const expectedRef = started.thread.sessionKey.slice('group-chat:'.length)
  const before = (await model.listGroupChatsForAgentView('Agent Session'))
    .find((c) => c.ref === chat.id)
    ?.threads.find((t) => t.ref === expectedRef)
  assert.equal(before?.contextUsage, null, 'no usage_update has landed yet')

  handleUpdate({
    sessionId: started.sessionId,
    update: { sessionUpdate: 'usage_update', used: 12_345, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])

  const after = (await model.listGroupChatsForAgentView('Agent Session'))
    .find((c) => c.ref === chat.id)
    ?.threads.find((t) => t.ref === expectedRef)
  assert.deepEqual(
    after?.contextUsage,
    { usedTokens: 12_345, contextLimit: null },
    // The tokens are the thread's own session's, via the same mechanism
    // ordinary sessions use — that is what this test is for, and it still
    // holds. The window is null because this fixture's agent has no configured
    // context window and the session is bridged, so the 200_000 it reported is
    // a figure nobody established: agent-client withholds it rather than let a
    // ratio be drawn against it (see context-window.ts). Configure a window on
    // the agent to get a percentage back.
    "the exact token figure the thread's own session reported; its window is withheld as unverified",
  )
  assert.equal(after?.queuedMessages, 0, 'an idle thread holds no server-side prompts — 0 is a fact, not unknown')
})

test('an offline thread with prior activity reports its last-known usage with asOf, not null', async () => {
  const owner = await makeUser('offline-usage-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'went offline', 'stay small')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  const sessionKey = `group-chat:${chat.id}:agent-a:offline-usage-fixture`
  const [thread] = await db
    .insert(groupChatThread)
    .values({ groupChatId: chat.id, agentNodeId: 'agent-a', sessionKey, createdByUserId: owner.id })
    .returning()
  assert.ok(thread)

  // What a real prior turn on this session would have left behind: a durable
  // pointer (agentClient never holds this session in memory in this test, so
  // it is genuinely offline) and the usage it last reported.
  await sessionStore.writePersistedSession(sessionKey, 'offline-usage-session-id', true)
  await sessionStore.writePersistedUsage('offline-usage-session-id', { used: 88_000, size: 200_000 })

  const chats = await model.listGroupChatsForAgentView('Agent A')
  const found = chats.find((c) => c.ref === chat.id)?.threads.find((t) => t.ref === thread.id)
  assert.ok(found?.contextUsage, 'an offline thread with a persisted reading must not report null')
  assert.equal(found.contextUsage.usedTokens, 88_000)
  assert.equal(
    found.contextUsage.contextLimit,
    null,
    // The persisted 200_000 was written by an earlier session from its harness's
    // own report. Reading it back does not make it verifiable, so the offline
    // path resolves the window from the agent's configured one instead -- and
    // this fixture's agent has none. The tokens still come back, which is what
    // this test is for; the window is the one thing an offline reading cannot
    // establish for itself.
    'a persisted size is not an authority: the window comes from the agent config or not at all',
  )
  assert.equal(
    typeof found.contextUsage.asOf,
    'number',
    'asOf marks this as a last-known reading, distinct from a live one',
  )
})

test("a thread's recent turns are readable by a member agent, via the same core the send-message listTurns uses", async () => {
  const owner = await makeUser('thread-turns-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'watched for turns', 'stay observable')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  seedMockConnection(prompts)
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message for turns')
  await waitForPrompts(prompts, 1)

  const ref = started.thread.sessionKey.slice('group-chat:'.length)
  const page = await model.listThreadTurnsAsAgent('Agent Session', ref)
  assert.ok(page.turns.length >= 1, 'the opening delivery is a visible turn')
  const first = page.turns[0]
  assert.ok(
    first.prompt.includes('opening message for turns'),
    `the turn summary carries the delivered prompt (got: ${first.prompt.slice(0, 120)})`,
  )
  assert.ok(
    ['finished', 'in-progress', 'interrupted', 'unknown'].includes(first.status),
    'status is one of the listTurns statuses',
  )
  assert.equal(typeof page.hasMore, 'boolean')
})

test('thread turns are refused for a non-member agent and for a fabricated ref, indistinguishably', async () => {
  const owner = await makeUser('thread-turns-refusal@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'private turns', 'keep out')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  const prompts: string[] = []
  seedMockConnection(prompts)
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'members only')
  await waitForPrompts(prompts, 1)
  const ref = started.thread.sessionKey.slice('group-chat:'.length)

  await assert.rejects(
    () => model.listThreadTurnsAsAgent('Outsider Agent', ref),
    /./,
    'a non-member (or unknown) agent is refused',
  )
  await assert.rejects(
    () => model.listThreadTurnsAsAgent('Agent Session', 'bogus:fake:thread'),
    /not.found|not available/i,
    'a fabricated ref is refused the same way',
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

  await model.sendMessageInThreadAsAgent('Agent Solo', started.thread.id, '  please review the change  ', 'wait')
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
  const outsider = await captureRefusal(() =>
    model.sendMessageInThreadAsAgent('Agent Solo', thread.id, 'hello', 'wait'),
  )
  const fabricated = await captureRefusal(() =>
    model.sendMessageInThreadAsAgent('Agent Solo', crypto.randomUUID(), 'hello', 'wait'),
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
  await model.sendMessageInThreadAsAgent('Agent Session', started.thread.id, 'take the next review', 'wait')
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
  const refusal = await captureRefusal(() =>
    model.sendMessageInThreadAsAgent('Agent Solo', thread.id, 'still there?', 'wait'),
  )
  assert.equal(refusal.code, 'agent-not-a-member')
})

// ---------------------------------------------------------------------------
// compactThreadAsAgent / threadCompactStatusAsAgent — the tool-surface
// counterparts to compactThread/threadCompactStatus, gated on the calling
// agent's own membership (via resolveThreadForAgent) instead of a signed-in
// user's. Success-path behaviour (accept, run '/compact', restore standing
// context) is exercised in depth by compactThread's own tests above; these
// pin the gate and the status readback specifically.

test('compactThreadAsAgent compacts the addressed thread and re-delivers standing context, same as compactThread', async () => {
  const owner = await makeUser('agent-compact-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent compact', 'the standing topic')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-solo' })

  const prompts: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `agent-compact-${crypto.randomUUID()}` }),
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

  // A different member ('Agent Solo') triggers the compaction than the
  // thread's own agent — the delegation case, same as group_chat_send's.
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)

  const ack = await model.compactThreadAsAgent('Agent Solo', started.thread.id)
  assert.equal(ack.accepted, true)

  await waitForPrompts(prompts, 3) // opening, then '/compact', then the restore
  assert.equal(prompts[1], '/compact')
  assert.match(prompts[2] ?? '', /the standing topic/, 'the restore re-delivers the thread standing context')

  const status = await model.threadCompactStatusAsAgent('Agent Solo', started.thread.id)
  assert.equal(status.state, 'done')
  assert.equal(status.result?.instructionsRestored, true)
})

test('compactThreadAsAgent wakes an offline session from stored state, compacts it, and leaves it running', async () => {
  const owner = await makeUser('agent-compact-offline-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'offline compact', 'the standing topic')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  seedMockConnection(prompts, 'Agent Session', { resumable: true })

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message')
  await waitForPrompts(prompts, 1)

  const { agentClient } = await import('@/app/_authed/(agent)/_server/agent-client-instance')
  const { stopLocalSessionProcessImpl } = await import('@/app/_authed/(agent)/_server/acp-impl')

  // Force the session offline the way an idle unload or a server restart
  // would — the durable session pointer survives, only the live process is
  // gone. See acp-impl.ts's stopLocalSessionProcessImpl for why this (not
  // forgetLocalSessionImpl) is the "history survives" primitive.
  await stopLocalSessionProcessImpl(started.thread.sessionKey)
  assert.equal(
    agentClient.listSessions().some((s) => s.id === started.sessionId),
    false,
    'sanity: the session must actually be offline before compacting it',
  )

  const ack = await model.compactThreadAsAgent('Agent Session', started.thread.id)
  assert.equal(ack.accepted, true)

  // opening, then '/compact' (only reachable once the wake resumed the
  // session), then the restore re-delivering the standing topic.
  await waitForPrompts(prompts, 3)
  assert.equal(prompts[1], '/compact')
  assert.match(prompts[2] ?? '', /the standing topic/, 'the restore re-delivers the thread standing context')

  const status = await model.threadCompactStatusAsAgent('Agent Session', started.thread.id)
  assert.equal(status.state, 'done')
  assert.equal(status.result?.instructionsRestored, true)

  assert.equal(
    agentClient.listSessions().some((s) => s.id === started.sessionId),
    true,
    'the session must be left running after the compact -- compaction never unloads it',
  )
})

test('compactThreadAsAgent is refused for a non-member the same way sendMessageInThreadAsAgent is', async () => {
  const owner = await makeUser('agent-compact-gate-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent compact gate')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:agent-compact-gate-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  // 'Agent Solo' is a real agent, and not a member of this chat.
  const outsider = await captureRefusal(() => model.compactThreadAsAgent('Agent Solo', thread.id))
  const fabricated = await captureRefusal(() => model.compactThreadAsAgent('Agent Solo', crypto.randomUUID()))

  assert.equal(outsider.code, 'not-found')
  assert.equal(fabricated.code, outsider.code)
  assert.equal(fabricated.message, outsider.message)
})

test("compactThreadAsAgent is refused once the thread's agent is no longer a member", async () => {
  const owner = await makeUser('agent-compact-removed-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent compact removed')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-solo' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:agent-compact-removed-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  await model.removeMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  // The caller ('Agent Solo') is still a member; the thread's own agent is not.
  const refusal = await captureRefusal(() => model.compactThreadAsAgent('Agent Solo', thread.id))
  assert.equal(refusal.code, 'agent-not-a-member')
})

test('threadCompactStatusAsAgent is refused for a non-member the same way compactThreadAsAgent is', async () => {
  const owner = await makeUser('agent-compact-status-gate-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent compact status gate')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:agent-compact-status-gate-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const refusal = await captureRefusal(() => model.threadCompactStatusAsAgent('Agent Solo', thread.id))
  assert.equal(refusal.code, 'not-found')
})

// ---------------------------------------------------------------------------
// deliverThreadFromNode — the entry point a send-message node's `thread`
// envelope goes through, pinned directly here
// rather than only through stream.ts's own integration test: this is its
// contract in isolation, decoupled from any particular graph.
// ---------------------------------------------------------------------------

test('deliverThreadFromNode resolves the same forms sendMessageInThreadAsAgent does — readable ref, whole key, and id', async () => {
  const owner = await makeUser('node-forms-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'node delivery forms')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  seedMockConnection(prompts)
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'opening message', {
    title: 'Standup',
  })
  await waitForPrompts(prompts, 1)

  const alwaysReachable = () => true

  await model.deliverThreadFromNode('node-delivery-forms:agent-session:standup', 'by path', alwaysReachable, 'wait')
  await waitForPrompts(prompts, 2)
  assert.match(prompts[1] ?? '', /by path/)

  await model.deliverThreadFromNode(started.thread.sessionKey, 'by key', alwaysReachable, 'wait')
  await waitForPrompts(prompts, 3)
  assert.match(prompts[2] ?? '', /by key/)

  await model.deliverThreadFromNode(started.thread.id, 'by id', alwaysReachable, 'wait')
  await waitForPrompts(prompts, 4)
  assert.match(prompts[3] ?? '', /by id/)
})

test('deliverThreadFromNode reports not-found for an unresolvable reference without calling isReachable', async () => {
  let called = false
  const outcome = await model.deliverThreadFromNode(
    'nothing:here:at-all',
    'hello',
    () => {
      called = true
      return true
    },
    'wait',
  )
  assert.deepEqual(outcome, { status: 'not-found' })
  assert.equal(called, false, 'a reference that resolves to nothing has no agent to check reachability for')
})

// THE CONVERGENCE ITSELF: deliverIntoThread
// now opens its session through the SAME
// resolveOrCreateSession/withSessionKeyLock the agent:job path uses, instead
// of a second, unguarded call to ensureLocalSessionImpl. Two concurrent
// deliveries into a thread whose session has never been opened must still
// produce exactly one session and drop neither message — true both before and
// after this change, since ensureLocalSessionImpl's own in-flight dedup
// already coalesces calls that overlap this tightly (checked directly:
// reverting resolveOrCreateSession to a bare ensureLocalSessionImpl call still
// passes this test). What this convergence provably buys is ONE
// serialization primitive instead of two that could drift apart — see
// resolveOrCreateSession's own header in stream.ts for the narrower race that
// difference closes.
test('two concurrent deliveries into a brand-new thread session produce exactly one session, not two', async () => {
  const owner = await makeUser('thread-race-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'thread race')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  // Inserted directly, NOT via startThread: the point is a thread whose
  // session has never been opened, so both deliveries below race to open it.
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-session',
      sessionKey: `group-chat:${chat.id}:agent-session:race-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const prompts: string[] = []
  let newSessionCalls = 0
  const connection = {
    newSession: async () => {
      newSessionCalls += 1
      // Widens the race window: without the lock, both callers would already
      // have read "no session" before either finishes creating one.
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { sessionId: `race-${crypto.randomUUID()}` }
    },
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((b) => b.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', slug('Agent Session')),
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

  const alwaysReachable = () => true
  await Promise.all([
    model.deliverThreadFromNode(thread.sessionKey, 'first', alwaysReachable, 'wait'),
    model.deliverThreadFromNode(thread.sessionKey, 'second', alwaysReachable, 'wait'),
  ])

  assert.equal(
    newSessionCalls,
    1,
    'two concurrent deliveries into one new thread session must open exactly one session',
  )
  assert.equal(prompts.length, 2, 'and neither message may be dropped')
})

test('deliverThreadFromNode reports not-reachable and delivers nothing when the caller-supplied check says no', async () => {
  const owner = await makeUser('node-unreachable-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'node unreachable')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:node-unreachable-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  // The predicate is authoritative and caller-supplied — this proves the seam
  // itself, independent of any real graph or reachablePairs computation.
  const outcome = await model.deliverThreadFromNode(thread.sessionKey, 'should not land', () => false, 'wait')
  assert.deepEqual(outcome, { status: 'not-reachable' })
})

/** Seeds the agent-client store so 'Agent Session' resolves without spawning. */
// `agentName` selects WHICH agent this connection stands in for: the spawn
// config is derived from the agent's own workspace, so seeding two of these
// gives two separately observable inboxes — which is how a test can tell that a
// message reached the agent it was addressed to and not merely some agent.
//
// `resumable` advertises the `loadSession` capability and answers it with a
// bare success — needed by any test that forces the session offline
// (stopLocalSessionProcessImpl) and then expects it to be woken back up via
// agent-client's own session/load replay, rather than silently rebuilt fresh.
function seedMockConnection(prompts: string[], agentName = 'Agent Session', opts?: { resumable?: boolean }): void {
  const connection = {
    newSession: async () => ({ sessionId: `mock-${crypto.randomUUID()}` }),
    prompt: async (params: { prompt: Array<{ text?: string }> }) => {
      prompts.push(params.prompt.map((b) => b.text ?? '').join(''))
      return { stopReason: 'end_turn' }
    },
    resumeSession: async (params: { sessionId: string }) => ({ sessionId: params.sessionId }),
    ...(opts?.resumable ? { loadSession: async () => ({}) } : {}),
    cancel: async () => {},
    setSessionConfigOption: async () => ({}),
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: process.env.OPENCLAW_GATEWAY_TOKEN || '',
    cwd: join(process.cwd(), 'data', 'agent-workspace', slug(agentName)),
    baseUrl: process.env.OPENCLAW_GATEWAY_URL,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: { connections: Map<string, unknown> } }).__acpStore
  if (!store) {
    throw new Error('agent-client global store must exist after import')
  }
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: Boolean(opts?.resumable),
    initialized: Promise.resolve(),
  })
}

// ---------------------------------------------------------------------------
// READABLE SESSION KEYS. A thread's key reads as a channel path rather than a
// pair of uuids, and the slugs inside it are what a caller addresses it by.
// ---------------------------------------------------------------------------

test('a chat takes its slug from its name, and a rename moves it', async () => {
  const owner = await makeUser('slug-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), '  Some Product Development!  ')

  assert.equal(chat.slug, 'some-product-development', 'punctuation and spacing collapse to one readable token')

  await model.renameGroupChat(reqAs(owner), chat.id, 'Something Else Entirely')
  const after = await model.getGroupChat(reqAs(owner), chat.id)
  assert.equal(after.name, 'Something Else Entirely')
  assert.equal(after.slug, 'something-else-entirely', 'the address follows the name -- what the rename is for')
})

test('a rename that does not move the slug leaves every address exactly where it was', async () => {
  const owner = await makeUser('slug-display-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Steady Address')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  const prompts: string[] = []
  seedMockConnection(prompts)
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Notes' })
  await waitForPrompts(prompts, 1)

  // Capitalisation and punctuation only: the same slug, so nothing about the
  // address moved and there is nothing to alias.
  await model.renameGroupChat(reqAs(owner), chat.id, '  steady   address!! ')

  const after = await model.getGroupChat(reqAs(owner), chat.id)
  assert.equal(after.name, 'steady   address!!')
  assert.equal(after.slug, 'steady-address')
  assert.equal((await model.getThread(reqAs(owner), started.thread.id)).sessionKey, started.thread.sessionKey)
  assert.equal(
    (await db.select().from(groupChatSlugAlias).where(eq(groupChatSlugAlias.groupChatId, chat.id))).length,
    0,
    'no address was freed, so no alias is recorded for one',
  )
  assert.equal(
    (await db.select().from(groupChatThreadAlias).where(eq(groupChatThreadAlias.groupChatId, chat.id))).length,
    0,
  )
})

test('a name whose slug is taken is refused, with a code the form can show', async () => {
  const owner = await makeUser('slug-clash-owner@example.test')
  await model.createGroupChat(reqAs(owner), 'Duplicate Name')

  const refusal = await captureRefusal(() => model.createGroupChat(reqAs(owner), 'duplicate   name'))
  assert.equal(refusal.code, 'slug-taken', 'different words, same slug — still a clash')
})

test('a name with nothing to slugify is refused as its own thing', async () => {
  const owner = await makeUser('slug-empty-owner@example.test')
  // The answer here is different words, not somebody else's words — so this is
  // deliberately not the same refusal as a clash.
  const refusal = await captureRefusal(() => model.createGroupChat(reqAs(owner), '!!! ---'))
  assert.equal(refusal.code, 'slug-unusable')
})

test('a thread key reads as a channel path, and a named thread carries its title in it', async () => {
  const owner = await makeUser('thread-slug-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Key Shapes')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  const prompts: string[] = []
  seedMockConnection(prompts)

  const named = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Code Review' })
  await waitForPrompts(prompts, 1)
  assert.equal(named.thread.sessionKey, 'group-chat:key-shapes:agent-session:code-review')

  const adhoc = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'second')
  await waitForPrompts(prompts, 2)
  // Ad-hoc threads get a short hash: most threads mean nothing, and a number
  // would imply an order that means even less.
  assert.match(adhoc.thread.sessionKey, /^group-chat:key-shapes:agent-session:[0-9a-f]{8}$/)
})

test('a thread title whose slug is already taken for that agent is refused', async () => {
  const owner = await makeUser('thread-clash-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Thread Clashes')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  const prompts: string[] = []
  seedMockConnection(prompts)

  await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Code Review' })
  await waitForPrompts(prompts, 1)

  const refusal = await captureRefusal(() =>
    model.startThread(reqAs(owner), chat.id, 'agent-session', 'again', { title: 'code review' }),
  )
  assert.equal(refusal.code, 'slug-taken')
})

test('an agent can address a thread by its readable path, by a whole key, or by id', async () => {
  const owner = await makeUser('addressing-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Addressing')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-solo' })
  const prompts: string[] = []
  seedMockConnection(prompts)

  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Standup' })
  await waitForPrompts(prompts, 1)

  // The readable path, as it appears in the key.
  await model.sendMessageInThreadAsAgent('Agent Solo', 'addressing:agent-session:standup', 'by path', 'wait')
  await waitForPrompts(prompts, 2)
  assert.match(prompts[1] ?? '', /by path/)

  // The whole key, prefix included — what someone pastes off a screen.
  await model.sendMessageInThreadAsAgent('Agent Solo', started.thread.sessionKey, 'by key', 'wait')
  await waitForPrompts(prompts, 3)
  assert.match(prompts[2] ?? '', /by key/)

  // And the id, which is what a caller stored before slugs existed.
  await model.sendMessageInThreadAsAgent('Agent Solo', started.thread.id, 'by id', 'wait')
  await waitForPrompts(prompts, 4)
  assert.match(prompts[3] ?? '', /by id/)
})

test('two threads sharing a slug in one chat are addressed apart by the agent in the key', async () => {
  // Thread-slug uniqueness is scoped to (chat, agent), so this state is legal:
  // two threads called the same thing in one chat, held by different agents.
  // Resolving on the slug PAIR would drop the only segment that tells them
  // apart and hand back whichever row came first — delivering a message to an
  // agent it was not addressed to. A membership gate cannot catch that: the
  // sender is a member of both.
  const owner = await makeUser('same-slug-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Ambiguous')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session-2' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-solo' })

  const promptsFirst: string[] = []
  const promptsSecond: string[] = []
  seedMockConnection(promptsFirst, 'Agent Session')
  seedMockConnection(promptsSecond, 'Agent Session Two')

  const first = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Code Review' })
  const second = await model.startThread(reqAs(owner), chat.id, 'agent-session-2', 'first', { title: 'Code Review' })
  await waitForPrompts(promptsFirst, 1)
  await waitForPrompts(promptsSecond, 1)

  assert.equal(first.thread.sessionKey, 'group-chat:ambiguous:agent-session:code-review')
  assert.equal(
    second.thread.sessionKey,
    'group-chat:ambiguous:agent-session-two:code-review',
    'the same thread slug under a different agent is legal — the agent segment is what separates them',
  )

  await model.sendMessageInThreadAsAgent(
    'Agent Solo',
    'ambiguous:agent-session-two:code-review',
    'meant for the second',
    'wait',
  )
  await waitForPrompts(promptsSecond, 2)
  assert.match(promptsSecond[1] ?? '', /meant for the second/)
  assert.equal(promptsFirst.length, 1, 'the agent named in the address receives it, and the other hears nothing')

  await model.sendMessageInThreadAsAgent(
    'Agent Solo',
    'ambiguous:agent-session:code-review',
    'meant for the first',
    'wait',
  )
  await waitForPrompts(promptsFirst, 2)
  assert.match(promptsFirst[1] ?? '', /meant for the first/)
  assert.equal(promptsSecond.length, 2, 'and the same holds in the other direction')
})

test('a legacy uuid-keyed thread still resolves and still lists', async () => {
  const owner = await makeUser('legacy-key-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Legacy Keys')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-solo' })

  // Exactly the shape threads were minted with before this change: uuids, and
  // no slug at all.
  const [legacy] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:${crypto.randomUUID()}`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(legacy)

  const chats = await model.listGroupChatsForAgentView('Agent Solo')
  const mine = chats.find((c) => c.ref === chat.id)
  assert.ok(mine)
  assert.equal(mine.threads[0]?.ref, legacy.id, 'a thread with no slug is addressed by its id, as it always was')
})

// ---------------------------------------------------------------------------
// The embedded surface's reads: resolving a chat by slug, and one agent's
// thread by slug. The deliberate asymmetry — `missing` vs `not-a-member` IS
// distinguishable here, unlike everywhere else — is asserted as such; see
// resolveGroupChatBySlug's own comment for why it discloses nothing new.
// ---------------------------------------------------------------------------

test('resolveGroupChatBySlug: member, non-member and missing are three answers', async () => {
  const owner = await makeUser('embed-resolve-owner@example.test')
  const outsider = await makeUser('embed-resolve-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Embed Resolve Chat')

  const asMember = await model.resolveGroupChatBySlug(reqAs(owner), 'embed-resolve-chat')
  assert.equal(asMember.state, 'member')
  assert.ok(asMember.state === 'member')
  assert.equal(asMember.chat.id, chat.id)
  assert.equal(asMember.chat.slug, 'embed-resolve-chat')

  const asOutsider = await model.resolveGroupChatBySlug(reqAs(outsider), 'embed-resolve-chat')
  assert.equal(asOutsider.state, 'not-a-member')

  const missing = await model.resolveGroupChatBySlug(reqAs(owner), 'no-such-chat-anywhere')
  assert.equal(missing.state, 'missing')
})

test('resolveGroupChatBySlug slugifies its input, the same transform the slug column holds', async () => {
  const owner = await makeUser('embed-slugify-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Embed Slugify Chat')

  // The raw name — mixed case, spaces — resolves to the same chat its slug does.
  const byName = await model.resolveGroupChatBySlug(reqAs(owner), 'Embed Slugify Chat')
  assert.ok(byName.state === 'member')
  assert.equal(byName.chat.id, chat.id)

  // Nothing to build a slug from is a missing chat, not a fault.
  const unusable = await model.resolveGroupChatBySlug(reqAs(owner), '???')
  assert.equal(unusable.state, 'missing')
})

test('resolveGroupChatBySlug refuses an anonymous caller before answering anything', async () => {
  const refusal = await captureRefusal(() => model.resolveGroupChatBySlug(reqAnonymous(), 'embed-resolve-chat'))
  assert.equal(refusal.code, 'unauthenticated')
})

test('findThreadBySlug: a member gets the row, absence is null, a non-member is refused', async () => {
  const owner = await makeUser('embed-thread-owner@example.test')
  const outsider = await makeUser('embed-thread-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Embed Thread Chat')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  // Direct insert rather than startThread, same reasoning as the access-rule
  // test above: the lookup is under test, not the session machinery.
  const [row] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: 'group-chat:embed-thread-chat:agent-a:design-kit',
      slug: 'design-kit',
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(row)

  const found = await model.findThreadBySlug(reqAs(owner), chat.id, 'agent-a', 'design-kit')
  assert.equal(found?.id, row.id)
  assert.equal(found?.sessionKey, 'group-chat:embed-thread-chat:agent-a:design-kit')

  // The same slug under another agent is a different thread by design — and
  // here, no thread at all.
  assert.equal(await model.findThreadBySlug(reqAs(owner), chat.id, 'agent-b', 'design-kit'), null)
  assert.equal(await model.findThreadBySlug(reqAs(owner), chat.id, 'agent-a', 'not-started-yet'), null)

  const refusal = await captureRefusal(() => model.findThreadBySlug(reqAs(outsider), chat.id, 'agent-a', 'design-kit'))
  assert.equal(refusal.code, 'not-found')
})

// ---------------------------------------------------------------------------
// RENAMING MOVES AN ADDRESS. A slug is the identity of a live session, not a
// label, so these tests are about the migration: that the conversation, its
// process and everything filed under its key come with it, and that every
// address the rename freed still lands where it used to.
//
// The failure they exist to catch does not throw. A migration that misses a
// store opens a fresh empty session beside the real one, or drops an extension
// embed into its create flow, and reports success either way -- so each test
// below asserts on the thing that would still be there afterwards, not on the
// call returning.
// ---------------------------------------------------------------------------

test('renaming a chat re-keys every thread in it, and the live session comes with the key', async () => {
  const owner = await makeUser('chat-rekey-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Shipping Train')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  const prompts: string[] = []
  seedMockConnection(prompts)

  const standup = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Standup' })
  await waitForPrompts(prompts, 1)
  const retro = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'second', { title: 'Retro' })
  await waitForPrompts(prompts, 2)
  const oldKey = standup.thread.sessionKey
  assert.equal(oldKey, 'group-chat:shipping-train:agent-session:standup')

  // What a real session carries besides its transcript, and what a rename that
  // moved only the row would silently leave behind.
  await sessionStore.writePersistedConfigOption(oldKey, 'thought_level', 'high')
  handleUpdate({
    sessionId: standup.sessionId,
    update: { sessionUpdate: 'usage_update', used: 4_321, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  const sessionCountBefore = agentClient.listSessions().length

  await model.renameGroupChat(reqAs(owner), chat.id, 'Delivery Train')

  // Every thread, not just the one that was looked at.
  const newKey = 'group-chat:delivery-train:agent-session:standup'
  assert.equal((await model.getThread(reqAs(owner), standup.thread.id)).sessionKey, newKey)
  assert.equal(
    (await model.getThread(reqAs(owner), retro.thread.id)).sessionKey,
    'group-chat:delivery-train:agent-session:retro',
  )

  // The durable pointer is the one that decides whether reopening finds the
  // conversation or starts a new one.
  assert.equal((await sessionStore.readPersistedSession(newKey))?.id, standup.sessionId)
  assert.equal(await sessionStore.readPersistedSession(oldKey), null, 'the old key is retired, not left resolving too')
  assert.deepEqual(await sessionStore.readPersistedConfigOptions(newKey), { thought_level: 'high' })
  assert.deepEqual(await sessionStore.readPersistedConfigOptions(oldKey), {})

  // agent-client answers by key, so a session left behind here reads as offline
  // with an empty ring while it is in fact running.
  assert.equal(agentClient.aliveSessionKeys().includes(newKey), true)
  assert.equal(agentClient.aliveSessionKeys().includes(oldKey), false)

  // The ring, through the same read the composer makes. The tokens are what
  // this assertion is about: they survived the re-key, which a rename that
  // moved only the row would have lost. The window is null for the same reason
  // as in the contextUsage test above — an unconfigured bridged session has no
  // window anyone established, so none is shown.
  const view = (await model.listGroupChatsForAgentView('Agent Session'))
    .find((c) => c.ref === chat.id)
    ?.threads.find((t) => t.ref === newKey.slice('group-chat:'.length))
  assert.deepEqual(view?.contextUsage, { usedTokens: 4_321, contextLimit: null })

  // And a send lands in the session that was already there -- the whole point.
  // A migration that missed the pointer would pass every assertion above that
  // reads a row and still create a second session here.
  await model.sendMessageInThread(reqAs(owner), standup.thread.id, 'after the rename', { queue: 'wait' })
  await waitForPrompts(prompts, 3)
  assert.equal(agentClient.listSessions().length, sessionCountBefore, 'no fresh session was opened beside the real one')
})

test('an address a chat rename freed still reaches the same chat and the same thread', async () => {
  const owner = await makeUser('chat-alias-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Old Chat Name')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-solo' })
  const prompts: string[] = []
  seedMockConnection(prompts)
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Planning' })
  await waitForPrompts(prompts, 1)
  const oldKey = started.thread.sessionKey

  await model.renameGroupChat(reqAs(owner), chat.id, 'New Chat Name')

  // The extension embed's own read: `space` is whatever the host configured,
  // and nothing rewrites it when a chat is renamed.
  const byOldSlug = await model.resolveGroupChatBySlug(reqAs(owner), 'old-chat-name')
  assert.equal(byOldSlug.state, 'member', 'the embed must find the chat, not fall into its create flow')
  assert.ok(byOldSlug.state === 'member')
  assert.equal(byOldSlug.chat.id, chat.id)
  assert.equal(byOldSlug.chat.slug, 'new-chat-name', 'resolved through the old address, answered with the current one')

  // A message already addressed to the key the rename retired.
  const outcome = await model.deliverThreadFromNode(oldKey, 'sent to the old address', () => true, 'wait')
  assert.equal(outcome.status === 'not-found' || outcome.status === 'not-reachable', false)
  await waitForPrompts(prompts, 2)
  assert.match(prompts.at(-1) ?? '', /sent to the old address/)

  // And through the agent-facing surface, which takes the readable half.
  await model.sendMessageInThreadAsAgent(
    'Agent Solo',
    'old-chat-name:agent-session:planning',
    'also the old path',
    'wait',
  )
  await waitForPrompts(prompts, 3)
  assert.match(prompts.at(-1) ?? '', /also the old path/)

  // Nothing was created to absorb any of that.
  assert.equal((await model.listThreadsInGroupChat(reqAs(owner), chat.id)).length, 1)
})

test('renaming a thread moves its slug and its key, and keeps everything the thread was holding', async () => {
  const owner = await makeUser('thread-rekey-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Thread Renames')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  const prompts: string[] = []
  seedMockConnection(prompts)
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Standup' })
  await waitForPrompts(prompts, 1)
  const oldKey = started.thread.sessionKey
  await model.setThreadDraft(reqAs(owner), started.thread.id, 'half-typed message')

  await model.renameThread(reqAs(owner), started.thread.id, 'Daily Standup')

  const after = await model.getThread(reqAs(owner), started.thread.id)
  assert.equal(after.title, 'Daily Standup')
  assert.equal(after.sessionKey, 'group-chat:thread-renames:agent-session:daily-standup')
  assert.equal(after.draft, 'half-typed message', 'the draft is on the row and must survive the move')
  assert.equal((await sessionStore.readPersistedSession(after.sessionKey))?.id, started.sessionId)
  assert.equal(await sessionStore.readPersistedSession(oldKey), null)
  assert.equal(agentClient.aliveSessionKeys().includes(after.sessionKey), true)

  // The embed addresses a thread by the id its host configured -- the slug.
  const byOldSlug = await model.findThreadBySlug(reqAs(owner), chat.id, 'agent-session', 'standup')
  assert.equal(byOldSlug?.id, started.thread.id, 'the embed must find the same thread, not start an empty one')

  // And the key an agent may have written down.
  const outcome = await model.deliverThreadFromNode(oldKey, 'to the old thread address', () => true, 'wait')
  assert.equal(outcome.status === 'not-found' || outcome.status === 'not-reachable', false)
  await waitForPrompts(prompts, 2)
  assert.equal((await model.listThreadsInGroupChat(reqAs(owner), chat.id)).length, 1)
})

test('a taken slug is refused and nothing moves, for a chat and for a thread alike', async () => {
  const owner = await makeUser('rename-clash-owner@example.test')
  await model.createGroupChat(reqAs(owner), 'Occupied Name')
  const chat = await model.createGroupChat(reqAs(owner), 'Mover')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  const prompts: string[] = []
  seedMockConnection(prompts)
  const keep = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Kept' })
  await waitForPrompts(prompts, 1)
  const moving = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'second', { title: 'Moving' })
  await waitForPrompts(prompts, 2)

  const chatClash = await captureRefusal(() => model.renameGroupChat(reqAs(owner), chat.id, 'occupied   name'))
  assert.equal(chatClash.code, 'slug-taken', 'different words, same address -- still a clash')
  const unchanged = await model.getGroupChat(reqAs(owner), chat.id)
  assert.equal(unchanged.name, 'Mover', 'a refused rename changes nothing at all, not even the display name')
  assert.equal(unchanged.slug, 'mover')
  assert.equal((await model.getThread(reqAs(owner), moving.thread.id)).sessionKey, moving.thread.sessionKey)

  const threadClash = await captureRefusal(() => model.renameThread(reqAs(owner), moving.thread.id, '  kept  '))
  assert.equal(threadClash.code, 'slug-taken')
  assert.equal((await model.getThread(reqAs(owner), moving.thread.id)).title, 'Moving')
  assert.equal((await model.getThread(reqAs(owner), moving.thread.id)).sessionKey, moving.thread.sessionKey)
  assert.equal((await model.getThread(reqAs(owner), keep.thread.id)).sessionKey, keep.thread.sessionKey)

  const unusable = await captureRefusal(() => model.renameThread(reqAs(owner), moving.thread.id, '!!! ---'))
  assert.equal(unusable.code, 'slug-unusable')
})

test('a new thread taking a freed address wins it, and the alias for it stops resolving', async () => {
  const owner = await makeUser('alias-outranked-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Reuse')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  const prompts: string[] = []
  seedMockConnection(prompts)
  const first = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Standup' })
  await waitForPrompts(prompts, 1)
  const freedKey = first.thread.sessionKey

  // Frees 'standup' and the key built from it.
  await model.renameThread(reqAs(owner), first.thread.id, 'Daily Standup')
  assert.equal((await model.findThreadBySlug(reqAs(owner), chat.id, 'agent-session', 'standup'))?.id, first.thread.id)

  // A second thread now claims exactly that address.
  const second = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'third', { title: 'Standup' })
  await waitForPrompts(prompts, 2)
  assert.equal(second.thread.sessionKey, freedKey)

  // A LIVE THREAD OUTRANKS AN ALIAS. This is the one case where getting the
  // order wrong delivers to the wrong agent while every gate passes.
  assert.equal(
    (await model.findThreadBySlug(reqAs(owner), chat.id, 'agent-session', 'standup'))?.id,
    second.thread.id,
    'the thread holding the address now is the answer, not the one that used to',
  )
  const outcome = await model.deliverThreadFromNode(freedKey, 'to whoever holds it now', () => true, 'wait')
  assert.equal(outcome.status === 'not-found' || outcome.status === 'not-reachable', false)
  await waitForPrompts(prompts, 3)
  const aliases = await db.select().from(groupChatThreadAlias).where(eq(groupChatThreadAlias.sessionKey, freedKey))
  assert.equal(aliases.length, 0, 'the alias on a re-taken address is dropped, not merely outranked at read time')
})

test('a chat rename leaves a thread whose key was never built from the slug exactly as it was', async () => {
  const owner = await makeUser('legacy-rekey-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Has A Legacy Thread')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  // The shape threads were created with before slugs existed: ids, not slugs.
  const legacyKey = `group-chat:${chat.id}:agent-a:${crypto.randomUUID()}`
  const [thread] = await db
    .insert(groupChatThread)
    .values({ groupChatId: chat.id, agentNodeId: 'agent-a', sessionKey: legacyKey, createdByUserId: owner.id })
    .returning()
  assert.ok(thread)

  await model.renameGroupChat(reqAs(owner), chat.id, 'Renamed Around It')

  assert.equal(
    (await model.getThread(reqAs(owner), thread.id)).sessionKey,
    legacyKey,
    'the chat slug was never in this key, so the rename cannot have staled it -- re-minting would break it',
  )
  assert.equal(
    (await db.select().from(groupChatThreadAlias).where(eq(groupChatThreadAlias.threadId, thread.id))).length,
    0,
    'nothing was freed, so nothing is aliased',
  )
})

// THE HANDOVER. The operational sequence for a chat that is holding a slug some
// other surface needs -- a chat whose address froze under an earlier name, so an
// embedded dashboard resolving that slug lands in it rather than in the chat the
// reader meant. Freeing it takes two renames, and this is the proof that the
// second one is not blocked by the first one's alias and does take the address
// over completely.
test('a chat can hand a slug to another chat: the alias neither blocks the rename nor survives it', async () => {
  const owner = await makeUser('handover-owner@example.test')
  const holder = await model.createGroupChat(reqAs(owner), 'Wrong Holder')
  const wanted = holder.slug

  // Step one: move the holder off the address. It keeps resolving to the
  // holder, by design -- nothing else has claimed it yet.
  await model.renameGroupChat(reqAs(owner), holder.id, 'Moved Away')
  const stillHolder = await model.resolveGroupChatBySlug(reqAs(owner), wanted)
  assert.ok(stillHolder.state === 'member')
  assert.equal(stillHolder.chat.id, holder.id, 'a freed address keeps working until something takes it')

  // Step two: the chat that should have it takes it. An alias must NOT read as
  // taken here -- the slug-taken check is against live chats only, and if an
  // alias blocked this the address could never be handed over at all.
  const wanting = await model.createGroupChat(reqAs(owner), 'Wants That Address')
  await model.renameGroupChat(reqAs(owner), wanting.id, 'Wrong Holder')

  const resolved = await model.resolveGroupChatBySlug(reqAs(owner), wanted)
  assert.ok(resolved.state === 'member')
  assert.equal(resolved.chat.id, wanting.id, 'the address now reaches the chat that holds it, not the one that used to')
  assert.equal((await model.getGroupChat(reqAs(owner), wanting.id)).slug, wanted)
  assert.equal(
    (await db.select().from(groupChatSlugAlias).where(eq(groupChatSlugAlias.slug, wanted))).length,
    0,
    'the alias is dropped by the handover, not left to be outranked on every read',
  )

  // The chat that gave it up is unharmed and still reachable by its own address.
  assert.equal((await model.getGroupChat(reqAs(owner), holder.id)).slug, 'moved-away')
})

// REGRESSION. The scoped slug check and the global `sessionKey` unique index are
// not the same guarantee, and the gap between them is reachable: two agent nodes
// sharing a name mint the same agent segment, so a rename can pass the scoped
// check and still target a key another thread holds.
//
// What made it worse than a failed write is the ORDER. Staging copies the
// durable session pointer onto the destination key before the transaction runs,
// so a rename that then lost at the unique index left the victim thread
// resolving to the renamer's ACP session -- every gate passed, nothing logged,
// and no rollback that reaches the settings store. The guard therefore has to
// run before staging, which is what this pins.
test('a rename that would collide on the session key is refused before anything is staged', async () => {
  const owner = await makeUser('key-collision-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Twin Agents')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-twin-a' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-twin-b' })
  const prompts: string[] = []
  seedMockConnection(prompts, 'Twin Agent')

  const victim = await model.startThread(reqAs(owner), chat.id, 'agent-twin-a', 'first', { title: 'Alpha' })
  await waitForPrompts(prompts, 1)
  const mover = await model.startThread(reqAs(owner), chat.id, 'agent-twin-b', 'second', { title: 'Beta' })
  await waitForPrompts(prompts, 2)

  // The two share an agent segment, so the mover's target IS the victim's key.
  assert.equal(victim.thread.sessionKey, 'group-chat:twin-agents:twin-agent:alpha')
  assert.equal(mover.thread.sessionKey, 'group-chat:twin-agents:twin-agent:beta')

  const refusal = await captureRefusal(() => model.renameThread(reqAs(owner), mover.thread.id, 'Alpha'))
  assert.equal(refusal.code, 'slug-taken')

  // THE ASSERTION THAT MATTERS. A refusal after staging would leave this
  // pointing at the mover's session, and every other check here would still
  // pass -- the thread reads fine, its row is untouched, and only the
  // conversation behind it has changed.
  assert.equal(
    (await sessionStore.readPersistedSession(victim.thread.sessionKey))?.id,
    victim.sessionId,
    'the untouched thread must still resolve to its OWN session',
  )
  assert.equal((await model.getThread(reqAs(owner), victim.thread.id)).sessionKey, victim.thread.sessionKey)

  // And the refused rename moved nothing of its own.
  const moverAfter = await model.getThread(reqAs(owner), mover.thread.id)
  assert.equal(moverAfter.title, 'Beta')
  assert.equal(moverAfter.sessionKey, mover.thread.sessionKey)
  assert.equal((await sessionStore.readPersistedSession(mover.thread.sessionKey))?.id, mover.sessionId)
})

// REGRESSION. A session key can be captured in a closure and resolved a whole
// turn later -- `requestCompactOnGraph` does exactly that -- so a rename
// committing in between hands these two functions an address that has just been
// retired. Without the alias fallback the compaction drops the history and then
// silently does NOT restore the topic, pins and instructions that were the
// reason for compacting.
test('a retired session key still resolves standing context and still wakes the right session', async () => {
  const owner = await makeUser('retired-key-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Retired Key Chat', 'the standing purpose')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  const prompts: string[] = []
  seedMockConnection(prompts)
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Ongoing' })
  await waitForPrompts(prompts, 1)
  const retiredKey = started.thread.sessionKey

  await model.renameGroupChat(reqAs(owner), chat.id, 'Renamed Mid Compaction')

  const standing = await model.groupChatStandingContext(retiredKey)
  assert.ok(standing, 'a retired key must still resolve, or the restore after a compaction is skipped')
  assert.match(standing.jobContext, /the standing purpose/)

  // Waking must open the thread's CURRENT key, not the one asked with --
  // otherwise the wake itself creates the second session.
  const woken = await model.groupChatWakeSession(retiredKey)
  assert.equal(woken?.sessionId, started.sessionId, 'the same live session, reached through the freed address')
  assert.equal(agentClient.aliveSessionKeys().includes(retiredKey), false, 'nothing was opened under the retired key')

  // A key that never named a thread is still null, not a wrong answer.
  assert.equal(await model.groupChatStandingContext('group-chat:nothing:nobody:nowhere'), null)
  assert.equal(await model.groupChatWakeSession('group-chat:nothing:nobody:nowhere'), null)
})

// REGRESSION. A screen holds the session key its last load handed it, and a
// rename retires it -- by anyone, in any tab. Opening is the one call that can
// CREATE a session, so a stale key there does not error: it mints an empty
// conversation under an address nothing resolves, and the reader is shown an
// empty chat where their history was. Only the renamer's own screen reloads; a
// second person with the thread open keeps the old key indefinitely.
//
// So the surface opens by THREAD ID and the key is read from the row here.
test('opening a thread by id after a rename reattaches, where the stale key would have created a session', async () => {
  const owner = await makeUser('open-by-id-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'Opened By Id')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  const prompts: string[] = []
  seedMockConnection(prompts)
  const started = await model.startThread(reqAs(owner), chat.id, 'agent-session', 'first', { title: 'Ongoing' })
  await waitForPrompts(prompts, 1)
  const staleKey = started.thread.sessionKey

  await model.renameGroupChat(reqAs(owner), chat.id, 'Opened By Id Renamed')
  const sessionCount = agentClient.listSessions().length

  // What a second reader's screen does on its next mount: it still holds the
  // pre-rename key, but it opens by the id, which has not moved.
  const reopened = await model.openThreadSession(reqAs(owner), started.thread.id)
  assert.equal(reopened.sessionId, started.sessionId, 'the same conversation, not a new one')
  assert.equal(agentClient.listSessions().length, sessionCount, 'nothing was created')
  assert.equal(agentClient.aliveSessionKeys().includes(staleKey), false, 'and nothing is alive under the retired key')

  // The gate is the thread's own, not a weaker one, because opening reaches
  // into the conversation rather than reading a row.
  const outsider = await makeUser('open-by-id-outsider@example.test')
  const refusal = await captureRefusal(() => model.openThreadSession(reqAs(outsider), started.thread.id))
  assert.equal(refusal.code, 'not-found')
  const fabricated = await captureRefusal(() => model.openThreadSession(reqAs(owner), crypto.randomUUID()))
  assert.equal(fabricated.code, 'not-found')
  assert.equal(refusal.message, fabricated.message, 'a non-member and a missing thread stay indistinguishable')
})

// ---------------------------------------------------------------------------
// STARTING A THREAD AS AN AGENT. The agent-gated counterpart to startThread,
// and the only way an agent can reach a colleague who has no thread yet.
//
// The gate is the CALLER's own membership; the target is named explicitly and
// resolved within the chat's roster, so "no such agent" and "that agent is not
// in this chat" arrive as one refusal. Every creation still goes through
// createThread, so parity with a UI-created thread is structural rather than
// something these tests have to police field by field -- but the session key
// and the standing-context delivery are checked anyway, because they are what
// a thread has to get right to be usable at all.
// ---------------------------------------------------------------------------

test('an agent starts a thread for a colleague who has none, and the first message lands with the standing context', async () => {
  const owner = await makeUser('agent-start-owner@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent start delegation', 'ship the reconciliation')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session-2' })

  const inbox: string[] = []
  seedMockConnection(inbox, 'Agent Session Two')

  const started = await model.startThreadAsAgent(
    'Agent Session',
    chat.id,
    'Agent Session Two',
    'take the kit docs sweep',
  )
  await waitForPrompts(inbox, 1)

  assert.match(inbox[0] ?? '', /take the kit docs sweep/, 'the first message reaches the agent it was addressed to')
  assert.match(inbox[0] ?? '', /ship the reconciliation/, "and carries the chat's topic, exactly as a UI start does")
  assert.equal(started.thread.agentNodeId, 'agent-session-2', 'the thread is addressed to the NAMED agent')
  assert.match(
    started.thread.sessionKey,
    /^group-chat:agent-start-delegation:agent-session-two:/,
    'same session key shape a UI-created thread gets -- one mint, one format',
  )
})

test('an agent-started thread is indistinguishable from a UI-started one', async () => {
  const owner = await makeUser('agent-start-parity@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent start parity', 'compare the two paths')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session-2' })
  seedMockConnection([], 'Agent Session Two')

  const byUser = await model.startThread(reqAs(owner), chat.id, 'agent-session-2', 'from a person', {
    title: 'Made By Hand',
  })
  const byAgent = await model.startThreadAsAgent('Agent Session', chat.id, 'Agent Session Two', 'from an agent', {
    title: 'Made By Agent',
  })

  // Same title-to-slug rule on both paths, so the address reads the same way.
  assert.match(byUser.thread.sessionKey, /:made-by-hand$/)
  assert.match(byAgent.thread.sessionKey, /:made-by-agent$/)
  const shapeOf = (key: string) => key.split(':').length
  assert.equal(shapeOf(byAgent.thread.sessionKey), shapeOf(byUser.thread.sessionKey))

  // The one field that legitimately differs, and it is provenance rather than
  // behaviour: no user did this, so the column says so instead of naming one.
  const [agentRow] = await db
    .select({ createdByUserId: groupChatThread.createdByUserId })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, byAgent.thread.id))
  const [userRow] = await db
    .select({ createdByUserId: groupChatThread.createdByUserId })
    .from(groupChatThread)
    .where(eq(groupChatThread.id, byUser.thread.id))
  assert.equal(agentRow?.createdByUserId, null, 'an agent-started thread claims no user as its creator')
  assert.equal(userRow?.createdByUserId, owner.id)
})

test('a caller that is not a member of the chat is refused, with the refusal a missing thread gives', async () => {
  const owner = await makeUser('agent-start-outsider@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent start closed room', 'members only')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session-2' })
  seedMockConnection([], 'Agent Session Two')

  // 'Agent Session' was never added to this chat.
  const refusal = await captureRefusal(() =>
    model.startThreadAsAgent('Agent Session', chat.id, 'Agent Session Two', 'let me in'),
  )
  const missingThread = await captureRefusal(() =>
    model.sendMessageInThreadAsAgent('Agent Session', 'nope:nope:nope', 'x'),
  )
  assert.deepEqual(refusal, missingThread, 'a non-member caller learns exactly what a bad thread reference teaches')
})

test('a target agent that is not a member is refused the same way, and so is a name that matches nothing', async () => {
  const owner = await makeUser('agent-start-nonmember-target@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent start one member', 'only one agent here')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })

  // A real agent node, but not a member of THIS chat.
  const nonMember = await captureRefusal(() =>
    model.startThreadAsAgent('Agent Session', chat.id, 'Agent Session Two', 'hello'),
  )
  // Not an agent at all.
  const unknown = await captureRefusal(() =>
    model.startThreadAsAgent('Agent Session', chat.id, 'No Such Agent At All', 'hello'),
  )
  assert.equal(nonMember.code, 'not-found')
  assert.deepEqual(
    nonMember,
    unknown,
    'a real non-member and an invented name are one refusal: the caller is not entitled to tell them apart',
  )
})

test('a chat the caller cannot see refuses identically to one that does not exist', async () => {
  const owner = await makeUser('agent-start-hidden-chat@example.test')
  const hidden = await model.createGroupChat(reqAs(owner), 'agent start hidden chat', 'private')
  await model.addMember(reqAs(owner), hidden.id, { kind: 'agent', agentNodeId: 'agent-session-2' })

  const real = await captureRefusal(() =>
    model.startThreadAsAgent('Agent Session', hidden.id, 'Agent Session Two', 'hi'),
  )
  const imaginary = await captureRefusal(() =>
    model.startThreadAsAgent('Agent Session', 'no-such-chat-id', 'Agent Session Two', 'hi'),
  )
  assert.deepEqual(real, imaginary, 'existence of a chat is not something a non-member may probe')
})

test("group_chat_list reports each chat's agent members, so the target name can be read rather than guessed", async () => {
  const owner = await makeUser('agent-start-members@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent start roster', 'who is here')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session-2' })

  const seen = (await model.listGroupChatsForAgentView('Agent Session')).find((c) => c.ref === chat.id)
  assert.ok(seen)
  assert.deepEqual(
    [...seen.members].sort(),
    ['Agent Session', 'Agent Session Two'],
    'the roster a start_thread caller needs, including the caller itself -- naming yourself is a legitimate target',
  )
})

test('an empty first message is refused before a thread is created', async () => {
  const owner = await makeUser('agent-start-empty@example.test')
  const chat = await model.createGroupChat(reqAs(owner), 'agent start empty send', 'no blanks')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session' })
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-session-2' })

  await assert.rejects(() => model.startThreadAsAgent('Agent Session', chat.id, 'Agent Session Two', '   '))
  const threads = await db.select().from(groupChatThread).where(eq(groupChatThread.groupChatId, chat.id))
  assert.equal(threads.length, 0, 'a refused start leaves no half-made thread behind')
})
