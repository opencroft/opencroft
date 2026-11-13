// Thread activity as extensions read it, against the real engine and thread
// rows on a throwaway database: who may read which chat's threads, the order
// and paging of the list, and the subscription hearing a turn start and end.
// Sessions are opened on a mock connection whose turns end when the test says
// so, as agent-presence.test.ts does.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { agentSessionEvent, db, groupChat, groupChatMember, groupChatThread, user } from '@opencroft/db'
import type { HostGroupChatThread, HostPersonGroupChatsApi } from '@opencroft/server/chat'
import { connectionKey } from 'agent-client/agent-client'
import type { AgentConnection } from 'agent-client/connection'
import type { AgentSelection } from 'agent-client/types'
import { eq } from 'drizzle-orm'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import type { SessionActivitySets } from '@/app/_authed/(agent)/_shared/session-status'
import { createHost, groupChatsForCaller, subscriptionHolder } from '@/app/_authed/(extension-runtime)/_server/host'
import { moveThreadBetweenLists } from '@/app/_authed/(group-chats)/_server/thread-archive'
import { hostThreadContext, threadStatus } from './thread-activity'

// ── threadStatus ────────────────────────────────────────────────────────

function sets(partial: Partial<Record<keyof SessionActivitySets, string[]>>): SessionActivitySets {
  const of = (key: keyof SessionActivitySets) => new Set(partial[key] ?? [])
  return {
    pending: of('pending'),
    active: of('active'),
    background: of('background'),
    queued: of('queued'),
    compacting: of('compacting'),
    alive: of('alive'),
  }
}

test('a thread reads as the chat classifies its session, in the API words', () => {
  assert.equal(threadStatus('k', false, sets({})), 'offline')
  assert.equal(threadStatus('k', false, sets({ alive: ['k'] })), 'idle')
  assert.equal(threadStatus('k', false, sets({ alive: ['k'], queued: ['k'] })), 'idle')
  assert.equal(threadStatus('k', false, sets({ alive: ['k'], active: ['k'] })), 'working')
  assert.equal(threadStatus('k', false, sets({ alive: ['k'], background: ['k'] })), 'working')
  assert.equal(threadStatus('k', false, sets({ alive: ['k'], active: ['k'], pending: ['k'] })), 'waiting')
})

test('compacting reads over the turn it runs in, and archived over everything', () => {
  const compacting = sets({ alive: ['k'], active: ['k'], compacting: ['k'] })
  assert.equal(threadStatus('k', false, compacting), 'compacting')
  assert.equal(threadStatus('k', true, compacting), 'archived')
  assert.equal(threadStatus('k', true, sets({})), 'archived')
})

test('a context reading keeps its numbers, gives asOf as an ISO time, and drops cost', () => {
  assert.equal(hostThreadContext(null), null)
  assert.deepEqual(
    hostThreadContext({ usedTokens: 10, contextLimit: 100, cost: { amount: 1, currency: 'USD' } } as never),
    { usedTokens: 10, contextLimit: 100 },
  )
  assert.deepEqual(hostThreadContext({ usedTokens: 10, contextLimit: null, asOf: 0 }), {
    usedTokens: 10,
    contextLimit: null,
    asOf: '1970-01-01T00:00:00.000Z',
  })
})

// ── fixtures ────────────────────────────────────────────────────────────

