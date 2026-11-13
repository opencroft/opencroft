// Agent presence against the real engine, thread rows and agent directory on a
// throwaway database: sessions are opened on a mock connection whose turns end
// when the test says so, the way stream-compact-async.test.ts holds them.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { db, groupChat, groupChatThread } from '@opencroft/db'
import { connectionKey } from 'agent-client/agent-client'
import type { AgentConnection } from 'agent-client/connection'
import type { AgentSelection } from 'agent-client/types'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { sessionActivitySets } from '@/app/_authed/(agent)/_server/session-activity'
import { deriveSessionStatus, type SessionActivitySets } from '@/app/_authed/(agent)/_shared/session-status'
import { createHost, subscriptionHolder } from '@/app/_authed/(extension-runtime)/_server/host'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { type AgentPresence, agentStates, listAgentPresence, subscribeAgentPresence } from './agent-presence'

// ── agentStates ─────────────────────────────────────────────────────────

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

const threads = [
  { sessionKey: 'k1', agentNodeId: 'a' },
  { sessionKey: 'k2', agentNodeId: 'a' },
]

test('an agent with no live thread is offline, and one with no thread at all too', () => {
  assert.deepEqual(agentStates(['a', 'b'], threads, sets({})), [
    { agentNodeId: 'a', status: 'offline', activeThreads: 0 },
    { agentNodeId: 'b', status: 'offline', activeThreads: 0 },
  ])
})

test('a live thread with nothing running is idle, a queue held for a later turn included', () => {
  assert.deepEqual(agentStates(['a'], threads, sets({ alive: ['k1', 'k2'], queued: ['k2'] })), [
    { agentNodeId: 'a', status: 'idle', activeThreads: 0 },
  ])
})

test('a turn or background work makes the agent working', () => {
  for (const running of [{ active: ['k1'] }, { background: ['k1'] }]) {
    assert.deepEqual(agentStates(['a'], threads, sets({ alive: ['k1', 'k2'], ...running })), [
      { agentNodeId: 'a', status: 'working', activeThreads: 1 },
    ])
  }
})

test('a turn blocked on a person makes the agent waiting, ahead of another thread working', () => {
  const alive = ['k1', 'k2']
  assert.deepEqual(agentStates(['a'], threads, sets({ alive, active: ['k1'], pending: ['k1'] })), [
    { agentNodeId: 'a', status: 'waiting', activeThreads: 1 },
  ])
  assert.deepEqual(agentStates(['a'], threads, sets({ alive, active: ['k1', 'k2'], pending: ['k2'] })), [
    { agentNodeId: 'a', status: 'waiting', activeThreads: 2 },
  ])
})

test('compacting only while every active thread is compacting', () => {
  const alive = ['k1', 'k2']
  assert.deepEqual(agentStates(['a'], threads, sets({ alive, active: ['k1'], compacting: ['k1'] })), [
    { agentNodeId: 'a', status: 'compacting', activeThreads: 1 },
  ])
  assert.deepEqual(agentStates(['a'], threads, sets({ alive, active: ['k1', 'k2'], compacting: ['k1'] })), [
    { agentNodeId: 'a', status: 'working', activeThreads: 2 },
  ])
})

// ── against the engine ──────────────────────────────────────────────────

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

/** Two agents in a new space: `withThread` gets a thread with a live session, `withoutThread` none. */
async function agentsFixture(): Promise<{ withThread: string; withoutThread: string }> {
  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  const slug = `presence-${crypto.randomUUID()}`
  const withThread = `agent-${crypto.randomUUID()}`
  const withoutThread = `agent-${crypto.randomUUID()}`
  await registry.create(slug, slug, {
    nodes: [
      { id: withThread, type: 'builtin.core.agent', position: { x: 0, y: 0 }, data: { name: `Busy ${slug}` } },
      { id: withoutThread, type: 'builtin.core.agent', position: { x: 0, y: 0 }, data: { name: `Quiet ${slug}` } },
    ],
    edges: [],
  })
  return { withThread, withoutThread }
}

