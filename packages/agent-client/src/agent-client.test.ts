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
  sessions: Map<string, unknown>
}

function acpStore(): AcpStoreShape {
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  return store
}

interface TurnDeferred {
  resolve: (value: { stopReason: string }) => void
  reject: (error: Error) => void
}

let counter = 0

async function setup(
  adapterId: 'openclaw' | 'claude' = 'openclaw',
  options: { reasoningEffort?: string; configOptions?: unknown; sessionKey?: string } = {},
) {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId,
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
  }
  const promptCalls: string[] = []
  const configOptionCalls: Array<{ sessionId: string; configId: string; value: unknown }> = []
  const closeSessionCalls: string[] = []
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
    closeSession: async (params: { sessionId: string }) => {
      closeSessionCalls.push(params.sessionId)
      return {}
    },
  } as unknown as AgentConnection
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  const key = JSON.stringify(buildSpawnConfig(selection))
  store.connections.set(key, {
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
    selection,
    connectionKey: key,
    events,
    promptCalls,
    configOptionCalls,
    closeSessionCalls,
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
  assert.deepEqual(h.configOptionCalls, [{ sessionId: h.sessionId, configId: 'thought-level-option', value: 'medium' }])
  await h.client.deleteSession(h.sessionId)
})

test('an explicit reasoningEffort still wins over the claude default', async () => {
  const h = await setup('claude', { reasoningEffort: 'high', configOptions: THOUGHT_LEVEL_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [{ sessionId: h.sessionId, configId: 'thought-level-option', value: 'high' }])
  await h.client.deleteSession(h.sessionId)
})

test('non-claude adapters get no reasoning default applied', async () => {
  const h = await setup('openclaw', { configOptions: THOUGHT_LEVEL_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [])
  await h.client.deleteSession(h.sessionId)
})

test('an explicit "off" is never overridden by the claude default', async () => {
  const h = await setup('claude', { reasoningEffort: 'off', configOptions: THOUGHT_LEVEL_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [])
  await h.client.deleteSession(h.sessionId)
})

// ── dynamic config options / session info ──────────────────────────────────

const MODEL_OPTIONS = [{ id: 'model-option', category: 'model', type: 'select', options: [{ name: 'A', value: 'a' }] }]

test('a session created with configOptions stores and emits them', async () => {
  const h = await setup('openclaw', { configOptions: MODEL_OPTIONS })
  await settle()
  const snapshots = h.events.filter((event) => event.kind === 'config_options')
  assert.deepEqual(snapshots.at(-1), { kind: 'config_options', options: MODEL_OPTIONS })
  await h.client.deleteSession(h.sessionId)
})

test('setConfigOption calls through, replaces state, and emits a snapshot', async () => {
  const h = await setup('openclaw', { configOptions: MODEL_OPTIONS })
  await h.client.setConfigOption(h.sessionId, 'model-option', 'b')
  assert.deepEqual(h.configOptionCalls, [{ sessionId: h.sessionId, configId: 'model-option', value: 'b' }])
  const snapshots = h.events.filter((event) => event.kind === 'config_options')
  assert.deepEqual(snapshots.at(-1), { kind: 'config_options', options: MODEL_OPTIONS })
  await h.client.deleteSession(h.sessionId)
})

test('setConfigOption sends the boolean shape for boolean options', async () => {
  const boolOption = [{ id: 'bool-option', category: 'mode', type: 'boolean', currentValue: false }]
  const h = await setup('openclaw', { configOptions: boolOption })
  await h.client.setConfigOption(h.sessionId, 'bool-option', true)
  assert.deepEqual(h.configOptionCalls, [
    { sessionId: h.sessionId, configId: 'bool-option', type: 'boolean', value: true },
  ])
  await h.client.deleteSession(h.sessionId)
})

test('a config_option_update notification replaces session config options and emits a snapshot', async () => {
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'config_option_update', configOptions: MODEL_OPTIONS },
  } as Parameters<typeof handleUpdate>[0])
  const snapshots = h.events.filter((event) => event.kind === 'config_options')
  assert.deepEqual(snapshots.at(-1), { kind: 'config_options', options: MODEL_OPTIONS })
  await h.client.deleteSession(h.sessionId)
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
  await h.client.deleteSession(h.sessionId)
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
  await client.deleteSession(sessionId)
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
  await h.client.deleteSession(h.sessionId)
})

