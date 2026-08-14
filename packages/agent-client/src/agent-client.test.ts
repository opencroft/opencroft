import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
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
  options: {
    reasoningEffort?: string
    configOptions?: unknown
    sessionKey?: string
    transformDeliveredPrompt?: (text: string) => string
  } = {},
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
  const resumeCalls: string[] = []
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
    resumeSession: async (params: { sessionId: string }) => {
      resumeCalls.push(params.sessionId)
      return {}
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
  const client = createAgentClient(
    options.transformDeliveredPrompt ? { transformDeliveredPrompt: options.transformDeliveredPrompt } : {},
  )
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
    resumeCalls,
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

// listTools feeds the editors that decide what a ROLE may reach, so it asks a
// dynamic tools source for the whole registry with no caller. Both halves of
// that matter: a factory that is handed nothing at all breaks on a host whose
// factory reads the caller, and one told to build for a specific caller could
// hide an identity-gated tool from the screen that governs it.
test('listTools resolves a dynamic tools source for no particular caller', async () => {
  const seen: unknown[] = []
  const client = createAgentClient({
    tools: async (caller) => {
      seen.push(caller)
      return [
        { name: 'acts-as-caller', description: 'gated on who is calling', inputSchema: {}, handler: async () => ({}) },
        { name: 'plain', description: 'gated on nothing', inputSchema: {}, handler: async () => ({}) },
      ]
    },
  })

  const listed = await client.listTools()

  assert.deepEqual(seen, [{}], 'the factory is called with an empty caller, not with undefined')
  assert.deepEqual(
    listed.map((tool) => tool.name),
    ['acts-as-caller', 'plain'],
    'the whole registry is listed — identity decides what a tool does, not whether it can be granted',
  )
})

// A session/load replay streams history with no turn boundaries of its own, so
// every replayed turn but the last used to contain no terminal event and read
// as cut off. loadSession now reconstructs a boundary at the start of each
// replayed message after the first.
// Boundaries only — whether those boundaries become the right TURNS is decided
// by splitIntoTurns on the read side, and is asserted in host-turns.test.ts.
test('a replay emits one reconstructed boundary per replayed message, not per chunk', async () => {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const sessionId = `replayed-session-${counter}`
  const push = (update: Record<string, unknown>) =>
    handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
  const connection = {
    // Replay notifications arrive while this call is pending, exactly as they
    // do against a real agent.
    loadSession: async () => {
      push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first ' } })
      push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'question' } })
      push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first reply' } })
      push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'second question' } })
      push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'second reply' } })
      return {}
    },
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
  assert.ok(await client.loadSession(sessionId, selection))
  const events: ChatEvent[] = []
  client.subscribe(sessionId, (event) => events.push(event))

  // Three user events for two messages — the first arrived as two chunks — and
  // no boundary was opened between those two.
  assert.equal(events.filter((event) => event.kind === 'user').length, 3)
  // Both boundaries are 'replayed': this transcript ends with the agent's own
  // message, so the last turn produced its reply and the session went quiet —
  // the shape of a restart while idle, not of a severed turn.
  assert.deepEqual(
    events
      .filter((event): event is Extract<ChatEvent, { kind: 'turn_end' }> => event.kind === 'turn_end')
      .map((event) => event.stopReason),
    ['replayed', 'replayed'],
  )
  // The reconstructed boundary closes the first turn: it sits after that turn's
  // reply and before the next question. Filtered to the conversation kinds —
  // snapshot events (session_info, modes, …) are not part of what is asserted.
  const kindOrder = events
    .map((event) => event.kind)
    .filter((kind) => kind === 'user' || kind === 'agent_message' || kind === 'turn_end')
  assert.deepEqual(kindOrder, ['user', 'user', 'agent_message', 'turn_end', 'user', 'agent_message', 'turn_end'])
  await client.deleteSession(sessionId)
})

