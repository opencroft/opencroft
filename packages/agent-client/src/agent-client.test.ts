import assert from 'node:assert/strict'
import test from 'node:test'

import { createAgentClient, handleUpdate } from './agent-client'
import type { AgentConnection } from './connection'
import { buildSpawnConfig, findAdapter } from './resolve'
import type { AgentSelection, ChatEvent } from './types'

// ── prompt queue / turn guard / mid-turn input ─────────────────────────────
//
// The engine keys live connections by their spawn config and reuses a seeded
// entry instead of spawning a subprocess — the seam these tests use: a mock
// connection is registered under the selection's key, and its prompt() hands
// back a promise the test resolves/rejects to end turns by hand. Overlapping
// prompts (mid-turn input) each get their own deferred; endTurn/failTurn
// settle a specific one by index, defaulting to the oldest. The default
// adapter opts out of per-session MCP servers, so createSession never starts
// the built-in MCP server; steering tests enable mid-turn input on their
// adapter's table entry for their duration (and clean up with reset() to
// close the MCP server that adapter's tool support brings up).

interface AcpStoreShape {
  connections: Map<string, unknown>
}

interface TurnDeferred {
  resolve: (value: { stopReason: string }) => void
  reject: (error: Error) => void
}

let counter = 0

async function setup(
  adapterId: 'openclaw' | 'claude' = 'openclaw',
  options: { reasoningEffort?: string; configOptions?: unknown } = {},
) {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId,
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
  }
  const promptCalls: string[] = []
  const configOptionCalls: Array<{ sessionId: string; configId: string; value: unknown }> = []
  const turns: TurnDeferred[] = []
  const takeTurn = (index?: number) => (index === undefined ? turns.shift() : turns.splice(index, 1)[0])
  const connection = {
    newSession: async () => ({
      sessionId: `test-session-${counter}`,
      configOptions: options.configOptions,
    }),
    prompt: (params: { prompt: Array<{ text: string }> }) => {
      promptCalls.push(params.prompt[0].text)
      return new Promise((resolve, reject) => {
        turns.push({ resolve, reject })
      })
    },
    cancel: async () => {},
    setSessionConfigOption: async (params: { sessionId: string; configId: string; value: unknown }) => {
      configOptionCalls.push(params)
      return { configOptions: options.configOptions }
    },
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
    configOptionCalls,
    endTurn: (index?: number) => takeTurn(index)?.resolve({ stopReason: 'end_turn' }),
    failTurn: (message: string, index?: number) => takeTurn(index)?.reject(new Error(message)),
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

// ── reasoning effort defaults ──────────────────────────────────────────────

const THOUGHT_LEVEL_OPTIONS = [
  {
    id: 'thought-level-option',
    category: 'thought_level',
    type: 'select',
    options: [
      { name: 'Low', value: 'low' },
      { name: 'Medium', value: 'medium' },
      { name: 'High', value: 'high' },
    ],
  },
]

test('a claude session with no reasoningEffort set defaults thought_level to medium', async () => {
  const h = await setup('claude', { configOptions: THOUGHT_LEVEL_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [
    { sessionId: h.sessionId, configId: 'thought-level-option', value: 'medium' },
  ])
  h.client.deleteSession(h.sessionId)
})

test('an explicit reasoningEffort still wins over the claude default', async () => {
  const h = await setup('claude', { reasoningEffort: 'high', configOptions: THOUGHT_LEVEL_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [
    { sessionId: h.sessionId, configId: 'thought-level-option', value: 'high' },
  ])
  h.client.deleteSession(h.sessionId)
})

test('non-claude adapters get no reasoning default applied', async () => {
  const h = await setup('openclaw', { configOptions: THOUGHT_LEVEL_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [])
  h.client.deleteSession(h.sessionId)
})

test('an explicit "off" is never overridden by the claude default', async () => {
  const h = await setup('claude', { reasoningEffort: 'off', configOptions: THOUGHT_LEVEL_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [])
  h.client.deleteSession(h.sessionId)
})

// ── dynamic config options / session info ──────────────────────────────────

const MODEL_OPTIONS = [
  { id: 'model-option', category: 'model', type: 'select', options: [{ name: 'A', value: 'a' }] },
]

test('a session created with configOptions stores and emits them', async () => {
  const h = await setup('openclaw', { configOptions: MODEL_OPTIONS })
  await settle()
  const snapshots = h.events.filter((event) => event.kind === 'config_options')
  assert.deepEqual(snapshots.at(-1), { kind: 'config_options', options: MODEL_OPTIONS })
  h.client.deleteSession(h.sessionId)
})

test('setConfigOption calls through, replaces state, and emits a snapshot', async () => {
  const h = await setup('openclaw', { configOptions: MODEL_OPTIONS })
  await h.client.setConfigOption(h.sessionId, 'model-option', 'b')
  assert.deepEqual(h.configOptionCalls, [{ sessionId: h.sessionId, configId: 'model-option', value: 'b' }])
  const snapshots = h.events.filter((event) => event.kind === 'config_options')
  assert.deepEqual(snapshots.at(-1), { kind: 'config_options', options: MODEL_OPTIONS })
  h.client.deleteSession(h.sessionId)
})

test('setConfigOption sends the boolean shape for boolean options', async () => {
  const boolOption = [{ id: 'bool-option', category: 'mode', type: 'boolean', currentValue: false }]
  const h = await setup('openclaw', { configOptions: boolOption })
  await h.client.setConfigOption(h.sessionId, 'bool-option', true)
  assert.deepEqual(h.configOptionCalls, [{ sessionId: h.sessionId, configId: 'bool-option', type: 'boolean', value: true }])
  h.client.deleteSession(h.sessionId)
})

test('a config_option_update notification replaces session config options and emits a snapshot', async () => {
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'config_option_update', configOptions: MODEL_OPTIONS },
  } as Parameters<typeof handleUpdate>[0])
  const snapshots = h.events.filter((event) => event.kind === 'config_options')
  assert.deepEqual(snapshots.at(-1), { kind: 'config_options', options: MODEL_OPTIONS })
  h.client.deleteSession(h.sessionId)
})

test('replayed config_option_update notifications leave the last one in state (last update wins)', async () => {
  const h = await setup('openclaw')
  const first = [{ id: 'model-option', category: 'model', type: 'select', options: [{ name: 'A', value: 'a' }] }]
  const second = [{ id: 'model-option', category: 'model', type: 'select', options: [{ name: 'B', value: 'b' }] }]
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'config_option_update', configOptions: first },
  } as Parameters<typeof handleUpdate>[0])
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'config_option_update', configOptions: second },
  } as Parameters<typeof handleUpdate>[0])
  const snapshots = h.events.filter((event) => event.kind === 'config_options')
  assert.deepEqual(snapshots.at(-1), { kind: 'config_options', options: second })
  h.client.deleteSession(h.sessionId)
})