test('prompt during an active turn queues and emits a snapshot', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  await h.client.prompt(h.sessionId, 'third')
  // Only the first prompt reached the agent; the rest were held.
  assert.deepEqual(h.promptCalls, ['first'])
  assert.deepEqual(queueSnapshots(h.events), [['second'], ['second', 'third']])
  await h.client.deleteSession(h.sessionId)
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
  await h.client.deleteSession(h.sessionId)
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
  await h.client.deleteSession(h.sessionId)
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
  await h.client.deleteSession(h.sessionId)
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
  await h.client.deleteSession(h.sessionId)
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

// ── deleteSession / session-close propagation ────
//
// store.connections is keyed by spawn config, not sessionId, so these tests
// exercise the three cases that matter: the common single-session case
// (graceful close, nothing left to kill), the fallback (close unavailable,
// no sibling — kill the subprocess), and the guard that must never fire the
// fallback while a sibling session still shares the connection.

test('deleteSession closes the session on the agent and leaves the shared connection alone', async () => {
  const h = await setup()
  await h.client.deleteSession(h.sessionId)
  assert.deepEqual(h.closeSessionCalls, [h.sessionId])
  assert.ok(acpStore().connections.has(h.connectionKey), 'a successful close must not also kill the connection')
})

test('deleteSession kills the subprocess when close fails and no sibling session remains', async () => {
  let killed = false
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: '/tmp/agent-client-test-kill-fallback',
  }
  const connection = {
    newSession: async () => ({ sessionId: 'kill-fallback-session' }),
    closeSession: async () => {
      throw new Error('agent does not support session.close')
    },
  } as unknown as AgentConnection
  const key = JSON.stringify(buildSpawnConfig(selection))
  const store = acpStore()
  store.connections.set(key, {
    connection,
    process: {
      kill: () => {
        killed = true
      },
    },
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient()
  const meta = await client.createSession(selection)
  await client.deleteSession(meta.id)
  assert.equal(killed, true)
  assert.equal(store.connections.has(key), false)
})

test('deleteSession does not kill the subprocess while a sibling session still shares it', async () => {
  let killed = false
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: '/tmp/agent-client-test-sibling-guard',
  }
  let nextId = 0
  const connection = {
    newSession: async () => ({ sessionId: `sibling-guard-session-${++nextId}` }),
    closeSession: async () => {
      throw new Error('agent does not support session.close')
    },
  } as unknown as AgentConnection
  const key = JSON.stringify(buildSpawnConfig(selection))
  const store = acpStore()
  store.connections.set(key, {
    connection,
    process: {
      kill: () => {
        killed = true
      },
    },
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient()
  const first = await client.createSession(selection)
  const second = await client.createSession(selection)
  const originalWarn = console.warn
  const warnings: unknown[][] = []
  console.warn = (...args: unknown[]) => warnings.push(args)
  try {
    await client.deleteSession(first.id)
  } finally {
    console.warn = originalWarn
  }
  assert.equal(killed, false, 'a sibling session on the same connection must block the kill fallback')
  assert.equal(store.connections.has(key), true)
  assert.ok(store.sessions.has(second.id), 'the sibling session itself must be untouched')
  assert.equal(warnings.length, 1, 'a blocked kill fallback must log a warning so the leak is diagnosable')
})

// ── activeSessionKeys ────────────────────────────────────────────────────
//
// Mirrors pendingPermissionSessionKeys: the session key only appears while a
// turn is actually in flight (activeTurns > 0), and only when the selection
// carried a sessionKey at all — a session without one (e.g. an internal/ad
// hoc harness use) must never surface as a bare falsy entry.

test('activeSessionKeys is empty before any prompt is sent', async () => {
  const h = await setup('openclaw', { sessionKey: 'agent:carol:test' })
  assert.deepEqual(h.client.activeSessionKeys(), [])
})

test('activeSessionKeys includes the key while a turn is in flight, and drops it once the turn ends', async () => {
  const h = await setup('openclaw', { sessionKey: 'agent:carol:test' })
  await h.client.prompt(h.sessionId, 'hello')
  assert.deepEqual(h.client.activeSessionKeys(), ['agent:carol:test'])
  h.endTurn()
  await settle()
  assert.deepEqual(h.client.activeSessionKeys(), [])
})

test('a session created without a sessionKey never appears, even mid-turn', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'hello')
  assert.deepEqual(h.client.activeSessionKeys(), [])
})

// ── aliveSessionKeys ─────────────────────────────────────────────────────
//
// Unlike activeSessionKeys (needs a turn in flight) or pendingPermissionSessionKeys
// (needs a blocked permission), this is "does a live agent process exist for
// this key at all" — true the moment the session is created, false once it's
// deleted. The process-visibility indicator's base signal.
//
// Every test in this file shares one module-level store (see acpStore()), and
// many reuse the literal key 'agent:carol:test' without deleting their session
// afterward — so asserting a bare [] here would be order-dependent on
// whatever earlier tests happened to leave behind. These assert deltas
// (does creating/deleting *this* test's own session change the set the
// expected way) instead of the store's total contents.

test('aliveSessionKeys includes the key as soon as the session is created, before any prompt', async () => {
  const h = await setup('openclaw', { sessionKey: `agent:test-${counter}` })
  const uniqueKey = h.selection.sessionKey as string
  assert.equal(h.client.aliveSessionKeys().includes(uniqueKey), true)
})

test('aliveSessionKeys drops the key once the session is deleted, if nothing else still holds it', async () => {
  const h = await setup('openclaw', { sessionKey: `agent:test-${counter}` })
  const uniqueKey = h.selection.sessionKey as string
  assert.equal(h.client.aliveSessionKeys().includes(uniqueKey), true)
  await h.client.deleteSession(h.sessionId)
  assert.equal(h.client.aliveSessionKeys().includes(uniqueKey), false)
})

test('a session created without a sessionKey never changes aliveSessionKeys', async () => {
  const before = createAgentClient().aliveSessionKeys()
  await setup()
  const after = createAgentClient().aliveSessionKeys()
  assert.deepEqual(after, before)
})

// ── hasActiveTurn ────────────────────────────────────────────────────────
//
// Same underlying read as activeSessionKeys, by raw session id — the check a
// `force` send uses to decide whether there's actually a turn worth
// cancelling before it does anything.

test('hasActiveTurn is false before any prompt and true while one is in flight', async () => {
  const h = await setup()
  assert.equal(h.client.hasActiveTurn(h.sessionId), false)
  await h.client.prompt(h.sessionId, 'hello')
  assert.equal(h.client.hasActiveTurn(h.sessionId), true)
  h.endTurn()
  await settle()
  assert.equal(h.client.hasActiveTurn(h.sessionId), false)
})

test('an unknown session id reports no active turn rather than throwing', async () => {
  const h = await setup()
  assert.equal(h.client.hasActiveTurn(`${h.sessionId}-does-not-exist`), false)
})

// ── cancel + queue drain (the mechanics a force send relies on) ───────────
//
// cancel() only forwards session/cancel to the connection — it does not
// itself touch activeTurns or the queue. Whatever ends the cancelled turn's
// in-flight prompt (the agent honoring the signal, standing in for `endTurn`
// here) is what actually settles it and drains the next queued message. A
// force send's own message is enqueued (non-front) before that settlement,
// same as any other queued prompt — proven here by queuing it, cancelling,
// then settling and checking it still delivers, in order.

test('cancelling the active turn does not disrupt the queue; the queued message still drains once the turn settles', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second') // queues: a turn is already active
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['second'])
  await h.client.cancel(h.sessionId) // the mock connection's cancel is a no-op; real settlement is separate
  assert.equal(h.client.hasActiveTurn(h.sessionId), true, 'cancel alone must not touch activeTurns')
  h.endTurn() // stands in for the agent ending its turn in response to the cancel
  await settle()
  assert.equal(h.promptCalls.length, 2)
  assert.equal(h.promptCalls[1], 'second')
  assert.deepEqual(queueSnapshots(h.events).at(-1), [])
})