// The final boundary's marker is inferred from the tail of the transcript,
// because the replay records no more about the last turn's ending than about
// any other. A transcript that stops on unfinished work is the shape of a turn
// the restart severed; one that ends on the agent's reply is not.
test('a replay that stops on unfinished work closes with resumed, not replayed', async () => {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const sessionId = `severed-session-${counter}`
  const push = (update: Record<string, unknown>) =>
    handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
  const connection = {
    loadSession: async () => {
      push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run the long thing' } })
      push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'starting' } })
      // The process went down here, mid tool call — nothing closes this.
      push({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'sleep 180', status: 'in_progress' })
      return {}
    },
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
  assert.ok(await client.loadSession(sessionId, selection))
  const events: ChatEvent[] = []
  client.subscribe(sessionId, (event) => events.push(event))

  assert.deepEqual(
    events
      .filter((event): event is Extract<ChatEvent, { kind: 'turn_end' }> => event.kind === 'turn_end')
      .map((event) => event.stopReason),
    ['resumed'],
  )
  await client.deleteSession(sessionId)
})

// A turn can end on a finished tool call and no closing text. Reading that as
// unfinished would report a completed turn as cut off — the wrong direction.
test('a replay ending on a settled tool call closes with replayed, not resumed', async () => {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const sessionId = `quiet-tail-session-${counter}`
  const push = (update: Record<string, unknown>) =>
    handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
  const connection = {
    loadSession: async () => {
      push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'tidy up' } })
      push({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'rm tmp', status: 'in_progress' })
      // The tool finished and the turn ended without the agent saying anything.
      push({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' })
      return {}
    },
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
  assert.ok(await client.loadSession(sessionId, selection))
  const events: ChatEvent[] = []
  client.subscribe(sessionId, (event) => events.push(event))

  assert.deepEqual(
    events
      .filter((event): event is Extract<ChatEvent, { kind: 'turn_end' }> => event.kind === 'turn_end')
      .map((event) => event.stopReason),
    ['replayed'],
  )
  await client.deleteSession(sessionId)
})

// The guard reads the previous CONVERSATION event, not the previous event —
// `emit` stores every kind, so a snapshot landing mid-run would otherwise be
// read as "not a user chunk" and split the message on an event that is not
// part of it.
test('a snapshot arriving between two chunks does not open a boundary', async () => {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const sessionId = `interleaved-session-${counter}`
  const push = (update: Record<string, unknown>) =>
    handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
  const connection = {
    loadSession: async () => {
      push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'what ' } })
      push({ sessionUpdate: 'session_info_update', title: 'a chat' })
      // A mode change is session state too, and reaches the same interleaving.
      push({ sessionUpdate: 'current_mode_update', currentModeId: 'plan' })
      push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'changed?' } })
      push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'the schema moved' } })
      return {}
    },
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
  assert.ok(await client.loadSession(sessionId, selection))
  const events: ChatEvent[] = []
  client.subscribe(sessionId, (event) => events.push(event))

  // One boundary — the closing one. The title update between the chunks opened
  // nothing.
  assert.deepEqual(
    events
      .filter((event): event is Extract<ChatEvent, { kind: 'turn_end' }> => event.kind === 'turn_end')
      .map((event) => event.stopReason),
    ['replayed'],
  )
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

// ── listSessions usage ───────────────────────────────────────────────────
//
// Context usage lets a host see a session filling up before it degrades. It is
// only ever what the harness reported — absent until one arrives, so a host can
// tell "holds nothing" from "cannot say".

test('a session that has never reported usage has none, rather than zero', async () => {
  const h = await setup('openclaw')
  const meta = h.client.listSessions().find((s) => s.id === h.sessionId)
  assert.equal(meta?.usage, undefined)
  await h.client.deleteSession(h.sessionId)
})

test('listSessions surfaces the last reported usage', async () => {
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 12_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  const meta = h.client.listSessions().find((s) => s.id === h.sessionId)
  assert.deepEqual(meta?.usage, { used: 12_000, size: 200_000 })
  await h.client.deleteSession(h.sessionId)
})