test('loadSession seeds configOptions from the response when nothing was replayed', async () => {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const sessionId = `loaded-session-${counter}`
  const connection = {
    loadSession: async () => ({ configOptions: MODEL_OPTIONS }),
  } as unknown as AgentConnection
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: true,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient()
  const meta = await client.loadSession(sessionId, selection)
  assert.ok(meta, 'loadSession must resume when the connection advertises the capability')
  const events: ChatEvent[] = []
  // Subscribing after loadSession resolves still sees the config_options
  // event — subscribe() replays every stored event to a new subscriber.
  client.subscribe(sessionId, (event) => events.push(event))
  const snapshots = events.filter((event) => event.kind === 'config_options')
  assert.deepEqual(snapshots.at(-1), { kind: 'config_options', options: MODEL_OPTIONS })
  client.deleteSession(sessionId)
})

test('a session_info_update notification updates the session title and emits it', async () => {
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'session_info_update', title: 'Renamed chat' },
  } as Parameters<typeof handleUpdate>[0])
  const snapshots = h.events.filter((event) => event.kind === 'session_info')
  assert.deepEqual(snapshots.at(-1), { kind: 'session_info', title: 'Renamed chat' })
  assert.equal(h.client.listSessions().find((s) => s.id === h.sessionId)?.title, 'Renamed chat')
  h.client.deleteSession(h.sessionId)
})

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

// ── mid-turn input (steering adapters) ─────────────────────────────────────

// The capability is per-adapter data and may be enabled for no adapter at any
// given time (see harness-adapters.ts). These tests cover the engine mechanism
// itself, so they switch it on for the adapter entry — module-level state
// shared by the whole process — and restore it before the next test.
function enableMidTurnInput(adapterId: string): () => void {
  const adapter = findAdapter(adapterId)
  assert.ok(adapter, `adapter ${adapterId} must exist`)
  const previous = adapter.supportsMidTurnInput
  adapter.supportsMidTurnInput = true
  return () => {
    adapter.supportsMidTurnInput = previous
  }
}

test('a mid-turn prompt on a steering adapter goes straight through, unqueued', async () => {
  const restore = enableMidTurnInput('claude')
  try {
    const h = await setup('claude')
    await h.client.prompt(h.sessionId, 'first')
    await h.client.prompt(h.sessionId, 'steer')
    // Both prompts reached the connection while the first turn was still open.
    assert.deepEqual(h.promptCalls, ['first', 'steer'])
    assert.equal(h.events.filter((event) => event.kind === 'user').length, 2)
    assert.equal(queueSnapshots(h.events).length, 0)
    h.endTurn()
    h.endTurn()
    await settle()
    await h.client.reset()
  } finally {
    restore()
  }
})

test('overlapping prompts emit turn_end only on the last settlement', async () => {
  const restore = enableMidTurnInput('claude')
  try {
    const h = await setup('claude')
    await h.client.prompt(h.sessionId, 'first')
    await h.client.prompt(h.sessionId, 'steer')
    h.endTurn()
    await settle()
    // One of two prompts settled — the turn is still running.
    assert.equal(h.events.filter((event) => event.kind === 'turn_end').length, 0)
    h.endTurn()
    await settle()
    assert.equal(h.events.filter((event) => event.kind === 'turn_end').length, 1)
    await h.client.reset()
  } finally {
    restore()
  }
})

test('an intermediate failure surfaces immediately; turn_end still waits for the last settlement', async () => {
  const restore = enableMidTurnInput('claude')
  try {
    const h = await setup('claude')
    await h.client.prompt(h.sessionId, 'first')
    await h.client.prompt(h.sessionId, 'steer')
    h.failTurn('boom')
    await settle()
    assert.equal(h.events.filter((event) => event.kind === 'error').length, 1)
    assert.equal(h.events.filter((event) => event.kind === 'turn_end').length, 0)
    h.endTurn()
    await settle()
    assert.equal(h.events.filter((event) => event.kind === 'turn_end').length, 1)
    await h.client.reset()
  } finally {
    restore()
  }
})

// With the capability off (the current table state), the same adapter queues
// mid-turn prompts like any other — the flag alone decides.
test('a mid-turn prompt without the capability queues even on the claude adapter', async () => {
  const h = await setup('claude')
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  assert.deepEqual(h.promptCalls, ['first'])
  assert.deepEqual(queueSnapshots(h.events), [['second']])
  h.endTurn()
  await settle()
  assert.deepEqual(h.promptCalls, ['first', 'second'])
  h.endTurn()
  await settle()
  await h.client.reset()
})