// ── windowed history: getEventsWindow / subscribe's fromIndex ─────────────
//
// Replays turns as `session/load` would (user_message_chunk + agent_message_chunk
// notifications), the way a resumed cold-start session's history actually
// arrives — see openLocalSession's loadSession path. `setup()`'s own subscribe
// call (made before any of these fire) still sees every event as it happens
// live, unbounded; these tests add a SECOND, late subscriber to exercise the
// windowed replay path a fresh SSE connection actually takes.

function pushTurn(sessionId: string, userText: string, replyText: string): void {
  handleUpdate({
    sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: userText } },
  } as Parameters<typeof handleUpdate>[0])
  handleUpdate({
    sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: replyText } },
  } as Parameters<typeof handleUpdate>[0])
}

test('getEventsWindow returns null for an unknown session', async () => {
  const client = createAgentClient()
  assert.equal(client.getEventsWindow('no-such-session', { turns: 5 }), null)
})

test('getEventsWindow tail matches what subscribe replays with the same fromIndex', async () => {
  const h = await setup('openclaw')
  for (let i = 0; i < 5; i++) {
    pushTurn(h.sessionId, `q${i}`, `a${i}`)
  }
  const window = h.client.getEventsWindow(h.sessionId, { turns: 2 })
  assert.ok(window)
  const replayed: ChatEvent[] = []
  h.client.subscribe(h.sessionId, (event) => replayed.push(event), { fromIndex: window.startIndex })
  // subscribe() also prepends a snapshot of the session's live title (every
  // session gets a default one), which getEventsWindow's pure history slice
  // doesn't know about — everything else must match exactly.
  assert.deepEqual(
    replayed.filter((e) => e.kind !== 'session_info'),
    window.events,
  )
  // Only the last 2 of 5 turns.
  assert.deepEqual(
    replayed.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : null)),
    ['q3', 'q4'],
  )
  await h.client.deleteSession(h.sessionId)
})