/** A thread of `agentNodeId` whose session is open in the engine; its turns end on `endTurn`. */
async function liveThread(
  agentNodeId: string,
): Promise<{ sessionKey: string; sessionId: string; endTurn: () => void }> {
  const id = crypto.randomUUID()
  const sessionKey = `group-chat.presence-${id}`
  const turns: Array<(value: { stopReason: string }) => void> = []
  const connection = {
    newSession: async () => ({ sessionId: `presence-session-${id}` }),
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
    cwd: `/tmp/presence-test-${id}`,
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
  const [chat] = await db
    .insert(groupChat)
    .values({ slug: `presence-${id}`, name: id, topic: id })
    .returning()
  await db.insert(groupChatThread).values({ groupChatId: chat.id, agentNodeId, sessionKey })
  const meta = await agentClient.createSession(selection)
  return { sessionKey, sessionId: meta.id, endTurn: () => turns.shift()?.({ stopReason: 'end_turn' }) }
}

async function startTurn(sessionId: string): Promise<void> {
  await agentClient.prompt(sessionId, 'work', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
}

async function presenceOf(agentNodeId: string): Promise<AgentPresence | undefined> {
  return (await listAgentPresence()).find((row) => row.agentNodeId === agentNodeId)
}

test("presence lists every directory agent in the directory's order, as its thread's status reads", async () => {
  const { withThread, withoutThread } = await agentsFixture()
  const thread = await liveThread(withThread)

  const presence = await listAgentPresence()
  const host = createHost('acme.presence-probe')
  assert.deepEqual(
    presence.map((row) => row.agentNodeId),
    (await host.agents.list()).map((agent) => agent.id),
  )
  assert.equal(deriveSessionStatus(thread.sessionKey, sessionActivitySets()), 'idle')
  const busy = await presenceOf(withThread)
  assert.equal(busy?.status, 'idle')
  assert.equal(busy?.activeThreads, 0)
  assert.ok(busy?.lastActiveAt && !Number.isNaN(Date.parse(busy.lastActiveAt)), 'a live session has been active')
  assert.deepEqual(await presenceOf(withoutThread), {
    agentNodeId: withoutThread,
    status: 'offline',
    activeThreads: 0,
    lastActiveAt: null,
  })

  await startTurn(thread.sessionId)
  await waitFor(() => deriveSessionStatus(thread.sessionKey, sessionActivitySets()) === 'working')
  assert.equal((await presenceOf(withThread))?.status, 'working')
  assert.equal((await presenceOf(withThread))?.activeThreads, 1)
  thread.endTurn()
  await waitFor(() => deriveSessionStatus(thread.sessionKey, sessionActivitySets()) === 'idle')
  assert.equal((await presenceOf(withThread))?.status, 'idle')
})

test('a subscriber hears the agent go working and back to idle as a turn starts and ends, unasked', async () => {
  const { withThread } = await agentsFixture()
  const thread = await liveThread(withThread)
  const heard: AgentPresence[] = []
  const unsubscribe = subscribeAgentPresence((presence) => {
    if (presence.agentNodeId === withThread) {
      heard.push(presence)
    }
  })
  try {
    await startTurn(thread.sessionId)
    await waitFor(() => heard.length >= 1)
    assert.equal(heard[0]?.status, 'working')
    assert.equal(heard[0]?.activeThreads, 1)

    thread.endTurn()
    await waitFor(() => heard.length >= 2)
    assert.equal(heard[1]?.status, 'idle')
    assert.equal(heard[1]?.activeThreads, 0)
    assert.ok(heard[1]?.lastActiveAt)
  } finally {
    unsubscribe()
  }
})

test("the host's subscription ends with what holds it, while another subscriber still hears", async () => {
  const { withThread } = await agentsFixture()
  const thread = await liveThread(withThread)
  const holder = subscriptionHolder()
  const host = createHost('acme.presence-holder', holder.hold)
  const throughHost: AgentPresence[] = []
  const control: AgentPresence[] = []
  host.agents.subscribePresence((presence) => {
    throughHost.push(presence)
  })
  const unsubscribe = subscribeAgentPresence((presence) => {
    if (presence.agentNodeId === withThread) {
      control.push(presence)
    }
  })
  try {
    holder.end()
    await startTurn(thread.sessionId)
    await waitFor(() => control.length >= 1)
    thread.endTurn()
    await waitFor(() => control.length >= 2)
    assert.deepEqual(throughHost, [])
  } finally {
    unsubscribe()
  }
})