test('a later usage report replaces the earlier one', async () => {
  // What a host reads after a compaction: the newest figure, not the peak.
  const h = await setup('openclaw')
  for (const used of [500_000, 20_000]) {
    handleUpdate({
      sessionId: h.sessionId,
      update: { sessionUpdate: 'usage_update', used, size: 200_000 },
    } as Parameters<typeof handleUpdate>[0])
  }
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 20_000,
    size: 200_000,
  })
  await h.client.deleteSession(h.sessionId)
})

test('a harness that cannot name the context window reports usage with no size', async () => {
  // size <= 0 means "window unknown" on the wire; it must not surface as 0,
  // which would read as a zero-capacity context.
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 900, size: 0 },
  } as Parameters<typeof handleUpdate>[0])
  const meta = h.client.listSessions().find((s) => s.id === h.sessionId)
  assert.deepEqual(meta?.usage, { used: 900, size: undefined })
  await h.client.deleteSession(h.sessionId)
})

test('restoreUsage seeds a session that has reported none', async () => {
  // The resume case: ACP offers no way to ask an agent what a loaded session
  // holds, so a host that kept the last figure hands it back this way.
  const h = await setup('openclaw')
  h.client.restoreUsage(h.sessionId, { used: 8_000, size: 200_000 })
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 8_000,
    size: 200_000,
  })
  await h.client.deleteSession(h.sessionId)
})

test('a restored usage figure reaches a subscriber that connects afterwards', async () => {
  // The whole point of restoring it: the chat opens with a populated context
  // ring instead of a blank one, via the same snapshot-prefix path a live
  // reading takes.
  const h = await setup('openclaw')
  h.client.restoreUsage(h.sessionId, { used: 8_000, size: 200_000 })
  const seen: ChatEvent[] = []
  const unsubscribe = h.client.subscribe(h.sessionId, (event) => seen.push(event))
  assert.deepEqual(
    seen.filter((e) => e.kind === 'usage'),
    [{ kind: 'usage', used: 8_000, size: 200_000 }],
  )
  unsubscribe()
  await h.client.deleteSession(h.sessionId)
})

test('restoreUsage never overwrites a figure the agent actually reported', async () => {
  // A restored value is last-turn's estimate. Once the agent has spoken for
  // itself, the stored guess must not be able to clobber it — otherwise a
  // late-arriving restore would walk a live session's ring backwards.
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 12_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  h.client.restoreUsage(h.sessionId, { used: 999, size: 1_000 })
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 12_000,
    size: 200_000,
  })
  await h.client.deleteSession(h.sessionId)
})

test('restoreUsage on an unknown session is a no-op', async () => {
  // It rides alongside a resume that may itself have failed.
  const h = await setup('openclaw')
  assert.doesNotThrow(() => h.client.restoreUsage('no-such-session', { used: 1, size: 2 }))
  await h.client.deleteSession(h.sessionId)
})

// ── monotonic-within-turn usage display ──────────────────────────────────
//
// An external ACP bridge resets its own running usage tally at the start of
// every turn and rebuilds it from streamed deltas, so a turn's early readings
// undercount and climb back up — displaying every reading as-is made the ring
// visibly collapse and refill each turn. A reading lower than what's
// currently displayed must not lower it while the turn is active; the true
// reading still applies at the turn boundary.

test('a lower reading mid-turn is held; the ring keeps growing or holding, never drops', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'hello')
  for (const used of [50_000, 200, 800]) {
    handleUpdate({
      sessionId: h.sessionId,
      update: { sessionUpdate: 'usage_update', used, size: 200_000 },
    } as Parameters<typeof handleUpdate>[0])
  }
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 50_000,
    size: 200_000,
  })
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'usage'),
    [{ kind: 'usage', used: 50_000, size: 200_000 }],
  )
  h.endTurn()
  await settle()
})

test('the held reading is not lost: it applies once the turn ends', async () => {
  // A genuine decrease (e.g. after compaction) still reaches the display —
  // just at the boundary rather than mid-turn.
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'hello')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 50_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 12_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 50_000,
    size: 200_000,
  })
  h.endTurn()
  await settle()
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 12_000,
    size: 200_000,
  })
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'usage'),
    [
      { kind: 'usage', used: 50_000, size: 200_000 },
      { kind: 'usage', used: 12_000, size: 200_000 },
    ],
  )
})

