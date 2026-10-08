// The reading surface's view model, against a real database and real Better
// Auth sessions — same setup as model.test.ts, and for the same reason: what
// is under test is that the resolution actually agrees with the tables and
// the space graph, which a mock would assume rather than show.

import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

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

const { db, groupChatMember, groupChatThread, space, transcriptMessage } = await import('@opencroft/db')
const model = await import('./model')
const view = await import('./read-model')
const { queueStore } = await import('@/app/_authed/(agent)/_server/queue-store')
const { ensureAuth } = await import('@opencroft/auth/server')
const { readStoredAgentAvatar } = await import('@/app/_server/agent-avatar')
const { avatarResponse } = await import('@/app/_server/user-avatar')

// A stored picture, as an agent node holds one: a data URL.
const AGENT_C_AVATAR = `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64')}`

// Three real agent nodes, seeded before anything reads the space registry.
await db.insert(space).values({
  slug: 'test-space',
  name: 'Test Space',
  data: JSON.stringify({
    nodes: [
      { id: 'agent-a', type: 'builtin.core.agent', data: { name: 'Agent A', avatar: 'https://example.test/a.png' } },
      { id: 'agent-b', type: 'builtin.core.agent', data: { name: 'Agent B' } },
      { id: 'agent-c', type: 'builtin.core.agent', data: { name: 'Agent C', avatar: AGENT_C_AVATAR } },
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

test('a thread list read returns one list, and the chat counts its archive', async () => {
  const owner = await makeUser('view-lists@example.test', 'Lists Owner')
  const chat = await model.createGroupChat(reqAs(owner), 'lists')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const thread = async (name: string, archivedAt: Date | null) => {
    const [row] = await db
      .insert(groupChatThread)
      .values({
        groupChatId: chat.id,
        agentNodeId: 'agent-a',
        sessionKey: `group-chat:${chat.id}:agent-a:${name}`,
        createdByUserId: owner.id,
        archivedAt,
      })
      .returning()
    assert.ok(row)
    return row.id
  }
  const empty = await view.getGroupChatDetailView(reqAs(owner), chat.id)
  assert.equal(empty.archivedThreadCount, 0, 'a chat with no archive counts zero')

  const active = [await thread('active-1', null), await thread('active-2', null)]
  const archived = [
    await thread('archived-1', new Date()),
    await thread('archived-2', new Date()),
    await thread('archived-3', new Date()),
  ]

  const activeList = await view.listThreadsInGroupChatView(reqAs(owner), chat.id, 'active')
  assert.deepEqual(activeList.map((t) => t.id).sort(), [...active].sort())
  assert.ok(activeList.every((t) => !t.archived))
  const archiveList = await view.listThreadsInGroupChatView(reqAs(owner), chat.id, 'archive')
  assert.deepEqual(archiveList.map((t) => t.id).sort(), [...archived].sort())
  assert.ok(archiveList.every((t) => t.archived))

  const detail = await view.getGroupChatDetailView(reqAs(owner), chat.id)
  assert.equal(detail.archivedThreadCount, 3)
})

test('an agent picture stored as a data URL reaches the page as a versioned address, served from it', async () => {
  const owner = await makeUser('view-avatar@example.test', 'Avatar Owner')
  const chat = await model.createGroupChat(reqAs(owner), 'avatars')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-c' })
  await db.insert(groupChatThread).values({
    groupChatId: chat.id,
    agentNodeId: 'agent-c',
    sessionKey: `group-chat:${chat.id}:agent-c:avatar-fixture`,
    createdByUserId: owner.id,
  })
  const address = /^\/api\/avatars\/agents\/agent-c\?v=[0-9a-f]{16}$/

  const [row] = await view.listThreadsInGroupChatView(reqAs(owner), chat.id, 'active')
  assert.match(row?.agent.avatarUrl ?? '', address)
  const member = (await view.getGroupChatDetailView(reqAs(owner), chat.id)).members.find((m) => m.id === 'agent-c')
  assert.equal(member?.avatarUrl, row?.agent.avatarUrl, 'every place naming the agent hands out the same address')

  const response = avatarResponse(
    new Request(new URL(row?.agent.avatarUrl ?? '', 'http://localhost')),
    await readStoredAgentAvatar('agent-c'),
  )
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Content-Type'), 'image/png')
  assert.equal(response.headers.get('Cache-Control'), 'private, max-age=31536000, immutable')
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
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

  const threads = await view.listThreadsInGroupChatView(reqAs(owner), chat.id, 'active')
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

  const beforeList = await view.listThreadsInGroupChatView(reqAs(owner), chat.id, 'active')
  assert.equal(beforeList[0]?.hasDraft, false, 'no draft yet')
  const beforeSingle = await view.findThreadViewInGroupChat(reqAs(owner), chat.id, thread.id)
  assert.ok(beforeSingle)
  assert.equal(beforeSingle.hasDraft, false)
  assert.equal(beforeSingle.draft, null)

  await model.setThreadDraft(reqAs(owner), thread.id, 'unsent text')

  const afterList = await view.listThreadsInGroupChatView(reqAs(owner), chat.id, 'active')
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

// What the thread's screen draws under its loader before the session answers:
// the messages still waiting under the thread's session key, in the queue's
// own order, and none that have left it.
test('the single-thread view carries the messages waiting for its agent, in order, without removed ones', async () => {
  const owner = await makeUser('view-queue@example.test', 'Queue Owner')
  const chat = await model.createGroupChat(reqAs(owner), 'queues')
  await model.addMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })
  const sessionKey = `group-chat:${chat.id}:agent-a:queue-fixture`
  const [thread] = await db
    .insert(groupChatThread)
    .values({ groupChatId: chat.id, agentNodeId: 'agent-a', sessionKey, createdByUserId: owner.id })
    .returning()
  assert.ok(thread)

  const empty = await view.findThreadViewInGroupChat(reqAs(owner), chat.id, thread.id)
  assert.deepEqual(empty?.queue, { items: [] }, 'nothing waiting')

  const sentAt = '2026-10-08T12:00:00.000Z'
  const entry = (id: string, text: string) => ({
    id,
    kind: 'message' as const,
    sender: 'nobody-holds-this',
    sentAt,
    text,
  })
  await queueStore.append(sessionKey, entry(`${sessionKey}:1`, 'first'), 'end')
  await queueStore.append(sessionKey, entry(`${sessionKey}:2`, 'second'), 'end')
  await queueStore.append(sessionKey, entry(`${sessionKey}:3`, 'withdrawn'), 'end')
  await queueStore.append(sessionKey, entry(`${sessionKey}:0`, 'jumped the line'), 'front')
  await queueStore.remove(sessionKey, [`${sessionKey}:3`])
  // Another thread's queue is not this one's.
  await queueStore.append('group-chat:elsewhere', entry('elsewhere:1', 'not here'), 'end')

  const single = await view.findThreadViewInGroupChat(reqAs(owner), chat.id, thread.id)
  assert.deepEqual(
    single?.queue.items.map((item) => item.text),
    ['jumped the line', 'first', 'second'],
  )
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

  const before = await view.listThreadsInGroupChatView(reqAs(owner), chat.id, 'active')
  assert.equal(before.length, 1)
  assert.equal(before[0].agentIsMember, true, 'an ordinary thread reports its agent as a member')

  await model.removeMember(reqAs(owner), chat.id, { kind: 'agent', agentNodeId: 'agent-a' })

  const after = await view.listThreadsInGroupChatView(reqAs(owner), chat.id, 'active')
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

  const threads = await view.listThreadsInGroupChatView(reqAs(owner), chat.id, 'active')
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
    () => view.listThreadsInGroupChatView(reqAs(outsider), chat.id, 'active'),
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

test("a transcript search answers from this chat's threads only, archived ones only when asked, and refuses a non-member", async () => {
  const owner = await makeUser('view-search@example.test', 'Search Owner')
  const outsider = await makeUser('view-search-outsider@example.test', 'Search Outsider')
  const chat = await model.createGroupChat(reqAs(owner), 'searchable')
  const other = await model.createGroupChat(reqAs(owner), 'elsewhere')
  const thread = async (groupChatId: string, key: string, archivedAt: Date | null) => {
    const [row] = await db
      .insert(groupChatThread)
      .values({ groupChatId, agentNodeId: 'agent-a', sessionKey: key, createdByUserId: owner.id, archivedAt })
      .returning()
    assert.ok(row)
    await db.insert(transcriptMessage).values({
      sessionKey: key,
      position: 3,
      segment: 0,
      role: 'agent',
      turn: 2,
      text: 'the rollout finished',
      createdAt: new Date(),
    })
    return row.id
  }
  const active = await thread(chat.id, `group-chat:${chat.id}:agent-a:search-active`, null)
  const archived = await thread(chat.id, `group-chat:${chat.id}:agent-a:search-archived`, new Date())
  await thread(other.id, `group-chat:${other.id}:agent-a:search-other`, null)

  const threadsOf = (result: { hits: { threadId: string }[] }) => result.hits.map((hit) => hit.threadId).sort()
  assert.deepEqual(threadsOf(await view.searchThreadTranscriptsView(reqAs(owner), chat.id, 'rollout', false)), [active])
  assert.deepEqual(
    threadsOf(await view.searchThreadTranscriptsView(reqAs(owner), chat.id, 'rollout', true)),
    [active, archived].sort(),
  )
  const [hit] = (await view.searchThreadTranscriptsView(reqAs(owner), chat.id, 'rollout', false)).hits
  assert.deepEqual([hit?.position, hit?.role, hit?.turn], [3, 'agent', 2])

  await assert.rejects(
    () => view.searchThreadTranscriptsView(reqAs(outsider), chat.id, 'rollout', true),
    (error: unknown) => {
      assert.ok(error instanceof model.GroupChatAccessError)
      return true
    },
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