test('a windowed subscribe still delivers the latest config/title/usage snapshot even when it predates the cut', async () => {
  const h = await setup('openclaw')
  for (let i = 0; i < 5; i++) {
    pushTurn(h.sessionId, `q${i}`, `a${i}`)
  }
  // These all land before the last-2-turns cut below.
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'config_option_update', configOptions: MODEL_OPTIONS },
  } as Parameters<typeof handleUpdate>[0])
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'session_info_update', title: 'Old chat' },
  } as Parameters<typeof handleUpdate>[0])
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 100, size: 1000 },
  } as Parameters<typeof handleUpdate>[0])
  pushTurn(h.sessionId, 'q5', 'a5') // pushes all of the above out of a last-1-turn window

  const window = h.client.getEventsWindow(h.sessionId, { turns: 1 })
  assert.ok(window)
  assert.equal(
    window.events.some((e) => e.kind === 'user'),
    true,
  )
  const replayed: ChatEvent[] = []
  h.client.subscribe(h.sessionId, (event) => replayed.push(event), { fromIndex: window.startIndex })
  assert.deepEqual(
    replayed.find((e) => e.kind === 'config_options'),
    { kind: 'config_options', options: MODEL_OPTIONS },
  )
  assert.deepEqual(
    replayed.find((e) => e.kind === 'session_info'),
    { kind: 'session_info', title: 'Old chat' },
  )
  assert.deepEqual(
    replayed.find((e) => e.kind === 'usage'),
    { kind: 'usage', used: 100, size: 1000 },
  )
  await h.client.deleteSession(h.sessionId)
})

test('paging backward through getEventsWindow eventually reaches the start of a real session', async () => {
  const h = await setup('openclaw')
  for (let i = 0; i < 6; i++) {
    pushTurn(h.sessionId, `q${i}`, `a${i}`)
  }
  let window = h.client.getEventsWindow(h.sessionId, { turns: 2 })
  assert.ok(window)
  let hops = 0
  while (window?.hasMore) {
    window = h.client.getEventsWindow(h.sessionId, { beforeIndex: window.startIndex, turns: 2 })
    assert.ok(window)
    hops += 1
    assert.ok(hops < 10, 'paging backward must terminate')
  }
  assert.equal(window?.startIndex, 0)
  await h.client.deleteSession(h.sessionId)
})

// ── in-turn record pagination: getEventsWindow's turnRecords / getTurnRecordsWindow ──