test('a turn boundary with no held-back reading re-emits nothing', async () => {
  // The common case: the last mid-turn reading already matches what settled
  // at the boundary, so there is nothing new to tell a subscriber.
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'hello')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 50_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  h.endTurn()
  await settle()
  assert.deepEqual(
    h.events.filter((e) => e.kind === 'usage'),
    [{ kind: 'usage', used: 50_000, size: 200_000 }],
  )
})

test('the first reading of a turn always applies, however low, when nothing was displayed yet', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'hello')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 200, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 200,
    size: 200_000,
  })
  h.endTurn()
  await settle()
})

test('a genuine decrease outside of an active turn still applies immediately', async () => {
  // Native-harness sessions, and any reading that arrives with no turn in
  // flight (e.g. replayed history), are unaffected by the monotonic rule.
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 50_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 12_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 12_000,
    size: 200_000,
  })
  await h.client.deleteSession(h.sessionId)
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

// ── refreshMcpServers ────────────────────────────────────────────────────
//
// A global MCP server list change used to resume every live session
// unconditionally, which sends session/resume over the same connection an
// in-flight prompt is streaming on and cuts that turn off. An idle session is
// still resumed right away; a session with a turn in flight is deferred until
// that turn actually settles (see pendingMcpRefresh).

test('refreshMcpServers resumes an idle session right away', async () => {
  const h = await setup()
  await h.client.refreshMcpServers()
  assert.deepEqual(h.resumeCalls, [h.sessionId])
  await h.client.deleteSession(h.sessionId)
})

test('refreshMcpServers does not resume a session with a turn in flight, and applies it once the turn settles', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'hello')
  await h.client.refreshMcpServers()
  assert.deepEqual(h.resumeCalls, [], 'a live turn must not be interrupted by a resume')
  assert.equal(h.client.hasActiveTurn(h.sessionId), true, 'refreshMcpServers must not itself end the turn')
  h.endTurn()
  await settle()
  assert.deepEqual(h.resumeCalls, [h.sessionId], 'the deferred resume must still run once the turn actually ends')
  await h.client.deleteSession(h.sessionId)
})

test('a queued prompt still delivers after a deferred MCP resume runs', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second') // queues: a turn is already active
  await h.client.refreshMcpServers() // deferred: 'first' is still in flight
  h.endTurn() // ends 'first'
  await settle()
  assert.deepEqual(h.resumeCalls, [h.sessionId])
  assert.equal(h.promptCalls.length, 2, 'the queued prompt must still be delivered after the deferred resume runs')
  assert.equal(h.promptCalls[1], 'second')
  await h.client.deleteSession(h.sessionId)
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

// A force is a push: everything still held reaches the agent together, so it
// can read the whole picture before acting. Draining one per turn would have it
// act on each stale message first and only then reach the newest one.
test('a flushing prompt delivers the whole queue and itself as ONE turn, in order, itself last', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  await h.client.prompt(h.sessionId, 'third')
  await h.client.prompt(h.sessionId, 'forced', { flush: true })
  // Still held: the interrupted turn has not settled yet.
  assert.deepEqual(h.promptCalls, ['first'])
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['second', 'third', 'forced'])

  h.endTurn()
  await settle()

  // One delivery carrying all three, in the order sent, the forced one last —
  // and each still individually readable.
  assert.equal(h.promptCalls.length, 2)
  assert.equal(h.promptCalls[1], '[message 1 of 3]\nsecond\n\n[message 2 of 3]\nthird\n\n[message 3 of 3]\nforced')
  // Nothing left displayed as Queued.
  assert.deepEqual(queueSnapshots(h.events).at(-1), [])
  // One turn, not three: a single user event for the flushed delivery.
  assert.deepEqual(
    kinds(h.events).filter((kind) => kind === 'user'),
    ['user', 'user'],
  )
  await h.client.deleteSession(h.sessionId)
})

