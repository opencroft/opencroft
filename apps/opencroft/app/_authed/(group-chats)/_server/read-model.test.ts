// The reading surface's view model, against a real database and real Better
// Auth sessions — same setup as model.test.ts, and for the same reason: what
// is under test is that the resolution actually agrees with the tables and
// the space graph, which a mock would assume rather than show.

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'

const workdir = await mkdtemp(join(tmpdir(), 'opencroft-group-chats-view-test-'))
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
process.env.NODE_ENV = 'development'

const { db, groupChatMember, groupChatThread, space } = await import('@opencroft/db')
const model = await import('./model')
const view = await import('./read-model')
const { ensureAuth } = await import('@opencroft/auth/server')

after(async () => {
  await rm(workdir, { recursive: true, force: true })
})

// Two real agent nodes, seeded before anything reads the space registry.
await db.insert(space).values({
  slug: 'test-space',
  name: 'Test Space',
  data: JSON.stringify({
    nodes: [
      { id: 'agent-a', type: 'builtin.core.agent', data: { name: 'Agent A', avatar: 'https://example.test/a.png' } },
      { id: 'agent-b', type: 'builtin.core.agent', data: { name: 'Agent B' } },
    ],
    edges: [],
  }),
})

interface TestUser {
  id: string
  name: string
  cookie: string
}

async function makeUser(email: string, name: string): Promise<TestUser> {
  const result = await ensureAuth().api.signUpEmail({
    body: { name, email, password: 'password123456' },
    asResponse: true,
  })
  const setCookie = result.headers.get('set-cookie')
  assert.ok(setCookie, 'sign-up must return a session cookie')
  const cookie = setCookie.split(';')[0]
  assert.ok(cookie)
  const body = (await result.json()) as { user: { id: string } }
  return { id: body.user.id, name, cookie }
}

function reqAs(u: TestUser): Request {
  return new Request('http://localhost:9999/', { headers: { cookie: u.cookie } })
}

test('the list resolves member names and avatars, and counts threads', async () => {
  const owner = await makeUser('view-owner@example.test', 'Owner Person')
  const chat = await model.createGroupChat(reqAs(owner), 'resolution')

  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  await db.insert(groupChatThread).values({
    groupChatId: chat.id,
    agentNodeId: 'agent-a',
    sessionKey: `group-chat:${chat.id}:agent-a:fixture-1`,
    createdByUserId: owner.id,
  })

  const list = await view.listGroupChatsForUserView(reqAs(owner))
  const entry = list.find((c) => c.id === chat.id)
  assert.ok(entry, 'the creator must see their own group chat')
  assert.equal(entry.topic, 'resolution')
  assert.equal(entry.threadCount, 1, 'threadCount must reflect the thread that exists')

  const agent = entry.members.find((m) => m.kind === 'agent')
  assert.ok(agent, 'the agent member must be present')
  assert.equal(agent.name, 'Agent A', 'the agent node id must be resolved to its name')
  assert.equal(agent.avatarUrl, 'https://example.test/a.png')

  const person = entry.members.find((m) => m.kind === 'user')
  assert.ok(person, 'the creator is a member and must be present')
  assert.equal(person.name, 'Owner Person', 'the user id must be resolved to the account name')
})

test('a thread carries its agent resolved, not a bare node id', async () => {
  const owner = await makeUser('view-threads@example.test', 'Thread Owner')
  const chat = await model.createGroupChat(reqAs(owner), 'threads')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-b' })
  await db.insert(groupChatThread).values({
    groupChatId: chat.id,
    agentNodeId: 'agent-b',
    sessionKey: `group-chat:${chat.id}:agent-b:fixture-2`,
    createdByUserId: owner.id,
  })

  const threads = await view.listThreadsInGroupChatView(reqAs(owner), chat.id)
  assert.equal(threads.length, 1)
  assert.equal(threads[0].agent.nodeId, 'agent-b')
  assert.equal(threads[0].agent.name, 'Agent B')
  assert.equal(threads[0].agent.avatarUrl, null, 'an agent with no avatar resolves to null, not undefined')
  assert.equal(
    threads[0].sessionKey,
    `group-chat:${chat.id}:agent-b:fixture-2`,
    'the list now carries the session key a row needs to ask the activity poll for its live status',
  )
})