interface AcpStoreShape {
  connections: Map<string, unknown>
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitFor: condition never became true')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const EXTENSION = 'acme.thread-activity'
const SYSTEM_ID = 'system.ext.acme.thread-activity'
// Builds the host once, which is what registers the extension's system identity.
const host = createHost(EXTENSION)

async function makeChat(label: string): Promise<{ id: string; slug: string }> {
  const id = crypto.randomUUID()
  const [chat] = await db
    .insert(groupChat)
    .values({ slug: `${label}-${id}`, name: `${label} ${id}`, topic: label })
    .returning()
  assert.ok(chat)
  return { id: chat.id, slug: chat.slug }
}

async function makePerson(): Promise<string> {
  const id = `person-${crypto.randomUUID()}`
  await db.insert(user).values({ id, name: id, email: `${id}@example.test` })
  return id
}

async function letIn(chatId: string, member: { userId: string } | { systemId: string }): Promise<void> {
  await db
    .insert(groupChatMember)
    .values(
      'userId' in member
        ? { groupChatId: chatId, principalType: 'user', userId: member.userId }
        : { groupChatId: chatId, principalType: 'system', systemId: member.systemId },
    )
}

async function makeThread(chatId: string, title: string): Promise<{ id: string; sessionKey: string }> {
  const sessionKey = `group-chat.activity-${crypto.randomUUID()}`
  const [thread] = await db
    .insert(groupChatThread)
    .values({ groupChatId: chatId, agentNodeId: 'agent-activity', sessionKey, title })
    .returning()
  assert.ok(thread)
  return { id: thread.id, sessionKey }
}

/** A recorded session event at `at`, which is what a thread's `lastTurnAt` reads when it is not loaded. */
async function recordEventAt(sessionKey: string, at: string): Promise<void> {
  await db.insert(agentSessionEvent).values({ sessionKey, position: 0, event: {}, createdAt: new Date(at) })
}

/** A session open in the engine under `sessionKey`; its turns end on `endTurn`. */
async function openSession(sessionKey: string): Promise<{ sessionId: string; endTurn: () => void }> {
  const id = crypto.randomUUID()
  const turns: Array<(value: { stopReason: string }) => void> = []
  const connection = {
    newSession: async () => ({ sessionId: `activity-session-${id}` }),
    prompt: () => new Promise((resolve) => turns.push(resolve)),
    cancel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/activity-test-${id}`,
    sessionKey,
  }
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const meta = await agentClient.createSession(selection)
  return { sessionId: meta.id, endTurn: () => turns.shift()?.({ stopReason: 'end_turn' }) }
}

function personApi(userId: string): { api: HostPersonGroupChatsApi; end: () => void } {
  const { api, end } = groupChatsForCaller(EXTENSION, { person: { id: userId, name: userId, avatarUrl: null } })
  return { api: api as HostPersonGroupChatsApi, end }
}

const titles = (threads: readonly HostGroupChatThread[]) => threads.map((thread) => thread.title)

// ── who reads what ──────────────────────────────────────────────────────

test("a person-called action lists the threads of the person's chats only, the extension's grants not included", async () => {
  const mine = await makeChat('mine')
  const granted = await makeChat('granted')
  const person = await makePerson()
  await letIn(mine.id, { userId: person })
  await letIn(granted.id, { systemId: SYSTEM_ID })
  await makeThread(mine.id, 'in my chat')
  await makeThread(granted.id, 'in the granted chat')

  const { api, end } = personApi(person)
  try {
    const page = await api.activity()
    assert.deepEqual(titles(page.threads), ['in my chat'])
    const [row] = page.threads
    assert.equal(row?.chat.ref, mine.id)
    assert.equal(row?.status, 'offline')
    assert.equal(row?.folder, null)
    assert.equal(row?.contextUsage, null)
    assert.equal(row?.lastTurnAt, null)
    assert.equal(page.nextCursor, null)
    await assert.rejects(() => api.activity({ chat: granted.slug }), /Not available/)
  } finally {
    end()
  }
  await assert.rejects(() => api.activity(), /action call that has ended/)
})

test("under the extension's own identity it lists only the granted chats' threads", async () => {
  const granted = await makeChat('granted-only')
  const other = await makeChat('not-granted')
  await letIn(granted.id, { systemId: SYSTEM_ID })
  await letIn(other.id, { userId: await makePerson() })
  await makeThread(granted.id, 'granted thread')
  await makeThread(other.id, 'someone else thread')

  const listed = await host.groupChats.activity({ chat: granted.slug })
  assert.deepEqual(titles(listed.threads), ['granted thread'])
  assert.equal(
    (await host.groupChats.activity()).threads.some((thread) => thread.chat.ref === other.id),
    false,
    'nothing of a chat the extension was not let into',
  )
  const refused = await host.groupChats.activity({ chat: other.slug }).catch((error: Error) => error.message)
  const missing = await host.groupChats.activity({ chat: 'no-such-chat' }).catch((error: Error) => error.message)
  assert.equal(refused, missing, 'a chat it was not let into reads as one that does not exist')
})

test('archived threads are left out unless asked for, and then read archived', async () => {
  const chat = await makeChat('archive')
  await letIn(chat.id, { systemId: SYSTEM_ID })
  await makeThread(chat.id, 'open')
  const closed = await makeThread(chat.id, 'closed')
  await moveThreadBetweenLists({ id: closed.id, groupChatId: chat.id, sessionKey: closed.sessionKey }, true)

  assert.deepEqual(titles((await host.groupChats.activity({ chat: chat.slug })).threads), ['open'])
  const all = (await host.groupChats.activity({ chat: chat.slug, includeArchived: true })).threads
  assert.deepEqual(all.map((thread) => [thread.title, thread.status, thread.archived]).sort(), [
    ['closed', 'archived', true],
    ['open', 'offline', false],
  ])
})

// ── order and paging ────────────────────────────────────────────────────

test('most recently active first, never-active last, paged once through with nextCursor', async () => {
  const chat = await makeChat('paging')
  await letIn(chat.id, { systemId: SYSTEM_ID })
  const older = await makeThread(chat.id, 'older')
  const newer = await makeThread(chat.id, 'newer')
  await makeThread(chat.id, 'never')
  await recordEventAt(older.sessionKey, '2026-01-01T00:00:00.000Z')
  await recordEventAt(newer.sessionKey, '2026-02-01T00:00:00.000Z')

  const whole = await host.groupChats.activity({ chat: chat.slug })
  assert.deepEqual(titles(whole.threads), ['newer', 'older', 'never'])
  assert.equal(whole.threads[0]?.lastTurnAt, '2026-02-01T00:00:00.000Z')

  const seen: Array<string | null> = []
  let cursor: string | undefined
  for (let page = 0; page < 5; page += 1) {
    const read = await host.groupChats.activity({ chat: chat.slug, limit: 1, cursor })
    seen.push(...titles(read.threads))
    if (!read.nextCursor) {
      break
    }
    cursor = read.nextCursor
  }
  assert.deepEqual(seen, ['newer', 'older', 'never'])

  assert.deepEqual(
    titles((await host.groupChats.activity({ chat: chat.slug, since: '2026-01-15T00:00:00.000Z' })).threads),
    ['newer'],
  )
})

test('a malformed limit, since or cursor is refused with what it must be', async () => {
  await assert.rejects(() => host.groupChats.activity({ limit: 0 }), /"limit" must be a whole number from 1 to 500/)
  await assert.rejects(() => host.groupChats.activity({ limit: 501 }), /"limit"/)
  await assert.rejects(() => host.groupChats.activity({ since: 'yesterday' }), /"since" must be an ISO date/)
  await assert.rejects(() => host.groupChats.activity({ cursor: 'not-a-cursor' }), /"cursor" must be a `nextCursor`/)
})

// ── the subscription ────────────────────────────────────────────────────

test('a granted subscriber hears its thread go working then idle as a turn runs; a reader of other chats hears nothing', async () => {
  const chat = await makeChat('live')
  await letIn(chat.id, { systemId: SYSTEM_ID })
  const thread = await makeThread(chat.id, 'live thread')
  const outsider = await makePerson()
  await letIn((await makeChat('elsewhere')).id, { userId: outsider })

  const heard: HostGroupChatThread[] = []
  const unsubscribe = host.groupChats.subscribeActivity((row) => {
    if (row.threadId === thread.id) {
      heard.push(row)
    }
  })
  const outside = personApi(outsider)
  const heardOutside: HostGroupChatThread[] = []
  outside.api.subscribeActivity((row) => {
    heardOutside.push(row)
  })
  try {
    // Let the watcher take its baseline before anything moves.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const session = await openSession(thread.sessionKey)
    await waitFor(() => heard.some((row) => row.status === 'idle'))
    await agentClient.prompt(session.sessionId, 'work', {
      queue: 'wait',
      origin: { kind: 'message', sender: 'Reader' },
    })
    await waitFor(() => heard.some((row) => row.status === 'working'))
    session.endTurn()
    await waitFor(() => heard.at(-1)?.status === 'idle' && heard.some((row) => row.status === 'working'))

    const statuses = heard.map((row) => row.status)
    assert.deepEqual(statuses.slice(statuses.indexOf('working')), ['working', 'idle'])
    assert.equal(heard.at(-1)?.chat.ref, chat.id)
    assert.ok(heard.at(-1)?.lastTurnAt, 'a session that ran a turn has a last turn')
    assert.equal(
      heardOutside.some((row) => row.threadId === thread.id),
      false,
      'nothing from a chat the reader is not in',
    )
  } finally {
    unsubscribe()
    outside.end()
  }
})

test("a subscription ends with what holds it: the module's holder, or the action that made it", async () => {
  const chat = await makeChat('held')
  await letIn(chat.id, { systemId: SYSTEM_ID })
  const person = await makePerson()
  await letIn(chat.id, { userId: person })
  const thread = await makeThread(chat.id, 'held thread')

  const holder = subscriptionHolder()
  const moduleHost = createHost(EXTENSION, holder.hold)
  const throughModule: HostGroupChatThread[] = []
  moduleHost.groupChats.subscribeActivity((row) => {
    throughModule.push(row)
  })
  const call = personApi(person)
  const throughCall: HostGroupChatThread[] = []
  call.api.subscribeActivity((row) => {
    throughCall.push(row)
  })
  const control: HostGroupChatThread[] = []
  const unsubscribe = host.groupChats.subscribeActivity((row) => {
    if (row.threadId === thread.id) {
      control.push(row)
    }
  })
  try {
    holder.end()
    call.end()
    assert.throws(() => call.api.subscribeActivity(() => {}), /action call that has ended/)
    await new Promise((resolve) => setTimeout(resolve, 50))
    await openSession(thread.sessionKey)
    await waitFor(() => control.length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.deepEqual(throughModule, [])
    assert.deepEqual(throughCall, [])
  } finally {
    unsubscribe()
  }
})

test('archiving a thread is heard as a change to archived', async () => {
  const chat = await makeChat('archive-heard')
  await letIn(chat.id, { systemId: SYSTEM_ID })
  const thread = await makeThread(chat.id, 'to archive')
  const heard: HostGroupChatThread[] = []
  const unsubscribe = host.groupChats.subscribeActivity((row) => {
    if (row.threadId === thread.id) {
      heard.push(row)
    }
  })
  try {
    await new Promise((resolve) => setTimeout(resolve, 50))
    await moveThreadBetweenLists({ id: thread.id, groupChatId: chat.id, sessionKey: thread.sessionKey }, true)
    await waitFor(() => heard.length >= 1)
    assert.equal(heard[0]?.status, 'archived')
    assert.equal(heard[0]?.archived, true)
    const [row] = await db.select().from(groupChatThread).where(eq(groupChatThread.id, thread.id))
    assert.ok(row?.archivedAt)
  } finally {
    unsubscribe()
  }
})