function pushToolCall(sessionId: string, id: string): void {
  handleUpdate({
    sessionId,
    update: { sessionUpdate: 'tool_call', toolCallId: id, title: id, status: 'pending' },
  } as Parameters<typeof handleUpdate>[0])
  handleUpdate({
    sessionId,
    update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' },
  } as Parameters<typeof handleUpdate>[0])
}

test('getEventsWindow without turnRecords returns a huge newest turn in full (unchanged behavior)', async () => {
  const h = await setup('openclaw')
  pushTurn(h.sessionId, 'q0', 'a0')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' } },
  } as Parameters<typeof handleUpdate>[0])
  for (let i = 0; i < 20; i++) {
    pushToolCall(h.sessionId, `tool-${i}`)
  }
  const window = h.client.getEventsWindow(h.sessionId, { turns: 2 })
  assert.ok(window)
  assert.equal(window.trimmedTurn, undefined)
  assert.equal(window.events.filter((e) => e.kind === 'tool_call').length, 20)
  await h.client.deleteSession(h.sessionId)
})

test('getEventsWindow with turnRecords trims a huge newest turn and reports a trimmedTurn cursor', async () => {
  const h = await setup('openclaw')
  pushTurn(h.sessionId, 'q0', 'a0') // an earlier, small turn — must survive untouched
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' } },
  } as Parameters<typeof handleUpdate>[0])
  for (let i = 0; i < 20; i++) {
    pushToolCall(h.sessionId, `tool-${i}`)
  }
  const window = h.client.getEventsWindow(h.sessionId, { turns: 2, turnRecords: 3 })
  assert.ok(window)
  // Turn 0 stays whole.
  assert.deepEqual(
    window.events.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : null)),
    ['q0', 'q1'],
  )
  // Only the last 3 tool-call groups of the huge newest turn.
  assert.deepEqual(
    window.events.filter((e) => e.kind === 'tool_call').map((e) => (e.kind === 'tool_call' ? e.toolCallId : null)),
    ['tool-17', 'tool-18', 'tool-19'],
  )
  // The trimmed turn's cursor must point at 'q1's own absolute index — derived
  // from the window itself, not assumed, since a live subscriber's replay can
  // carry synthetic snapshot events (see withSnapshotPrefix) the raw session
  // log never stores.
  const relTurnStart = window.events.findIndex((e) => e.kind === 'user' && e.text === 'q1')
  assert.ok(relTurnStart >= 0)
  const turnStart = window.startIndex + relTurnStart
  assert.deepEqual(window.trimmedTurn, { turnStart, startIndex: window.trimmedTurn?.startIndex, hasMore: true })
  assert.ok(window.trimmedTurn && window.trimmedTurn.startIndex > turnStart)
  await h.client.deleteSession(h.sessionId)
})

test('getTurnRecordsWindow pages backward through a trimmed turn and reaches its own start', async () => {
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q0' } },
  } as Parameters<typeof handleUpdate>[0])
  const turnStart = 0
  for (let i = 0; i < 10; i++) {
    pushToolCall(h.sessionId, `tool-${i}`)
  }
  const tail = h.client.getEventsWindow(h.sessionId, { turns: 1, turnRecords: 3 })
  assert.ok(tail?.trimmedTurn)
  let cursor = tail.trimmedTurn.startIndex
  let hasMore = tail.trimmedTurn.hasMore
  const seenIds: string[] = []
  let hops = 0
  while (hasMore) {
    const page = h.client.getTurnRecordsWindow(h.sessionId, turnStart, cursor, 3)
    assert.ok(page)
    seenIds.unshift(
      ...page.events.filter((e) => e.kind === 'tool_call').map((e) => (e.kind === 'tool_call' ? e.toolCallId : '')),
    )
    cursor = page.startIndex
    hasMore = page.hasMore
    hops += 1
    assert.ok(hops < 10, 'paging backward through a turn must terminate')
  }
  assert.equal(cursor, turnStart + 1) // reaches the turn's body start, right after its 'user' event
  // Everything before the tail's own 3 groups (tool-7..9), oldest-first.
  assert.deepEqual(seenIds, ['tool-0', 'tool-1', 'tool-2', 'tool-3', 'tool-4', 'tool-5', 'tool-6'])
  await h.client.deleteSession(h.sessionId)
})