// The list gets only the boolean, the single-thread view gets the text itself
// -- same reasoning as sessionKey's own doc comment: twenty rows have no use
// for twenty drafts.
test('hasDraft reflects an unsent draft on both the list and the single-thread view, cleared by an empty string', async () => {
  const owner = await makeUser('view-draft@example.test', 'Draft Owner')
  const chat = await model.createGroupChat(reqAs(owner), 'drafts')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:draft-fixture`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  const beforeList = await view.listThreadsInGroupChatView(reqAs(owner), chat.id)
  assert.equal(beforeList[0]?.hasDraft, false, 'no draft yet')
  const beforeSingle = await view.findThreadViewInGroupChat(reqAs(owner), chat.id, thread.id)
  assert.ok(beforeSingle)
  assert.equal(beforeSingle.hasDraft, false)
  assert.equal(beforeSingle.draft, null)

  await model.setThreadDraft(reqAs(owner), thread.id, 'unsent text')

  const afterList = await view.listThreadsInGroupChatView(reqAs(owner), chat.id)
  assert.equal(afterList[0]?.hasDraft, true, 'the list must reflect the saved draft')
  const afterSingle = await view.findThreadViewInGroupChat(reqAs(owner), chat.id, thread.id)
  assert.ok(afterSingle)
  assert.equal(afterSingle.hasDraft, true)
  assert.equal(afterSingle.draft, 'unsent text', 'the single-thread view carries the text itself, unlike the list')

  await model.setThreadDraft(reqAs(owner), thread.id, '')

  const cleared = await view.findThreadViewInGroupChat(reqAs(owner), chat.id, thread.id)
  assert.ok(cleared)
  assert.equal(cleared.hasDraft, false, 'an empty string clears the draft, the same as the 1:1 chat')
})

// The flag the thread list renders a removed agent's thread from. It is the
// membership fact, not the presentation: the screen turns it into `disabled`.
test('a thread reports whether its agent is still a member, before and after removal', async () => {
  const owner = await makeUser('view-membership@example.test', 'Membership Owner')
  const chat = await model.createGroupChat(reqAs(owner), 'membership on threads')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  await db.insert(groupChatThread).values({
    groupChatId: chat.id,
    agentNodeId: 'agent-a',
    sessionKey: `group-chat:${chat.id}:agent-a:membership-fixture`,
    createdByUserId: owner.id,
  })

  const before = await view.listThreadsInGroupChatView(reqAs(owner), chat.id)
  assert.equal(before.length, 1)
  assert.equal(before[0].agentIsMember, true, 'an ordinary thread reports its agent as a member')

  await model.removeMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  const after = await view.listThreadsInGroupChatView(reqAs(owner), chat.id)
  assert.equal(after.length, 1, 'the thread is kept, so it can still be read')
  assert.equal(after[0].agentIsMember, false, 'and it now reports the agent as no longer a member')

  // The single-thread read has to agree with the list one — the thread screen
  // reads through that path, not this one.
  const single = await view.findThreadViewInGroupChat(reqAs(owner), chat.id, after[0].id)
  assert.ok(single)
  assert.equal(single.agentIsMember, false, 'the single-thread view must not disagree with the list')
})

// The important robustness case: agentNodeId is deliberately NOT a foreign
// key, because agent nodes live in space-graph JSON. So a membership row or a
// thread can outlive the node it points at, and the view must survive that.
test('a thread whose agent no longer exists still renders, with a placeholder', async () => {
  const owner = await makeUser('view-dangling@example.test', 'Dangling Owner')
  const chat = await model.createGroupChat(reqAs(owner), 'dangling')

  // Inserted directly: addMember would (correctly) refuse a node that is not
  // in the graph, which is exactly why this state can only arise later, by
  // deletion.
  await db
    .insert(groupChatMember)
    .values({ groupChatId: chat.id, principalType: 'agent', agentNodeId: 'agent-deleted' })
  await db.insert(groupChatThread).values({
    groupChatId: chat.id,
    agentNodeId: 'agent-deleted',
    sessionKey: `group-chat:${chat.id}:agent-deleted:fixture-3`,
    createdByUserId: owner.id,
  })

  const threads = await view.listThreadsInGroupChatView(reqAs(owner), chat.id)
  assert.equal(threads.length, 1, 'a thread must not disappear because its agent was deleted')
  assert.equal(threads[0].agent.name, 'Unknown agent')
  assert.equal(threads[0].agent.nodeId, 'agent-deleted', 'the id is kept so the row is still identifiable')

  const detail = await view.getGroupChatDetailView(reqAs(owner), chat.id)
  const ghost = detail.members.find((m) => m.id === 'agent-deleted')
  assert.ok(ghost, 'a member whose node was deleted must still be listed, not silently dropped')
  assert.equal(ghost.name, 'Unknown agent')
})

// The view layer must inherit phase 1's gate rather than re-implement it —
// this is the proof it actually does, exercised through every view function.
test('the view layer refuses a non-member exactly as the model does', async () => {
  const owner = await makeUser('view-owner2@example.test', 'Owner Two')
  const outsider = await makeUser('view-outsider@example.test', 'Outsider')
  const chat = await model.createGroupChat(reqAs(owner), 'gated')
  const [thread] = await db
    .insert(groupChatThread)
    .values({
      groupChatId: chat.id,
      agentNodeId: 'agent-a',
      sessionKey: `group-chat:${chat.id}:agent-a:fixture-4`,
      createdByUserId: owner.id,
    })
    .returning()
  assert.ok(thread)

  await assert.rejects(
    () => view.getGroupChatDetailView(reqAs(outsider), chat.id),
    (error: unknown) => {
      assert.ok(error instanceof model.GroupChatAccessError)
      assert.equal(error.code, 'not-found')
      return true
    },
    'the enriched detail must refuse a non-member, not leak the topic',
  )

  await assert.rejects(
    () => view.listThreadsInGroupChatView(reqAs(outsider), chat.id),
    (error: unknown) => {
      assert.ok(error instanceof model.GroupChatAccessError)
      return true
    },
  )

  await assert.rejects(
    () => view.findThreadViewInGroupChat(reqAs(outsider), chat.id, thread.id),
    (error: unknown) => {
      assert.ok(error instanceof model.GroupChatAccessError)
      assert.equal(error.code, 'not-found')
      return true
    },
    'the enriched thread read must refuse a non-member',
  )

  const outsiderList = await view.listGroupChatsForUserView(reqAs(outsider))
  assert.equal(
    outsiderList.some((c) => c.id === chat.id),
    false,
    "a non-member's list must not include the chat",
  )
})

test('both the list and the detail view carry the name and the topic, kept apart', async () => {
  const owner = await makeUser('view-naming@example.test', 'Naming Owner')
  const chat = await model.createGroupChat(reqAs(owner), 'Release train', 'Ship without regressions')

  const entry = (await view.listGroupChatsForUserView(reqAs(owner))).find((c) => c.id === chat.id)
  assert.ok(entry)
  assert.equal(entry.name, 'Release train')
  assert.equal(entry.topic, 'Ship without regressions')

  const detail = await view.getGroupChatDetailView(reqAs(owner), chat.id)
  assert.equal(detail.name, 'Release train')
  assert.equal(detail.topic, 'Ship without regressions')

  // A rename must reach both surfaces without touching the topic on either --
  // the two travel together through every read, so one going stale would show
  // up here first.
  await model.renameGroupChat(reqAs(owner), chat.id, 'Release train 2')

  const renamedEntry = (await view.listGroupChatsForUserView(reqAs(owner))).find((c) => c.id === chat.id)
  assert.equal(renamedEntry?.name, 'Release train 2')
  assert.equal(renamedEntry?.topic, 'Ship without regressions')

  const renamedDetail = await view.getGroupChatDetailView(reqAs(owner), chat.id)
  assert.equal(renamedDetail.name, 'Release train 2')
  assert.equal(renamedDetail.topic, 'Ship without regressions')
})
