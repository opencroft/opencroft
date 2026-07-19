import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentClient } from './agent-client'
import type { AgentConnection } from './connection'
import { buildSpawnConfig } from './resolve'
import type { AgentSelection, ChatEvent } from './types'

// ── prompt queue / turn guard ──────────────────────────────────────────────
//
// The engine keys live connections by their spawn config and reuses a seeded
// entry instead of spawning a subprocess — the seam these tests use: a mock
// connection is registered under the selection's key, and its prompt() hands
// back a promise the test resolves/rejects to end turns by hand. The adapter is
// one that opts out of per-session MCP servers, so createSession never starts
// the built-in MCP server.

interface AcpStoreShape {
  connections: Map<string, unknown>
}

let counter = 0

async function setup() {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const promptCalls: string[] = []
  let resolveTurn: ((value: { stopReason: string }) => void) | undefined
  let rejectTurn: ((error: Error) => void) | undefined
  const connection = {
    newSession: async () => ({ sessionId: `test-session-${counter}` }),
    prompt: (params: { prompt: Array<{ text: string }> }) => {
      promptCalls.push(params.prompt[0].text)
      return new Promise((resolve, reject) => {
        resolveTurn = resolve
        rejectTurn = reject
      })
    },
    cancel: async () => {},
  } as unknown as AgentConnection
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient()
  const meta = await client.createSession(selection)
  const events: ChatEvent[] = []
  client.subscribe(meta.id, (event) => events.push(event))
  return {
    client,
    sessionId: meta.id,
    events,
    promptCalls,
    endTurn: () => resolveTurn?.({ stopReason: 'end_turn' }),
    failTurn: (message: string) => rejectTurn?.(new Error(message)),
  }
}

// Let the promise chain after a resolved/rejected turn (terminal event emit,
// drain, next delivery) run to completion.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

function queueSnapshots(events: ChatEvent[]): string[][] {
  return events
    .filter((event): event is Extract<ChatEvent, { kind: 'queue' }> => event.kind === 'queue')
    .map((event) => event.items.map((item) => item.text))
}

function kinds(events: ChatEvent[]): string[] {
  return events.map((event) => event.kind)
}

test('prompt during an active turn queues and emits a snapshot', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  await h.client.prompt(h.sessionId, 'third')
  // Only the first prompt reached the agent; the rest were held.
  assert.deepEqual(h.promptCalls, ['first'])
  assert.deepEqual(queueSnapshots(h.events), [['second'], ['second', 'third']])
  h.client.deleteSession(h.sessionId)
})

test('turn end drains the queue in order, one message per turn', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  await h.client.prompt(h.sessionId, 'third')
  h.endTurn()
  await settle()
  // One drained delivery per turn end, not the whole queue at once.
  assert.deepEqual(h.promptCalls, ['first', 'second'])
  h.endTurn()
  await settle()
  assert.deepEqual(h.promptCalls, ['first', 'second', 'third'])
  h.endTurn()
  await settle()
  // Snapshots: two enqueues, then one per drain, ending empty.
  assert.deepEqual(queueSnapshots(h.events), [['second'], ['second', 'third'], ['third'], []])
  // The terminal event precedes the drained user turn in the log.
  assert.deepEqual(
    kinds(h.events).filter((kind) => kind === 'user' || kind === 'turn_end'),
    ['user', 'turn_end', 'user', 'turn_end', 'user', 'turn_end'],
  )
  h.client.deleteSession(h.sessionId)
})

test('front-queued prompt jumps the line', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  await h.client.prompt(h.sessionId, 'urgent', { front: true })
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['urgent', 'second'])
  h.endTurn()
  await settle()
  assert.deepEqual(h.promptCalls, ['first', 'urgent'])
  h.client.deleteSession(h.sessionId)
})

test('removeQueued drops a held message and is a no-op for unknown ids', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  await h.client.prompt(h.sessionId, 'third')
  const queued = h.events.filter((event) => event.kind === 'queue').at(-1)
  assert.ok(queued && queued.kind === 'queue')
  h.client.removeQueued(h.sessionId, queued.items[0].id)
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['third'])
  const count = queueSnapshots(h.events).length
  h.client.removeQueued(h.sessionId, 'no-such-id')
  // Unknown id: no state change, no extra snapshot.
  assert.equal(queueSnapshots(h.events).length, count)
  h.endTurn()
  await settle()
  assert.deepEqual(h.promptCalls, ['first', 'third'])
  h.client.deleteSession(h.sessionId)
})

test('a failed turn emits an error and still drains the queue', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  h.failTurn('boom')
  await settle()
  const errorIndex = h.events.findIndex((event) => event.kind === 'error')
  assert.ok(errorIndex >= 0, 'expected an error event')
  // The queued message was delivered after the failure was surfaced.
  assert.deepEqual(h.promptCalls, ['first', 'second'])
  const secondUser = h.events.findIndex((event) => event.kind === 'user' && event.text === 'second')
  assert.ok(secondUser > errorIndex, 'drain must follow the terminal error event')
  h.client.deleteSession(h.sessionId)
})