test('a flushing prompt with nothing held reads exactly like an ordinary send', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'forced', { flush: true })
  h.endTurn()
  await settle()
  // No framing to explain when there is only one message.
  assert.deepEqual(h.promptCalls, ['first', 'forced'])
  await h.client.deleteSession(h.sessionId)
})

test('a flush does not change how later ordinary sends drain', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  await h.client.prompt(h.sessionId, 'forced', { flush: true })
  h.endTurn()
  await settle()
  assert.equal(h.promptCalls.length, 2)

  // The flag is spent, so the queue goes back to one message per turn.
  await h.client.prompt(h.sessionId, 'later-a')
  await h.client.prompt(h.sessionId, 'later-b')
  h.endTurn()
  await settle()
  assert.equal(h.promptCalls.at(-1), 'later-a')
  h.endTurn()
  await settle()
  assert.equal(h.promptCalls.at(-1), 'later-b')
  await h.client.deleteSession(h.sessionId)
})

// ── transformDeliveredPrompt (delivery-time text transform) ───────────────
//
// The hook is applied inside deliverPrompt, the one place text is actually
// handed to the harness — never by prompt() itself, so a message that queues
// behind a running turn must only be transformed once it actually drains.

test('transformDeliveredPrompt is applied on an immediate, idle delivery', async () => {
  const calls: string[] = []
  const h = await setup('openclaw', {
    transformDeliveredPrompt: (text) => {
      calls.push(text)
      return `[stamped] ${text}`
    },
  })
  await h.client.prompt(h.sessionId, 'hello')
  assert.deepEqual(calls, ['hello'])
  assert.deepEqual(h.promptCalls, ['[stamped] hello'])
  await h.client.deleteSession(h.sessionId)
})

test('transformDeliveredPrompt runs at drain time, not at the moment a message queues', async () => {
  const calls: string[] = []
  const h = await setup('openclaw', {
    transformDeliveredPrompt: (text) => {
      calls.push(text)
      return `[stamped] ${text}`
    },
  })
  await h.client.prompt(h.sessionId, 'first') // delivers immediately: session was idle
  await h.client.prompt(h.sessionId, 'second') // queues: a turn is already active
  assert.deepEqual(calls, ['first'], 'the still-queued message must not be transformed yet')

  h.endTurn()
  await settle()
  assert.deepEqual(calls, ['first', 'second'])
  assert.deepEqual(h.promptCalls, ['[stamped] first', '[stamped] second'])
  await h.client.deleteSession(h.sessionId)
})

test('a flush-joined batch is transformed once, as the joined delivery, not once per original message', async () => {
  const calls: string[] = []
  const h = await setup('openclaw', {
    transformDeliveredPrompt: (text) => {
      calls.push(text)
      return `[stamped] ${text}`
    },
  })
  await h.client.prompt(h.sessionId, 'first')
  await h.client.prompt(h.sessionId, 'second')
  await h.client.prompt(h.sessionId, 'forced', { flush: true })
  assert.deepEqual(calls, ['first'], 'nothing held is transformed before the flush actually delivers')

  h.endTurn()
  await settle()
  assert.equal(calls.length, 2, 'one call for the idle first delivery, one for the whole joined flush')
  assert.equal(calls[1], '[message 1 of 2]\nsecond\n\n[message 2 of 2]\nforced')
  assert.equal(h.promptCalls[1], '[stamped] [message 1 of 2]\nsecond\n\n[message 2 of 2]\nforced')
  await h.client.deleteSession(h.sessionId)
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

// ── record-paged windows: getRecordsWindow ────────────────────────────────

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

test('getRecordsWindow returns null for an unknown session', async () => {
  const client = createAgentClient()
  assert.equal(client.getRecordsWindow('no-such-session', { records: 10 }), null)
})

test('the tail spends its budget on agent records and hands back the enclosing question', async () => {
  const h = await setup('openclaw')
  // Turn A: 4 tool calls. Turn B: 2 tool calls plus a reply.
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'A' } },
  } as Parameters<typeof handleUpdate>[0])
  for (let i = 0; i < 4; i++) {
    pushToolCall(h.sessionId, `a-${i}`)
  }
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'B' } },
  } as Parameters<typeof handleUpdate>[0])
  for (let i = 0; i < 2; i++) {
    pushToolCall(h.sessionId, `b-${i}`)
  }

  // 3 agent records: both of B's tool calls and the last of A's.
  const window = h.client.getRecordsWindow(h.sessionId, { records: 3 })
  assert.ok(window)
  assert.deepEqual(
    window.events.filter((e) => e.kind === 'tool_call').map((e) => (e.kind === 'tool_call' ? e.toolCallId : '')),
    ['a-3', 'b-0', 'b-1'],
  )
  // B's question is inside the slice; A's is above it and comes back separately.
  assert.deepEqual(
    window.events.filter((e) => e.kind === 'user').map((e) => (e.kind === 'user' ? e.text : null)),
    ['B'],
  )
  assert.equal(window.header?.event.kind === 'user' ? window.header.event.text : null, 'A')
  assert.equal(window.hasMore, true)
  await h.client.deleteSession(h.sessionId)
})

test('paging back through getRecordsWindow reaches the start of a real session', async () => {
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q' } },
  } as Parameters<typeof handleUpdate>[0])
  for (let i = 0; i < 12; i++) {
    pushToolCall(h.sessionId, `t-${i}`)
  }
  let window = h.client.getRecordsWindow(h.sessionId, { records: 5 })
  assert.ok(window)
  let hops = 0
  while (window?.hasMore) {
    window = h.client.getRecordsWindow(h.sessionId, { beforeIndex: window.startIndex, records: 5 })
    assert.ok(window)
    hops += 1
    assert.ok(hops < 15, 'paging backward must terminate')
  }
  assert.equal(window?.startIndex, 0)
  await h.client.deleteSession(h.sessionId)
})

// ── harness spawn failure ──────────────────────────────────────────────────
//
// These exercise a REAL spawn (no mock connection seeded in store.connections
// beforehand), so the adapter table entry is temporarily pointed at a command
// this test controls — same technique as enableMidTurnInput above, restored
// in a finally so later tests see the real adapter again.

function withAdapterCommand(adapterId: string, command: string, args: string[]): () => void {
  const adapter = findAdapter(adapterId)
  assert.ok(adapter, `adapter ${adapterId} must exist`)
  const previous = { command: adapter.command, args: adapter.args }
  adapter.command = command
  adapter.args = args
  return () => {
    adapter.command = previous.command
    adapter.args = previous.args
  }
}

test('a harness that fails to start reports its stderr, not the bare protocol error', async () => {
  const restore = withAdapterCommand('openclaw', 'node', [
    '-e',
    "process.stderr.write('container is not running\\n'); process.exit(1)",
  ])
  try {
    const client = createAgentClient()
    // Real dir: agent-client only spawns, it does not create cwd (the caller
    // does — see acp.ts's openLocalSession) and a missing one is itself an
    // ENOENT, which would defeat the point of this test.
    const selection: AgentSelection = {
      providerId: 'test-provider',
      adapterId: 'openclaw',
      model: 'test-model',
      apiKey: '',
      cwd: tmpdir(),
    }
    await assert.rejects(client.createSession(selection), (error: Error) => {
      assert.match(error.message, /container is not running/)
      return true
    })
  } finally {
    restore()
  }
})

test('a harness that exits with no stderr falls back to the protocol error, not a fabricated cause', async () => {
  const restore = withAdapterCommand('openclaw', 'node', ['-e', 'process.exit(1)'])
  try {
    const client = createAgentClient()
    const selection: AgentSelection = {
      providerId: 'test-provider',
      adapterId: 'openclaw',
      model: 'test-model',
      apiKey: '',
      cwd: tmpdir(),
    }
    await assert.rejects(client.createSession(selection), (error: Error) => {
      assert.match(error.message, /ACP connection closed/)
      return true
    })
  } finally {
    restore()
  }
})
