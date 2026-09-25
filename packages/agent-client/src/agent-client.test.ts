import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  type AgentClientOptions,
  buildClient,
  createAgentClient,
  handleUpdate,
  interceptDraftSessionUpdates,
  type QueueStore,
} from './agent-client'
import type { AgentConnection } from './connection'
import { COMPACTION_TITLE, foldEvents, isTerminalToolStatus } from './fold'
import { decodeBatch } from './queue-tags'
import { buildSpawnConfig, findAdapter } from './resolve'
import type { AgentSelection, AsyncTaskInfo, ChatEvent, CompactionState, Presence, QueuedPrompt } from './types'

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

// Deliveries are read back through the real parser rather than compared as
// raw text.
//
// Every message carries a tag now — one for the same reason ten do, because the
// tag is the only place an author and a send time survive a session reload — so
// a raw comparison would be asserting a live timestamp. Decoding also makes the
// round trip part of what each of these tests proves: the engine's output has
// to be readable by the thing that reads it.
function partsOf(prompt: string): string[] {
  return decodeBatch(prompt).map((message) => message.text)
}

// Every delivery, as its message texts: one inner array per turn the agent was
// given, so "one batch of three" and "three separate turns" no longer look
// alike the way two flat lists of strings did.
function deliveries(h: { promptCalls: string[] }): string[][] {
  return h.promptCalls.map(partsOf)
}

interface TurnDeferred {
  resolve: (value: { stopReason: string }) => void
  reject: (error: Error) => void
}

let counter = 0

// One block of a prompt as the harness receives it — text, or an image with
// its base64 payload.
type PromptBlock = { type: string; text?: string; data?: string; mimeType?: string }

async function setup(
  adapterId: 'openclaw' | 'claude' = 'openclaw',
  options: {
    reasoningEffort?: string
    configOptions?: unknown
    sessionKey?: string
    queueStore?: QueueStore
    loadPresence?: (sessionKey: string) => Presence | undefined
    shouldHoldDelivery?: () => boolean
    openSessionForKey?: (sessionKey: string) => void | Promise<void>
    transformDeliveredPrompt?: (text: string) => string
    contextWindow?: number
    model?: string
    onCompaction?: (sessionId: string, compaction: CompactionState) => void
    // Model a harness that advertised the steering extension: the seeded
    // connection reports it, and its extMethod records calls and answers
    // `injected` unless steerOutcome overrides it. A promise holds the answer
    // back until the test settles it: a steer still in flight.
    steeringSupported?: boolean
    steerOutcome?: string | Promise<string>
    // Model a harness that advertised the SDK's session/fork capability: the
    // seeded connection reports it, and its unstable_forkSession records its
    // params and answers with a forked session id.
    forkSupported?: boolean
    // Model a real ACP agent: cancelling ends the turn it was running, which
    // resolves the in-flight prompt promise and therefore fires settleTurn.
    // The default no-op cancel hides every ordering question that depends on
    // the settle landing while the caller is still mid-call.
    cancelEndsTurn?: boolean
    // Model a harness that advertised `promptCapabilities.image` — what
    // decides whether an attachment the message names may travel at all.
    imagePrompt?: boolean
    loadAttachments?: AgentClientOptions['loadAttachments']
    stopHostTask?: AgentClientOptions['stopHostTask']
  } = {},
) {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId,
    model: options.model ?? 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
    // A harness option that silently stops arriving turns every test that reads
    // it green for the wrong reason, so the spreads are named the same way the
    // production ones are.
    ...(options.reasoningEffort
      ? ({ reasoningEffort: options.reasoningEffort } satisfies Pick<AgentSelection, 'reasoningEffort'>)
      : {}),
    ...(options.sessionKey ? ({ sessionKey: options.sessionKey } satisfies Pick<AgentSelection, 'sessionKey'>) : {}),
    ...(options.contextWindow !== undefined
      ? ({ contextWindow: options.contextWindow } satisfies Pick<AgentSelection, 'contextWindow'>)
      : {}),
  }
  const promptCalls: string[] = []
  const configOptionCalls: Array<{ sessionId: string; configId: string; value: unknown }> = []
  const closeSessionCalls: string[] = []
  const resumeCalls: string[] = []
  const promptBlockCalls: PromptBlock[][] = []
  const extMethodCalls: Array<{ method: string; params: Record<string, unknown> }> = []
  const forkCalls: Array<Record<string, unknown>> = []
  // Prompts and resumes in the order the connection received them: the one
  // question the separate call lists above cannot answer.
  const wire: Array<'prompt' | 'resume'> = []
  const turns: TurnDeferred[] = []
  const takeTurn = (index?: number) => (index === undefined ? turns.shift() : turns.splice(index, 1)[0])
  const connection = {
    newSession: async () => ({
      sessionId: `test-session-${counter}`,
      configOptions: options.configOptions,
    }),
    unstable_forkSession: async (params: Record<string, unknown>) => {
      forkCalls.push(params)
      return { sessionId: `forked-session-${counter}` }
    },
    prompt: (params: { prompt: Array<{ text: string }> }) => {
      wire.push('prompt')
      promptCalls.push(params.prompt[0].text)
      // The whole block array as well as its first text: an attachment travels
      // as a SECOND block, so a capture that only ever read [0] could not tell
      // a picture that was sent from one that was dropped.
      promptBlockCalls.push(params.prompt as unknown as PromptBlock[])
      return new Promise((resolve, reject) => {
        turns.push({ resolve, reject })
      })
    },
    resumeSession: async (params: { sessionId: string }) => {
      wire.push('resume')
      resumeCalls.push(params.sessionId)
      return {}
    },
    cancel: async () => {
      if (options.cancelEndsTurn) {
        turns.shift()?.resolve({ stopReason: 'cancelled' })
      }
    },
    setSessionConfigOption: async (params: { sessionId: string; configId: string; value: unknown }) => {
      configOptionCalls.push(params)
      return { configOptions: options.configOptions }
    },
    closeSession: async (params: { sessionId: string }) => {
      closeSessionCalls.push(params.sessionId)
      return {}
    },
    extMethod: async (method: string, params: Record<string, unknown>) => {
      extMethodCalls.push({ method, params })
      if (method === '_session/steering') {
        return { outcome: (await options.steerOutcome) ?? 'injected' }
      }
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
    steeringSupported: options.steeringSupported === true,
    forkSupported: options.forkSupported === true,
    imagePrompt: options.imagePrompt === true,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient({
    ...(options.transformDeliveredPrompt
      ? ({ transformDeliveredPrompt: options.transformDeliveredPrompt } satisfies Pick<
          AgentClientOptions,
          'transformDeliveredPrompt'
        >)
      : {}),
    ...(options.queueStore
      ? ({ queueStore: options.queueStore } satisfies Pick<AgentClientOptions, 'queueStore'>)
      : {}),
    ...(options.loadPresence
      ? ({ loadPresence: options.loadPresence } satisfies Pick<AgentClientOptions, 'loadPresence'>)
      : {}),
    ...(options.shouldHoldDelivery
      ? ({ shouldHoldDelivery: options.shouldHoldDelivery } satisfies Pick<AgentClientOptions, 'shouldHoldDelivery'>)
      : {}),
    ...(options.openSessionForKey
      ? ({ openSessionForKey: options.openSessionForKey } satisfies Pick<AgentClientOptions, 'openSessionForKey'>)
      : {}),
    ...(options.onCompaction
      ? ({ onCompaction: options.onCompaction } satisfies Pick<AgentClientOptions, 'onCompaction'>)
      : {}),
    ...(options.loadAttachments
      ? ({ loadAttachments: options.loadAttachments } satisfies Pick<AgentClientOptions, 'loadAttachments'>)
      : {}),
    ...(options.stopHostTask
      ? ({ stopHostTask: options.stopHostTask } satisfies Pick<AgentClientOptions, 'stopHostTask'>)
      : {}),
  })
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
    promptBlockCalls,
    configOptionCalls,
    closeSessionCalls,
    resumeCalls,
    extMethodCalls,
    forkCalls,
    wire,
    endTurn: (index?: number) => takeTurn(index)?.resolve({ stopReason: 'end_turn' }),
    // Resolve a turn with the FULL prompt response the harness would send —
    // the experimental usage/quota/failure decorations included. The engine
    // reads them at the settlement, so this is the door a test drives them in.
    endTurnWith: (response: Record<string, unknown>) => takeTurn()?.resolve(response as { stopReason: string }),
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

// The session's OWN event log, which is what an event index names. A
// subscriber's copy starts where it subscribed, so its positions are not these
// positions -- the exact confusion `userTurnAt` exists to keep out of the wire.
function sessionEvents(sessionId: string): ChatEvent[] {
  const session = acpStore().sessions.get(sessionId) as { events: ChatEvent[] } | undefined
  assert.ok(session, 'session must exist in the store')
  return session.events
}

// ── attachments ────────────────────────────────────────────────────────────

// An attachment travels BESIDE the text -- a field of the prompt, of the queue
// entry and of the delivered user event -- and turns into an image block at
// delivery. These exercise that conversion, the queue holding it, and every way
// it can fall short -- each of which must SAY so, because a picture that
// silently did not travel looks like an agent ignoring it.
const SHOT = { id: 'att-1', name: 'shot.png', mimeType: 'image/png' }
const loadOne = async () => [{ ...SHOT, data: 'AAAA' }]

function userEvents(events: ChatEvent[]): Extract<ChatEvent, { kind: 'user' }>[] {
  return events.filter((event): event is Extract<ChatEvent, { kind: 'user' }> => event.kind === 'user')
}

test('an attachment travels as an image block beside the text, and the user event records it', async () => {
  const h = await setup('claude', { imagePrompt: true, loadAttachments: loadOne })
  await h.client.prompt(h.sessionId, 'look at this', { queue: 'push', origin: { kind: 'system' }, attachments: [SHOT] })
  await settle()
  assert.deepEqual(h.promptBlockCalls, [
    [
      { type: 'text', text: 'look at this' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ],
  ])
  assert.deepEqual(userEvents(h.events).at(-1), { kind: 'user', text: 'look at this', attachments: [{ ...SHOT, message: 0 }] })
  assert.equal(kinds(h.events).includes('error'), false)
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('text that spells an attachment is only text', async () => {
  // The words are what somebody wrote, and nothing is read back out of them: a
  // pasted reference to a picture must reach no store and send no image.
  let asked = 0
  const h = await setup('claude', {
    imagePrompt: true,
    loadAttachments: async () => {
      asked += 1
      return loadOne()
    },
  })
  const pasted = 'see <user-attachment id="att-1" name="shot.png" type="image/png"/>'
  await h.client.prompt(h.sessionId, pasted, { queue: 'push', origin: { kind: 'system' } })
  await settle()
  assert.deepEqual(h.promptBlockCalls, [[{ type: 'text', text: pasted }]])
  assert.equal(asked, 0)
  assert.deepEqual(userEvents(h.events).at(-1), { kind: 'user', text: pasted })
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('a harness that advertised no image capability gets the text and an error, under the message', async () => {
  const h = await setup('claude', { imagePrompt: false, loadAttachments: loadOne })
  await h.client.prompt(h.sessionId, 'look at this', { queue: 'push', origin: { kind: 'system' }, attachments: [SHOT] })
  await settle()
  assert.deepEqual(h.promptBlockCalls, [[{ type: 'text', text: 'look at this' }]])
  const errors = h.events.filter((event) => event.kind === 'error')
  assert.equal(errors.length, 1, 'a dropped attachment must be visible, not silent')
  assert.match(
    (errors[0] as Extract<ChatEvent, { kind: 'error' }>).message,
    /did not advertise image prompts.*1 attachment did not travel/s,
  )
  const order = kinds(h.events)
  assert.ok(order.lastIndexOf('user') < order.indexOf('error'), 'the report follows the message it is about')
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('an attachment that is not an image is reported rather than sent as one', async () => {
  const h = await setup('claude', {
    imagePrompt: true,
    loadAttachments: async () => [{ id: 'att-1', name: 'notes.pdf', mimeType: 'application/pdf', data: 'AAAA' }],
  })
  await h.client.prompt(h.sessionId, 'read this', { queue: 'push', origin: { kind: 'system' }, attachments: [SHOT] })
  await settle()
  assert.deepEqual(h.promptBlockCalls, [[{ type: 'text', text: 'read this' }]])
  const errors = h.events.filter((event) => event.kind === 'error')
  assert.match((errors[0] as Extract<ChatEvent, { kind: 'error' }>).message, /1 attachment could not be sent as an image/)
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('a message with no attachment is one text block, as it always was', async () => {
  const h = await setup('claude', { imagePrompt: true, loadAttachments: loadOne })
  await h.client.prompt(h.sessionId, 'just words', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  assert.deepEqual(h.promptBlockCalls, [[{ type: 'text', text: 'just words' }]])
  assert.deepEqual(userEvents(h.events).at(-1), { kind: 'user', text: 'just words' })
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('a host with no attachment store sends the text and says the pictures did not travel', async () => {
  const h = await setup('claude', { imagePrompt: true })
  await h.client.prompt(h.sessionId, 'look at this', { queue: 'push', origin: { kind: 'system' }, attachments: [SHOT] })
  await settle()
  assert.deepEqual(h.promptBlockCalls, [[{ type: 'text', text: 'look at this' }]])
  const errors = h.events.filter((event) => event.kind === 'error')
  assert.match((errors[0] as Extract<ChatEvent, { kind: 'error' }>).message, /1 attachment did not travel/)
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('a held message keeps its picture, marked with its place in the batch it is delivered in', async () => {
  const h = await setup('openclaw', { imagePrompt: true, loadAttachments: loadOne })
  await h.client.prompt(h.sessionId, 'first turn', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'plain', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  // A picture with no words is still a message.
  await h.client.prompt(h.sessionId, '', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
    attachments: [SHOT],
  })
  h.endTurn()
  await settle()
  const batch = h.promptBlockCalls.at(-1)
  assert.equal(batch?.length, 2, 'the batch carries its one picture')
  assert.deepEqual(batch?.[1], { type: 'image', data: 'AAAA', mimeType: 'image/png' })
  assert.deepEqual(userEvents(h.events).at(-1)?.attachments, [{ ...SHOT, message: 1 }])
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('a system prompt that is a finished delivery keeps the positions it was given', async () => {
  // What an edit re-sends: a whole delivered body, with the pictures still on
  // the messages they came with.
  const h = await setup('claude', { imagePrompt: true, loadAttachments: loadOne })
  await h.client.prompt(h.sessionId, 'body', {
    queue: 'push',
    origin: { kind: 'system' },
    attachments: [{ ...SHOT, message: 2 }],
  })
  await settle()
  assert.deepEqual(userEvents(h.events).at(-1)?.attachments, [{ ...SHOT, message: 2 }])
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

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

// ── model selection via config option (modelEnv-less ACP agents) ────────────

// OpenCode/Codex carry no model env var: the profile's model can only reach
// them through the `model` config option advertised at session start. These
// exercise that application path (createSession's model-config step).
const MODEL_SELECT_OPTIONS = [
  {
    id: 'model',
    category: 'model',
    type: 'select',
    currentValue: 'opencode/big-pickle',
    options: [
      { name: 'Big Pickle', value: 'opencode/big-pickle' },
      { name: 'Claude Fable 5', value: 'anthropic/claude-fable-5' },
    ],
  },
]

test('a modelEnv-less adapter applies the profile model by exact option value at start', async () => {
  const h = await setup('openclaw', { model: 'anthropic/claude-fable-5', configOptions: MODEL_SELECT_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [
    { sessionId: h.sessionId, configId: 'model', value: 'anthropic/claude-fable-5' },
  ])
  await h.client.deleteSession(h.sessionId)
})

test('it resolves a bare model id to the unique provider/model option', async () => {
  const h = await setup('openclaw', { model: 'claude-fable-5', configOptions: MODEL_SELECT_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [
    { sessionId: h.sessionId, configId: 'model', value: 'anthropic/claude-fable-5' },
  ])
  await h.client.deleteSession(h.sessionId)
})

test('a model that matches no advertised option leaves the harness default', async () => {
  const h = await setup('openclaw', { model: 'ollama/llama-99', configOptions: MODEL_SELECT_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [], 'guessing a model is worse than the default the harness already has')
  // The mismatch is reported, not swallowed: this error event is the only
  // sign a profile is naming a model the harness can't offer (e.g. its
  // provider was never configured into the harness).
  const errors = sessionEvents(h.sessionId).filter((event) => event.kind === 'error')
  assert.equal(errors.length, 1, 'the mismatch must be visible in the chat, not a silent skip')
  assert.match(
    (errors[0] as Extract<ChatEvent, { kind: 'error' }>).message,
    /ollama\/llama-99.*not offered by OpenClaw.*opencode\/big-pickle, anthropic\/claude-fable-5/s,
  )
  await h.client.deleteSession(h.sessionId)
})

test('a selector that names only its id is still found, category being UX-only', async () => {
  // ACP's `category` is optional and the spec requires clients to cope without
  // it, so the conventional id has to be enough on its own. Both selectors are
  // exercised in one session: the profile's model gets applied and its
  // reasoning preference lands on the effort option beside it. The effort is
  // stated rather than defaulted — only the claude adapters carry a default,
  // and those pin the model through an env var instead of the option.
  const uncategorized = [
    {
      id: 'model',
      type: 'select',
      currentValue: 'a',
      options: [
        { name: 'A', value: 'a' },
        { name: 'B', value: 'b' },
      ],
    },
    { id: 'effort', type: 'select', options: [{ name: 'Medium', value: 'medium' }] },
  ]
  const h = await setup('openclaw', { model: 'b', reasoningEffort: 'medium', configOptions: uncategorized })
  await settle()
  assert.deepEqual(h.configOptionCalls, [
    { sessionId: h.sessionId, configId: 'effort', value: 'medium' },
    { sessionId: h.sessionId, configId: 'model', value: 'b' },
  ])
  await h.client.deleteSession(h.sessionId)
})

test('the profile model already being current sends no redundant set', async () => {
  const h = await setup('openclaw', { model: 'opencode/big-pickle', configOptions: MODEL_SELECT_OPTIONS })
  await settle()
  assert.deepEqual(h.configOptionCalls, [])
  await h.client.deleteSession(h.sessionId)
})

test('an adapter WITH a model env var never applies the model via config option', async () => {
  // Claude pins the model through ANTHROPIC_MODEL, so even when it advertises a
  // model option the config-option path must stand off — 'off' suppresses the
  // separate thought_level default so this asserts the model path alone.
  const h = await setup('claude', {
    model: 'anthropic/claude-fable-5',
    reasoningEffort: 'off',
    configOptions: MODEL_SELECT_OPTIONS,
  })
  await settle()
  assert.deepEqual(h.configOptionCalls, [])
  await h.client.deleteSession(h.sessionId)
})

// ── OpenCode provider wiring (OPENCODE_CONFIG_CONTENT) ──────────────────────
//
// OpenCode ignores the standard OPENAI_* / model env vars entirely and builds
// its model catalog from its own provider configuration, so buildSpawnConfig
// synthesizes that configuration from the selection (see selectionEnv in
// harness-adapters). Without it the harness advertises only its built-in free
// models and the profile's model can never match.

const OPENCODE_SELECTION = {
  providerId: 'zai',
  adapterId: 'opencode',
  model: 'glm-5.3-flash',
  apiKey: 'secret-key-material',
  cwd: '/tmp/agent-client-test-opencode',
} satisfies AgentSelection

test('an opencode spawn carries its provider as an OpenCode config document', () => {
  const content = buildSpawnConfig(OPENCODE_SELECTION).env.OPENCODE_CONFIG_CONTENT
  assert.ok(content, 'the config document must travel in the spawn env')
  assert.ok(!content.includes('secret-key-material'), 'the document references the key, it never carries it')
  const entry = JSON.parse(content).provider.zai
  assert.equal(entry.npm, '@ai-sdk/openai-compatible')
  assert.equal(entry.options.baseURL, 'https://api.z.ai/api/coding/paas/v4')
  assert.equal(entry.options.apiKey, '{env:ZAI_API_KEY}')
  // Context-variant bracket ids stay out: the OpenAI-compatible endpoint
  // rejects them ("Unknown Model"), so offering one invites a mid-turn error.
  assert.ok('glm-5.3-flash' in entry.models)
  assert.ok(
    Object.keys(entry.models).every((id) => !id.includes('[')),
    'no context-variant bracket ids in the offered models',
  )
})

test('an opencode baseUrl override wins over the provider endpoint', () => {
  const content = buildSpawnConfig({ ...OPENCODE_SELECTION, baseUrl: 'https://proxy.example.test/v4' })
    .env.OPENCODE_CONFIG_CONTENT
  assert.equal(JSON.parse(content).provider.zai.options.baseURL, 'https://proxy.example.test/v4')
})

test('an opencode selection without a key omits the key reference', () => {
  const content = buildSpawnConfig({ ...OPENCODE_SELECTION, apiKey: '' }).env.OPENCODE_CONFIG_CONTENT
  assert.ok(!('apiKey' in JSON.parse(content).provider.zai.options))
})

// The bridge's plan tools are opt-in. A flag set in the host's own environment
// reached host-run bridges and never a containerised one, which gets only what
// its spawn names -- so it has to be the spawn that names it.
test('a claude bridge gets its plan tools wherever it runs, a container included', () => {
  for (const adapterId of ['claude', 'claude-subscription']) {
    const selection: AgentSelection = {
      providerId: 'anthropic',
      adapterId,
      model: 'test-model',
      apiKey: 'key',
      cwd: '/agents/somebody',
      containerName: 'agents-box',
    }
    const config = buildSpawnConfig(selection)
    assert.equal(config.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, '1', adapterId)
    const forwarded = config.args.flatMap((arg, i) => (config.args[i - 1] === '-e' ? [arg] : []))
    assert.ok(forwarded.includes('CLAUDE_CODE_ENABLE_TODO_TOOLS'), `${adapterId}: named to docker exec`)
  }
})

test('a provider with no OpenAI-compatible endpoint gets no config document', () => {
  const config = buildSpawnConfig({ ...OPENCODE_SELECTION, providerId: 'anthropic' })
  assert.equal(config.env.OPENCODE_CONFIG_CONTENT, undefined)
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

// A session/load replay re-announces every subagent and streams its sidechain
// under the child's own session id (claude-agent-acp's replay contract), so
// coming back to a conversation must reproduce the nested transcripts, not
// just the parent's. This drives the exact wire sequence the bridge sends.
test('a replay reproduces subagent transcripts: announced, nested, and closed', async () => {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const sessionId = `replayed-subagents-${counter}`
  const childId = `${sessionId}:replay-subagent:toolu_1`
  const push = (sid: string, update: Record<string, unknown>) =>
    handleUpdate({ sessionId: sid, update } as Parameters<typeof handleUpdate>[0])
  const connection = {
    loadSession: async () => {
      push(sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'delegate this' } })
      push(sessionId, {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: childId,
        name: 'Investigator',
        task: 'dig',
        capabilities: {},
      })
      push(childId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'dig here' } })
      push(childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'dug' } })
      push(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'summary' } })
      push(sessionId, { sessionUpdate: 'subagent_state_update', subagentSessionId: childId, state: 'completed' })
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

  const spawned = events.find((event) => event.kind === 'subagent')
  assert.ok(spawned && spawned.kind === 'subagent' && spawned.subagent.name === 'Investigator')
  const nested = events.filter(
    (event): event is Extract<ChatEvent, { kind: 'subagent_event' }> => event.kind === 'subagent_event',
  )
  assert.deepEqual(
    nested.map((event) => event.event.kind),
    ['user', 'agent_message'],
    'the sidechain nested under the parent, in order',
  )
  const closed = events.filter((event) => event.kind === 'subagent').at(-1)
  assert.ok(closed && closed.kind === 'subagent' && closed.subagent.state === 'completed')
  // And the cold-open tail window a reconnecting chat is served must carry
  // them too — this is the read the SSE stream actually performs.
  const window = client.getRecordsWindow(sessionId, { records: 20 })
  assert.ok(window?.events.some((event) => event.kind === 'subagent_event'))
  await client.deleteSession(sessionId)
})

// ── restoring a session from a transcript the host kept ────────────────────
//
// The replay above is the harness's account of a conversation, and it is only
// as complete as what the harness persisted. On claude-agent-acp 0.78.0 a
// subagent's own transcript is stored in a separate file the replay never
// reads, and the parent transcript carries no sidechain rows at all — so the
// bridge has nothing to announce the delegation with and strips the Agent tool
// call from the parent besides. Nothing is wrong with the replay handling; the
// data does not cross the wire. restoreSession is the other door: rebuild the
// transcript from what this side recorded as it was shown, and ask the harness
// only for the agent.

interface RestoreHarness {
  client: ReturnType<typeof createAgentClient>
  sessionId: string
  selection: AgentSelection
  loadCalls: string[]
  resumeCalls: string[]
  observed: ChatEvent[]
}

// A connection that can do both, so a test can assert WHICH one was used —
// "the transcript came back" is satisfied by either, and only the call log
// distinguishes restoring from replaying.
function restoreSetup(options: { resumable?: boolean; forkSupported?: boolean } = {}): RestoreHarness {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
    sessionKey: `restore-key-${counter}`,
  }
  const sessionId = `restored-session-${counter}`
  const loadCalls: string[] = []
  const resumeCalls: string[] = []
  const connection = {
    loadSession: async (params: { sessionId: string }) => {
      loadCalls.push(params.sessionId)
      return {}
    },
    resumeSession: async (params: { sessionId: string }) => {
      resumeCalls.push(params.sessionId)
      return {}
    },
  } as unknown as AgentConnection
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: true,
    resumeSession: options.resumable !== false,
    forkSupported: options.forkSupported === true,
    initialized: Promise.resolve(),
  })
  const observed: ChatEvent[] = []
  const client = createAgentClient({ onEvent: (_sessionId, event) => observed.push(event) })
  return { client, sessionId, selection, loadCalls, resumeCalls, observed }
}

// The recording of a delegation, in the vocabulary the engine emits it in —
// what the host's event log holds after the turn above was watched live.
function recordedDelegation(childId: string): ChatEvent[] {
  return [
    { kind: 'user', text: 'delegate this' },
    { kind: 'subagent', subagent: { subagentSessionId: childId, name: 'Investigator', task: 'dig' } },
    { kind: 'subagent_event', subagentSessionId: childId, event: { kind: 'user', text: 'dig here' } },
    { kind: 'subagent_event', subagentSessionId: childId, event: { kind: 'agent_message', text: 'dug' } },
    { kind: 'agent_message', text: 'summary' },
    {
      kind: 'subagent',
      subagent: { subagentSessionId: childId, name: 'Investigator', task: 'dig', state: 'completed' },
    },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
}

test('a restored session reproduces the subagent blocks a replay cannot carry', async () => {
  const harness = restoreSetup()
  const childId = `${harness.sessionId}:subagent:toolu_1`
  const recorded = recordedDelegation(childId)

  const meta = await harness.client.restoreSession(harness.sessionId, harness.selection, recorded)

  assert.ok(meta, 'a resumable agent must restore rather than refuse')
  const events: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => events.push(event))
  const spawned = events.find((event) => event.kind === 'subagent')
  assert.ok(spawned && spawned.kind === 'subagent' && spawned.subagent.name === 'Investigator')
  const nested = events.filter(
    (event): event is Extract<ChatEvent, { kind: 'subagent_event' }> => event.kind === 'subagent_event',
  )
  assert.deepEqual(
    nested.map((event) => event.event.kind),
    ['user', 'agent_message'],
    'the subagent transcript is nested under the parent, in order',
  )
  const closed = events.filter((event) => event.kind === 'subagent').at(-1)
  assert.ok(closed && closed.kind === 'subagent' && closed.subagent.state === 'completed')
  await harness.client.deleteSession(harness.sessionId)
})

test('restoring asks the harness to resume, never to replay', async () => {
  // The two must not BOTH happen: a replay on top of a restored log would write
  // the conversation into the transcript a second time, which is the failure
  // this whole path has to avoid rather than merely a wasted round trip.
  const harness = restoreSetup()
  await harness.client.restoreSession(harness.sessionId, harness.selection, recordedDelegation('child-1'))

  assert.deepEqual(harness.resumeCalls, [harness.sessionId], 'the agent is reattached')
  assert.deepEqual(harness.loadCalls, [], 'and never asked for its history')
  await harness.client.deleteSession(harness.sessionId)
})

test('an agent that cannot resume refuses, so the caller can still replay', async () => {
  // Falling back is the caller's decision, and it needs to be able to tell
  // "restored" from "could not" — a half-registered session either way would
  // leave a replay landing on top of one.
  const harness = restoreSetup({ resumable: false })

  const meta = await harness.client.restoreSession(harness.sessionId, harness.selection, recordedDelegation('child-1'))

  assert.equal(meta, null)
  assert.deepEqual(harness.resumeCalls, [])
})

test('restored events are not handed back to the host that recorded them', async () => {
  // They are seeded by assignment rather than emitted. Emitted, a host storing
  // what it observes would write its own log back into itself on every reopen,
  // and the transcript would double in length each time a chat was opened.
  const harness = restoreSetup()
  const recorded = recordedDelegation('child-1')

  await harness.client.restoreSession(harness.sessionId, harness.selection, recorded)

  assert.deepEqual(harness.observed, [], 'nothing restored is re-announced to the observation hook')
  await harness.client.deleteSession(harness.sessionId)
})

test('a restored session keeps the agent word on forking, not its age', async () => {
  // The path every conversation predating the fork capability reopens through.
  // Hardcoding false here made every old thread report an agent that cannot
  // fork — the menu vanished for exactly the sessions with the most history.
  const h = restoreSetup({ forkSupported: true })
  const meta = await h.client.restoreSession(h.sessionId, h.selection, [
    { kind: 'user', text: 'one' },
    { kind: 'agent_message', text: 'reply' },
  ])
  assert.ok(meta, 'precondition: the restore reattached')
  assert.equal(meta.canFork, true)

  const plain = restoreSetup()
  const plainMeta = await plain.client.restoreSession(plain.sessionId, plain.selection, [
    { kind: 'user', text: 'one' },
  ])
  assert.ok(plainMeta)
  assert.equal(plainMeta.canFork, false, 'no advertisement, no fork — same word a fresh session answers by')
  await h.client.deleteSession(h.sessionId)
  await plain.client.deleteSession(plain.sessionId)
})

test('a restored session is still live: a running subagent keeps nesting into it', async () => {
  // The subagent->parent route lives in a module-level map, not on the session,
  // so restoring the records is not enough. Without the routes rebuilt, a
  // subagent that was STILL RUNNING when the process stopped comes back drawn
  // in the transcript and then goes silent, which is the same loss wearing a
  // different face.
  const harness = restoreSetup()
  const childId = `${harness.sessionId}:subagent:toolu_1`
  await harness.client.restoreSession(harness.sessionId, harness.selection, [
    { kind: 'user', text: 'delegate this' },
    { kind: 'subagent', subagent: { subagentSessionId: childId, name: 'Investigator', task: 'dig' } },
  ])
  const events: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => events.push(event))

  handleUpdate({
    sessionId: childId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still digging' } },
  } as Parameters<typeof handleUpdate>[0])

  const nested = events.filter(
    (event): event is Extract<ChatEvent, { kind: 'subagent_event' }> => event.kind === 'subagent_event',
  )
  assert.equal(nested.at(-1)?.event.kind, 'agent_message')
  await harness.client.deleteSession(harness.sessionId)
})

test('a restored session rebuilds the route of a subagent another subagent spawned', async () => {
  // The spawn of a grandchild is recorded inside its parent's step. Restored
  // as a direct child of the session, its next chunk would land one level too
  // high, beside the subagent that spawned it.
  const harness = restoreSetup()
  const childId = 'thread-worker'
  const grandchildId = 'thread-helper'
  const helper = { subagentSessionId: grandchildId, name: 'Helper', task: 'check one half' }
  await harness.client.restoreSession(harness.sessionId, harness.selection, [
    { kind: 'user', text: 'delegate this' },
    { kind: 'subagent', subagent: { subagentSessionId: childId, name: 'Worker', task: 'split the job' } },
    { kind: 'subagent_event', subagentSessionId: childId, event: { kind: 'subagent', subagent: helper } },
  ])
  assert.ok(harness.client.hasBackgroundWork(harness.sessionId), 'the restored grandchild is live work')
  const events: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => events.push(event))

  handleUpdate({
    sessionId: grandchildId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'still checking' } },
  } as Parameters<typeof handleUpdate>[0])

  assert.deepEqual(events.at(-1), {
    kind: 'subagent_event',
    subagentSessionId: childId,
    event: {
      kind: 'subagent_event',
      subagentSessionId: grandchildId,
      event: { kind: 'agent_message', text: 'still checking' },
    },
  })
  await harness.client.deleteSession(harness.sessionId)
})

test('the cold-open window a reconnecting chat is served carries the restored subagents', async () => {
  // This is the read the SSE stream actually performs on connect — a restored
  // transcript that only satisfies subscribe() would still open empty there.
  const harness = restoreSetup()
  const childId = `${harness.sessionId}:subagent:toolu_1`
  await harness.client.restoreSession(harness.sessionId, harness.selection, recordedDelegation(childId))

  const window = harness.client.getRecordsWindow(harness.sessionId, { records: 20 })

  assert.ok(window, 'a restored session must be windowable like any other')
  assert.ok(
    window.events.some((event) => event.kind === 'subagent_event'),
    'the nested subagent transcript is in the window a cold open is served',
  )
  await harness.client.deleteSession(harness.sessionId)
})

test('a transcript recorded up to its last turn boundary gains no second one', async () => {
  // Reopening the same conversation repeatedly must not accumulate boundaries:
  // each one reads as a turn, so a chat opened five times would show five.
  const harness = restoreSetup()
  await harness.client.restoreSession(harness.sessionId, harness.selection, recordedDelegation('child-1'))

  const events: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => events.push(event))
  assert.equal(
    events.filter((event) => event.kind === 'turn_end').length,
    1,
    'the boundary already recorded is the only one',
  )
  await harness.client.deleteSession(harness.sessionId)
})

test('a transcript that stops mid-turn is closed, so the chat does not sit waiting forever', async () => {
  // The process stopped while the agent was working. Nothing is coming to end
  // that turn — the turn ended when the process did — and a client with no
  // boundary shows a spinner for a session that is idle.
  const harness = restoreSetup()
  await harness.client.restoreSession(harness.sessionId, harness.selection, [
    { kind: 'user', text: 'do the thing' },
    { kind: 'tool_call', toolCallId: 'call-1', title: 'Bash', status: 'in_progress' },
  ])

  const events: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => events.push(event))
  const closing = events.filter((event) => event.kind === 'turn_end')
  assert.equal(closing.length, 1)
  assert.equal(
    closing[0].kind === 'turn_end' ? closing[0].stopReason : null,
    'resumed',
    'a turn cut off mid-step is reported as interrupted, not as a clean end',
  )
  await harness.client.deleteSession(harness.sessionId)
})

test('a restored queue snapshot carries nothing, so delivered messages do not come back unread', async () => {
  // A queue snapshot describes what was waiting when it was published. What is
  // waiting NOW comes from the durable queue when the session opens, and a
  // reader cannot tell a stale snapshot from a live one.
  const harness = restoreSetup()
  await harness.client.restoreSession(harness.sessionId, harness.selection, [
    { kind: 'user', text: 'first' },
    { kind: 'queue', items: [{ id: 'q1', kind: 'message', sender: 'Reader', sentAt: '2026-01-01T00:00:00.000Z', text: 'held' }] },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ])

  const events: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => events.push(event))
  assert.deepEqual(
    events.filter((event) => event.kind === 'queue').flatMap((event) => (event.kind === 'queue' ? event.items : [])),
    [],
    'nothing in the restored transcript claims a message is still waiting',
  )
  await harness.client.deleteSession(harness.sessionId)
})

test('a restored transcript keeps every event at the position it was recorded at', async () => {
  // A user turn is NAMED by its index in this log — that is what an edit
  // commit and a fork send to say which message they mean — and a browser
  // holding an index from before a restart cannot learn that it shifted.
  //
  // The queue snapshot in the middle is the discriminator: it is the one event
  // the restore must not carry the CONTENTS of, and dropping it to achieve
  // that moved every index after it down by one. The second user turn is what
  // an edit or a fork would then land on when the reader asked for the third.
  const harness = restoreSetup()
  const recorded: ChatEvent[] = [
    { kind: 'user', text: 'first' },
    { kind: 'queue', items: [{ id: 'q1', kind: 'message', sender: 'Reader', sentAt: '2026-01-01T00:00:00.000Z', text: 'held' }] },
    { kind: 'agent_message', text: 'working' },
    { kind: 'user', text: 'second' },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  await harness.client.restoreSession(harness.sessionId, harness.selection, recorded)

  const events = harness.client.getSessionEvents(harness.sessionId) ?? []
  for (const [index, event] of recorded.entries()) {
    assert.equal(events[index]?.kind, event.kind, `event ${index} is still a ${event.kind}`)
  }
  const second = events.findIndex((event) => event.kind === 'user' && event.text === 'second')
  assert.equal(second, 3, 'the second turn answers to the index it was recorded at, not one lower')
  await harness.client.deleteSession(harness.sessionId)
})

test('a permission left unanswered by the stopped process is restored closed, not live', async () => {
  // Its resolve lived in the memory of a process that is gone, so the buttons
  // a reader would be shown resolve nothing at all. The request stays in the
  // transcript — it was asked — but it is not drawn as still waiting.
  const harness = restoreSetup()
  await harness.client.restoreSession(harness.sessionId, harness.selection, [
    { kind: 'user', text: 'do the thing' },
    { kind: 'permission_request', requestId: 'req-1', title: 'Run a command', options: [] },
  ])

  const events: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => events.push(event))
  const [permission] = foldEvents(events).filter((message) => message.kind === 'permission')
  assert.ok(permission && permission.kind === 'permission')
  assert.equal(permission.resolved, true)
  await harness.client.deleteSession(harness.sessionId)
})

test('a restored session keeps the modes and usage its log recorded', async () => {
  // These are "last value wins" state the engine mirrors on the session as it
  // arrives, so a windowed read can be handed the current value. A restored
  // session has the whole history and none of the mirror — without folding it
  // back out, a chat that opens past the point its modes were announced has no
  // modes at all.
  const harness = restoreSetup()
  await harness.client.restoreSession(harness.sessionId, harness.selection, [
    { kind: 'modes', available: [{ id: 'default', name: 'Default' }], current: 'default' },
    { kind: 'usage', used: 4200, size: 200000 },
    { kind: 'mode_changed', current: 'plan' },
    { kind: 'user', text: 'and then a long conversation' },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ])

  assert.equal(harness.client.sessionModes(harness.sessionId)?.current, 'plan')
  assert.deepEqual(
    harness.client.listSessions().find((session) => session.id === harness.sessionId)?.usage,
    { used: 4200, size: 200000 },
  )
  await harness.client.deleteSession(harness.sessionId)
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

// ── the wake-the-model envelope is not a message ───────────────────────────

// Verbatim from a real transcript: what the Claude SDK sends its
// own model when a background task finishes. It arrives on the wire as an
// ordinary user message, and left alone it renders as the reader having pasted
// a block of XML into the conversation.
const TASK_NOTIFICATION = [
  '<task-notification>',
  '<task-id>a31fca27d7d61ace2</task-id>',
  '<tool-use-id>call_7b9f683965574aa0b2414ed3</tool-use-id>',
  '<output-file>/tmp/tasks/a31fca27d7d61ace2.output</output-file>',
  '<status>completed</status>',
  '<summary>Agent "Temp file write/read/delete test" finished</summary>',
].join('\n')

test('a task-notification envelope never reaches the transcript', async () => {
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: TASK_NOTIFICATION } },
  } as Parameters<typeof handleUpdate>[0])

  assert.deepEqual(
    h.events.filter((event) => event.kind === 'user'),
    [],
    'the envelope is the model’s context, not something the reader said',
  )
  await h.client.deleteSession(h.sessionId)
})

test('a real user message is still a user message', async () => {
  // The negative control for the test above: the check must be able to fail,
  // and a predicate that dropped ordinary messages would pass it just as well.
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'what changed?' } },
  } as Parameters<typeof handleUpdate>[0])

  assert.deepEqual(
    h.events.filter((event) => event.kind === 'user'),
    [{ kind: 'user', text: 'what changed?' }],
  )
  await h.client.deleteSession(h.sessionId)
})

test('a replayed task-notification is dropped without splitting the turn it landed in', async () => {
  // The replay reconstructs a turn boundary at the start of each replayed
  // message. Dropping the envelope after that check would leave the boundary
  // behind, and a reader would see their own turn cut in two at a message
  // nobody sent.
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const sessionId = `task-notification-replay-${counter}`
  const push = (update: Record<string, unknown>) =>
    handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
  const connection = {
    loadSession: async () => {
      push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run it in the background' } })
      push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'started' } })
      push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: TASK_NOTIFICATION } })
      push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'and it finished' } })
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
    events.filter((event) => event.kind === 'user').map((event) => (event.kind === 'user' ? event.text : '')),
    ['run it in the background'],
    'one replayed message, and it is the one somebody sent',
  )
  assert.equal(
    events.filter((event) => event.kind === 'turn_end').length,
    1,
    'only the closing boundary — the envelope opened none',
  )
  await client.deleteSession(sessionId)
})

test('a subagent is woken the same way, and it is no more the reader’s business nested', async () => {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const sessionId = `nested-task-notification-${counter}`
  const childId = `${sessionId}:subagent:toolu_1`
  const push = (sid: string, update: Record<string, unknown>) =>
    handleUpdate({ sessionId: sid, update } as Parameters<typeof handleUpdate>[0])
  const connection = {
    loadSession: async () => {
      push(sessionId, {
        sessionUpdate: 'subagent_spawned',
        subagentSessionId: childId,
        name: 'Investigator',
        task: 'dig',
        capabilities: {},
      })
      push(childId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: TASK_NOTIFICATION } })
      push(childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'dug' } })
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

  const nested = events.filter(
    (event): event is Extract<ChatEvent, { kind: 'subagent_event' }> => event.kind === 'subagent_event',
  )
  assert.deepEqual(
    nested.map((event) => event.event.kind),
    ['agent_message'],
    'the envelope is dropped inside the subagent transcript too',
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
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'third', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  // Only the first prompt reached the agent; the rest were held.
  assert.deepEqual(deliveries(h), [['first']])
  // Every snapshot, in order. `first` never appears: batching moved to dequeue
  // so it passed THROUGH the queue on its way out, but it never waited, and a
  // message that never waited is not unread.
  assert.deepEqual(queueSnapshots(h.events), [['second'], ['second', 'third']])
  await h.client.deleteSession(h.sessionId)
})

test('turn end drains the whole leading run as one delivery, in order', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'third', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()
  // Everything that was waiting goes TOGETHER, in the order it was written —
  // one turn, not one per message. That is what batching at dequeue means: a
  // message waits as itself, keeping its own author and send time, and only
  // becomes part of a batch at the moment it is handed over.
  assert.deepEqual(deliveries(h), [['first'], ['second', 'third']])
  h.endTurn()
  await settle()
  // Two enqueues, then ONE clearing snapshot — where the old queue emitted one
  // per drained message (`[['second'], ['second','third'], ['third'], []]`),
  // because it delivered one per turn. The run goes at once, so there is one
  // state change to publish, not two.
  assert.deepEqual(queueSnapshots(h.events), [['second'], ['second', 'third'], []])
  // The terminal event precedes the drained user turn in the log.
  assert.deepEqual(
    kinds(h.events).filter((kind) => kind === 'user' || kind === 'turn_end'),
    ['user', 'turn_end', 'user', 'turn_end'],
  )
  await h.client.deleteSession(h.sessionId)
})

test('an available_commands_update notification replaces session commands and emits a snapshot', async () => {
  const h = await setup('openclaw')
  const commands = [{ name: 'review', description: 'Review code', input: { hint: 'path' } }]
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
  } as Parameters<typeof handleUpdate>[0])
  const snapshots = h.events.filter((event) => event.kind === 'available_commands')
  assert.deepEqual(snapshots.at(-1), { kind: 'available_commands', commands })
  await h.client.deleteSession(h.sessionId)
})

// ── agent plan (ACP `plan` session update) ──────────────────────────────────
//
// claude-agent-acp translates TodoWrite and its Task* tools into `plan`
// updates, and every update carries the FULL entry list — so the fold must
// treat the plan as one entity patched in place, not a checklist per update.
// An empty list clears it: the bridge publishes one when a conversation reset
// retires its task store. The wire updates are driven directly because the
// contract under test is handleUpdate's; any ACP agent with a plan arrives
// the same way.

const planUpdate = (entries: Array<{ content: string; status: string; priority: string }>) => ({
  sessionUpdate: 'plan',
  entries,
})

const pushPlan = (sessionId: string, entries: Array<{ content: string; status: string; priority: string }>) => {
  handleUpdate({ sessionId, update: planUpdate(entries) } as Parameters<typeof handleUpdate>[0])
}

const planMessages = (sessionId: string) =>
  foldEvents(sessionEvents(sessionId)).filter((message) => message.kind === 'plan')

const storedPlan = (sessionId: string) =>
  (acpStore().sessions.get(sessionId) as { plan?: Array<Record<string, string>> } | undefined)?.plan

test('plan updates fold to one checklist row patched in place', async () => {
  const h = await setup('openclaw')
  const first = [{ content: 'read the code', status: 'in_progress', priority: 'high' }]
  const second = [
    { content: 'read the code', status: 'completed', priority: 'high' },
    { content: 'fix the fold', status: 'in_progress', priority: 'high' },
  ]
  pushPlan(h.sessionId, first)
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'starting' } },
  } as Parameters<typeof handleUpdate>[0])
  pushPlan(h.sessionId, second)

  // One row, carrying the LAST update's entries — the first update fixed its
  // place, this one patched it.
  const plans = planMessages(h.sessionId)
  assert.equal(plans.length, 1)
  assert.ok(plans[0]?.kind === 'plan')
  assert.deepEqual(plans[0].entries, second)
  // The checklist sits in the transcript at the position of the FIRST plan
  // event — before the reply chunk that arrived between the updates.
  const messages = foldEvents(sessionEvents(h.sessionId))
  assert.equal(messages.at(-2)?.kind, 'plan')
  // The plan update interleaving mid-reply must not split the message run:
  // the reply is one assistant message, the way SNAPSHOT_KINDS classifies the
  // plan as state rather than conversation.
  const assistant = messages.filter((message) => message.kind === 'assistant')
  assert.equal(assistant.length, 1)
  assert.ok(assistant[0]?.kind === 'assistant' && assistant[0].text === 'starting')
  // Mirrored onto the session so a windowed subscribe can synthesize it.
  assert.deepEqual(storedPlan(h.sessionId), second)
  await h.client.deleteSession(h.sessionId)
})

test('an empty plan clears the row, and the next plan anchors fresh', async () => {
  const h = await setup('openclaw')
  pushPlan(h.sessionId, [{ content: 'only step', status: 'pending', priority: 'medium' }])
  pushPlan(h.sessionId, [])
  // Cleared, not emptied: an empty checklist renders as nothing.
  assert.equal(planMessages(h.sessionId).length, 0)
  assert.deepEqual(storedPlan(h.sessionId), [])
  // And the next non-empty plan is a NEW row, not a patch of the removed one.
  const fresh = [{ content: 'fresh plan', status: 'in_progress', priority: 'high' }]
  pushPlan(h.sessionId, fresh)
  const plans = planMessages(h.sessionId)
  assert.equal(plans.length, 1)
  assert.ok(plans[0]?.kind === 'plan')
  assert.deepEqual(plans[0].entries, fresh)
  await h.client.deleteSession(h.sessionId)
})

test('a windowed subscribe hands a cold subscriber the live plan', async () => {
  const h = await setup('openclaw')
  const entries = [
    { content: 'read the code', status: 'completed', priority: 'high' },
    { content: 'fix the fold', status: 'in_progress', priority: 'high' },
  ]
  pushPlan(h.sessionId, entries)
  const planIndex = sessionEvents(h.sessionId).findIndex((event) => event.kind === 'plan')
  assert.ok(planIndex >= 0)
  // A subscriber whose window starts AFTER the plan event — the cut a long
  // session's cold open makes — is still handed the current plan, the same
  // present-tense treatment usage and the queue get.
  const replayed: ChatEvent[] = []
  h.client.subscribe(h.sessionId, (event) => replayed.push(event), { fromIndex: planIndex + 1 })
  const prefixed = replayed.filter((event): event is Extract<ChatEvent, { kind: 'plan' }> => event.kind === 'plan')
  assert.equal(prefixed.length, 1)
  assert.deepEqual(prefixed[0].entries, entries)
  // And a CLEARED plan is not resurrected by the prefix: the only plan event a
  // window past the clear sees is the real empty one from the log — a prefix
  // synthesized from the pre-clear entries would appear as a second.
  pushPlan(h.sessionId, [])
  const afterClear: ChatEvent[] = []
  h.client.subscribe(h.sessionId, (event) => afterClear.push(event), { fromIndex: planIndex + 1 })
  const cleared = afterClear.filter((event): event is Extract<ChatEvent, { kind: 'plan' }> => event.kind === 'plan')
  assert.equal(cleared.length, 1)
  assert.deepEqual(cleared[0].entries, [])
  await h.client.deleteSession(h.sessionId)
})

test('a restored session still hands a cold subscriber the live plan', async () => {
  // A restored session has the plan's events in its log but none of the
  // mirror the live path keeps, so without the restore fold the checklist
  // would sit behind the history cut — exactly the loss a restore exists to
  // prevent for the other snapshot kinds.
  const harness = restoreSetup()
  const recorded = [
    { kind: 'user', text: 'work through it' },
    { kind: 'plan', entries: [{ content: 'read the code', status: 'completed', priority: 'high' }] },
    { kind: 'agent_message', text: 'done' },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ] as ChatEvent[]
  await harness.client.restoreSession(harness.sessionId, harness.selection, recorded)

  const replayed: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => replayed.push(event), { fromIndex: 2 })
  const prefixed = replayed.filter((event): event is Extract<ChatEvent, { kind: 'plan' }> => event.kind === 'plan')
  assert.equal(prefixed.length, 1)
  assert.deepEqual(prefixed[0].entries, [{ content: 'read the code', status: 'completed', priority: 'high' }])
  // A plan the agent had CLEARED before the process stopped stays cleared.
  await harness.client.restoreSession(harness.sessionId, harness.selection, [
    ...recorded,
    { kind: 'plan', entries: [] },
  ])
  const afterClear: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => afterClear.push(event), { fromIndex: 2 })
  assert.ok(!afterClear.some((event) => event.kind === 'plan' && event.entries.length > 0))
  await harness.client.deleteSession(harness.sessionId)
})

test('a form elicitation surfaces its schema and resolves with the content object', async () => {
  const h = await setup('openclaw')
  const { createElicitation } = buildClient(() => h.sessionId, 'local')
  assert.ok(createElicitation)
  const schema = {
    type: 'object' as const,
    properties: { choice: { type: 'string' as const, oneOf: [{ const: 'a', title: 'A' }] } },
    required: ['choice'],
  }
  const response = createElicitation({
    mode: 'form',
    sessionId: h.sessionId,
    message: 'Pick one',
    requestedSchema: schema,
  })
  const ask = h.events.find((event) => event.kind === 'ask_user')
  assert.ok(ask && ask.kind === 'ask_user')
  assert.equal(ask.message, 'Pick one')
  assert.deepEqual(ask.form, schema)
  h.client.resolveElicitation(ask.requestId, { choice: 'a' })
  assert.deepEqual(await response, { action: 'accept', content: { choice: 'a' } })
  assert.ok(h.events.some((event) => event.kind === 'ask_user_resolved' && event.requestId === ask.requestId))
  await h.client.deleteSession(h.sessionId)
})

test('a url elicitation surfaces its link and resolves from the agent completion notification', async () => {
  const h = await setup('openclaw')
  const { createElicitation, completeElicitation } = buildClient(() => h.sessionId, 'local')
  assert.ok(createElicitation && completeElicitation)
  const response = createElicitation({
    mode: 'url',
    sessionId: h.sessionId,
    message: 'Authenticate',
    url: 'https://example.invalid/login',
    elicitationId: 'elic-1',
  })
  const ask = h.events.find((event) => event.kind === 'ask_user')
  assert.ok(ask && ask.kind === 'ask_user')
  assert.equal(ask.url, 'https://example.invalid/login')
  await completeElicitation({ elicitationId: 'elic-1' })
  assert.deepEqual(await response, { action: 'accept' })
  assert.ok(h.events.some((event) => event.kind === 'ask_user_resolved' && event.requestId === ask.requestId))
  await h.client.deleteSession(h.sessionId)
})

test('a host-raised askUser renders as the same ask_user event and answers with content or null', async () => {
  const h = await setup('openclaw')
  const schema = { type: 'object' as const, properties: { question_0: { type: 'string' as const } } }
  const first = h.client.askUser(h.sessionId, { message: 'Which way?', form: schema })
  const firstAsk = h.events.filter((event) => event.kind === 'ask_user').at(-1)
  assert.ok(firstAsk && firstAsk.kind === 'ask_user')
  assert.equal(firstAsk.message, 'Which way?')
  assert.deepEqual(firstAsk.form, schema)
  h.client.resolveElicitation(firstAsk.requestId, { question_0: 'left' })
  assert.deepEqual(await first, { question_0: 'left' })
  const second = h.client.askUser(h.sessionId, { message: 'Still there?' })
  const secondAsk = h.events.filter((event) => event.kind === 'ask_user').at(-1)
  assert.ok(secondAsk && secondAsk.kind === 'ask_user')
  h.client.resolveElicitation(secondAsk.requestId)
  assert.equal(await second, null)
  assert.equal(await h.client.askUser('no-such-session', { message: 'anyone?' }), null)
  await h.client.deleteSession(h.sessionId)
})

test('a plain-message elicitation still takes a free-text answer, and no answer still cancels', async () => {
  const h = await setup('openclaw')
  const { createElicitation } = buildClient(() => h.sessionId, 'local')
  assert.ok(createElicitation)
  const first = createElicitation({ mode: '_test/free-text', sessionId: h.sessionId, message: 'Say something' })
  const firstAsk = h.events.filter((event) => event.kind === 'ask_user').at(-1)
  assert.ok(firstAsk && firstAsk.kind === 'ask_user')
  assert.equal(firstAsk.form, undefined)
  h.client.resolveElicitation(firstAsk.requestId, 'hello')
  assert.deepEqual(await first, { action: 'accept', content: { answer: 'hello' } })
  const second = createElicitation({ mode: '_test/free-text', sessionId: h.sessionId, message: 'Say more' })
  const secondAsk = h.events.filter((event) => event.kind === 'ask_user').at(-1)
  assert.ok(secondAsk && secondAsk.kind === 'ask_user')
  h.client.resolveElicitation(secondAsk.requestId)
  assert.deepEqual(await second, { action: 'cancel' })
  await h.client.deleteSession(h.sessionId)
})

// One harness process serves every session of its agent, so which session the
// connection last prompted says nothing about which one is asking. The
// question goes where the request says; the guess is only for a request that
// names no session.
test('an elicitation goes to the session it names, not the one last prompted on its connection', async () => {
  const asking = await setup('openclaw')
  const lastPrompted = await setup('openclaw')
  const { createElicitation } = buildClient(() => lastPrompted.sessionId, 'local')
  assert.ok(createElicitation)
  const response = createElicitation({
    mode: 'form',
    sessionId: asking.sessionId,
    message: 'Pick one',
    requestedSchema: { type: 'object', properties: {} },
  })
  const ask = asking.events.find((event) => event.kind === 'ask_user')
  assert.ok(ask && ask.kind === 'ask_user', 'drawn in the chat whose agent asked')
  assert.ok(!lastPrompted.events.some((event) => event.kind === 'ask_user'), 'and nowhere else')
  asking.client.resolveElicitation(ask.requestId, {})
  assert.deepEqual(await response, { action: 'accept', content: {} })

  const unscoped = createElicitation({
    mode: 'form',
    requestId: 7,
    message: 'Before any session',
    requestedSchema: { type: 'object', properties: {} },
  })
  const guessed = lastPrompted.events.find((event) => event.kind === 'ask_user')
  assert.ok(guessed && guessed.kind === 'ask_user', 'a request-scoped one still reaches a chat')
  lastPrompted.client.resolveElicitation(guessed.requestId)
  assert.deepEqual(await unscoped, { action: 'cancel' })
  await asking.client.deleteSession(asking.sessionId)
  await lastPrompted.client.deleteSession(lastPrompted.sessionId)
})

// A question blocks a turn exactly as a permission request does, so the
// session reads as awaiting someone until it is answered — whoever asked it.
// Membership rather than equality: the store is shared across this file.
test('an unanswered agent elicitation holds the session in awaitingUserSessionKeys, over its still-running turn', async () => {
  const h = await setup('openclaw', { sessionKey: 'agent:asks:form' })
  await h.client.prompt(h.sessionId, 'go', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  const { createElicitation } = buildClient(() => h.sessionId, 'local')
  assert.ok(createElicitation)
  const response = createElicitation({
    mode: 'form',
    sessionId: h.sessionId,
    message: 'Pick one',
    requestedSchema: { type: 'object', properties: {} },
  })
  const ask = h.events.filter((event) => event.kind === 'ask_user').at(-1)
  assert.ok(ask && ask.kind === 'ask_user')
  assert.ok(h.client.awaitingUserSessionKeys().includes('agent:asks:form'))
  assert.ok(h.client.activeSessionKeys().includes('agent:asks:form'), 'the turn is still in flight underneath')
  h.client.resolveElicitation(ask.requestId, {})
  await response
  assert.ok(!h.client.awaitingUserSessionKeys().includes('agent:asks:form'), 'answered, no longer awaiting')
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('a host-raised askUser and a url elicitation both await the user until they end', async () => {
  const h = await setup('openclaw', { sessionKey: 'agent:asks:host' })
  const hostAsk = h.client.askUser(h.sessionId, { message: 'Which way?' })
  const raised = h.events.filter((event) => event.kind === 'ask_user').at(-1)
  assert.ok(raised && raised.kind === 'ask_user')
  assert.ok(h.client.awaitingUserSessionKeys().includes('agent:asks:host'))
  h.client.resolveElicitation(raised.requestId)
  assert.equal(await hostAsk, null)
  assert.ok(!h.client.awaitingUserSessionKeys().includes('agent:asks:host'), 'dismissed, no longer awaiting')

  const { createElicitation, completeElicitation } = buildClient(() => h.sessionId, 'local')
  assert.ok(createElicitation && completeElicitation)
  const login = createElicitation({
    mode: 'url',
    sessionId: h.sessionId,
    message: 'Authenticate',
    url: 'https://example.invalid/login',
    elicitationId: 'elic-awaiting',
  })
  assert.ok(h.client.awaitingUserSessionKeys().includes('agent:asks:host'))
  await completeElicitation({ elicitationId: 'elic-awaiting' })
  await login
  assert.ok(!h.client.awaitingUserSessionKeys().includes('agent:asks:host'), 'completed by the agent, no longer awaiting')
  await h.client.deleteSession(h.sessionId)
})

test('a command prompt is delivered verbatim — no tag, no author, no note', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, '/review src', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  // Raw equality on the wire text, not partsOf: the ABSENCE of a tag line is
  // the property under test, and the parser reads untagged text as a message
  // either way.
  assert.deepEqual(h.promptCalls, ['/review src'])
  await h.client.deleteSession(h.sessionId)
})

test('leading whitespace is stripped from a command so the harness still sees the slash first', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, '  /status', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(h.promptCalls, ['/status'])
  await h.client.deleteSession(h.sessionId)
})

test('a queued command is delivered alone and verbatim, never batched with messages', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, '/status', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()
  // The command is its own run: raw text, no batch around it.
  assert.equal(h.promptCalls[1], '/status')
  h.endTurn()
  await settle()
  // The message behind it still goes tagged, as itself.
  assert.deepEqual(deliveries(h)[2], ['second'])
  // The queue snapshot carried the command with its author, for the UI.
  const held = queueSnapshots(h.events)[1]
  assert.deepEqual(held, ['/status', 'second'])
  const commandItem = h.events
    .flatMap((event) => (event.kind === 'queue' ? event.items : []))
    .find((item) => item.text === '/status')
  assert.equal(commandItem?.kind, 'command')
  assert.equal(commandItem && 'sender' in commandItem ? commandItem.sender : undefined, 'Reader')
  await h.client.deleteSession(h.sessionId)
})

test('front-queued prompt jumps the line', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'urgent', {
    front: true,
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['urgent', 'second'])
  h.endTurn()
  await settle()
  // `urgent` is FIRST in the run, which is what `front` buys — and the run is
  // delivered whole, so what was already waiting rides along behind it rather
  // than being left for a later turn.
  assert.deepEqual(deliveries(h), [['first'], ['urgent', 'second']])
  await h.client.deleteSession(h.sessionId)
})

test('removeQueued drops a held message and is a no-op for unknown ids', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'third', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
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
  assert.deepEqual(deliveries(h), [['first'], ['third']])
  await h.client.deleteSession(h.sessionId)
})

test('a failed turn emits an error and still drains the queue', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.failTurn('boom')
  await settle()
  const errorIndex = h.events.findIndex((event) => event.kind === 'error')
  assert.ok(errorIndex >= 0, 'expected an error event')
  // The queued message was delivered after the failure was surfaced.
  assert.deepEqual(deliveries(h), [['first'], ['second']])
  // The user event carries the DELIVERED text, which is tagged, so the message
  // is found by decoding rather than by string equality.
  const secondUser = h.events.findIndex((event) => event.kind === 'user' && partsOf(event.text).includes('second'))
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
    await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
    await h.client.prompt(h.sessionId, 'steer', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
    // Both prompts reached the connection while the first turn was still open.
    assert.deepEqual(deliveries(h), [['first'], ['steer']])
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
    await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
    await h.client.prompt(h.sessionId, 'steer', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
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
    await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
    await h.client.prompt(h.sessionId, 'steer', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
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
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(deliveries(h), [['first']])
  assert.deepEqual(queueSnapshots(h.events), [['second']])
  h.endTurn()
  await settle()
  assert.deepEqual(deliveries(h), [['first'], ['second']])
  h.endTurn()
  await settle()
  await h.client.reset()
})

// ── deleteSession / session-close propagation ──────────────────────────────
//
// store.connections is keyed by spawn config, not sessionId, so these tests
// exercise the three cases that matter: the common single-session case
// (graceful close, nothing left to kill), the fallback (close unavailable,
// no sibling — kill the subprocess), and the guard that must never fire the
// fallback while a sibling session still shares the connection.

// A subscriber holds the session's record. When the record goes -- or is
// replaced by a reopen under the same id, which is what an unload followed by
// the next message does -- a subscriber that is not told stays attached to an
// object nothing emits into again: a chat that looks live and never moves.
test('dropping a session ends its subscriptions, once', async () => {
  const h = await setup()
  let ended = 0
  h.client.subscribe(h.sessionId, () => {}, { onEnd: () => (ended += 1) })
  await h.client.deleteSession(h.sessionId)
  assert.equal(ended, 1)
})

test('a session reopened under the same id ends the subscriptions of the record it replaces', async () => {
  const harness = restoreSetup()
  await harness.client.restoreSession(harness.sessionId, harness.selection, [{ kind: 'user', text: 'one' }])
  let ended = 0
  const stale: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => stale.push(event), { onEnd: () => (ended += 1) })
  const replayed = stale.length

  await harness.client.restoreSession(harness.sessionId, harness.selection, [{ kind: 'user', text: 'one' }])
  assert.equal(ended, 1, 'the reader is told its record is gone')

  const fresh: ChatEvent[] = []
  harness.client.subscribe(harness.sessionId, (event) => fresh.push(event))
  harness.client.askUser(harness.sessionId, { message: 'still there?' })
  assert.ok(fresh.some((event) => event.kind === 'ask_user'), 'a new subscription reads the new record')
  assert.equal(stale.length, replayed, 'and the old one hears nothing of it')
  await harness.client.deleteSession(harness.sessionId)
})

test('subscribing to an unknown session ends at once, and an unsubscribe is not an end', async () => {
  const h = await setup()
  let unknownEnded = 0
  h.client.subscribe('no-such-session', () => {}, { onEnd: () => (unknownEnded += 1) })
  assert.equal(unknownEnded, 1)
  let ended = 0
  const unsubscribe = h.client.subscribe(h.sessionId, () => {}, { onEnd: () => (ended += 1) })
  unsubscribe()
  await h.client.deleteSession(h.sessionId)
  assert.equal(ended, 0)
})

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
// Mirrors awaitingUserSessionKeys: the session key only appears while a
// turn is actually in flight (activeTurns > 0), and only when the selection
// carried a sessionKey at all — a session without one (e.g. an internal/ad
// hoc harness use) must never surface as a bare falsy entry.

test('activeSessionKeys is empty before any prompt is sent', async () => {
  const h = await setup('openclaw', { sessionKey: 'agent:carol:test' })
  assert.deepEqual(h.client.activeSessionKeys(), [])
})

test('activeSessionKeys includes the key while a turn is in flight, and drops it once the turn ends', async () => {
  const h = await setup('openclaw', { sessionKey: 'agent:carol:test' })
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(h.client.activeSessionKeys(), ['agent:carol:test'])
  h.endTurn()
  await settle()
  assert.deepEqual(h.client.activeSessionKeys(), [])
})

test('a session created without a sessionKey never appears, even mid-turn', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(h.client.activeSessionKeys(), [])
})

// ── aliveSessionKeys ─────────────────────────────────────────────────────
//
// Unlike activeSessionKeys (needs a turn in flight) or awaitingUserSessionKeys
// (needs a permission or a question left unanswered), this is "does a live agent process exist for
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
  // Configured, so the reading has a window it may be shown against at all --
  // a bridged session with none reports its tokens and no ratio (see the
  // known-window tests below, and context-window.test.ts for the rule itself).
  const h = await setup('openclaw', { contextWindow: 200_000 })
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
  const h = await setup('openclaw', { contextWindow: 1_000_000 })
  for (const used of [500_000, 20_000]) {
    handleUpdate({
      sessionId: h.sessionId,
      update: { sessionUpdate: 'usage_update', used, size: 200_000 },
    } as Parameters<typeof handleUpdate>[0])
  }
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 20_000,
    size: 1_000_000,
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
  const h = await setup('openclaw', { contextWindow: 200_000 })
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
  const h = await setup('openclaw', { contextWindow: 200_000 })
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
  const h = await setup('openclaw', { contextWindow: 200_000 })
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
  const h = await setup('openclaw', { contextWindow: 200_000 })
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
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
  const h = await setup('openclaw', { contextWindow: 200_000 })
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
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
  const h = await setup('openclaw', { contextWindow: 200_000 })
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
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
  const h = await setup('openclaw', { contextWindow: 200_000 })
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
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
  const h = await setup('openclaw', { contextWindow: 200_000 })
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

test('a bridged window can no longer flip mid-turn: the wire does not decide it any more', async () => {
  // This used to pin the opposite scenario — a restored pair saved under an
  // old window, then a fresh reading under a larger one, where the size CHANGE
  // was the signal that let a lower `used` through the monotonic hold.
  //
  // A bridged session can no longer produce that: the window is the configured
  // one throughout, whatever sizes cross the wire, so the two readings compare
  // as same-size and the hold applies. The stale-pair problem this guarded
  // against is gone at the source rather than handled downstream.
  //
  // The size-change branch of the hold is still live, but now only where a
  // window can genuinely change under a session: a native harness whose model
  // switches mid-session resolves a different discovered window.
  const h = await setup('openclaw', { contextWindow: 1_000_000 })
  h.client.restoreUsage(h.sessionId, { used: 609_000, size: 200_000 })
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 5_000, size: 1_000_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(
    h.client.listSessions().find((s) => s.id === h.sessionId)?.usage,
    { used: 609_000, size: 1_000_000 },
    'same window on both readings, so the lower one is held exactly as any same-size drop is',
  )
  h.endTurn()
  await settle()
})

test('a same-size lower reading mid-turn is still held (the shipped monotonic behaviour, unchanged)', async () => {
  const h = await setup('openclaw', { contextWindow: 1_000_000 })
  h.client.restoreUsage(h.sessionId, { used: 609_000, size: 200_000 })
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 5_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(
    h.client.listSessions().find((s) => s.id === h.sessionId)?.usage,
    { used: 609_000, size: 1_000_000 },
    'same size, so the lower reading is held exactly as before this fix',
  )
  h.endTurn()
  await settle()
})

// ── the window a reading may be shown against ───────────────────────────
//
// A window is displayed only when it comes from an authority we can stand
// behind — see context-window.ts for the rule and context-window.test.ts for
// it in isolation. These pin it at the two doors into session state, because
// the failure that reopened this was the two doors disagreeing: the live one
// applied a check the restored one had never heard of.

test('a bridged window is shown now, when this reading does not contradict it', async () => {
  // The pre-2026-09-18 contract was the opposite: 185k against a reported 200k
  // is not self-contradicting, yet the reported size was withheld as
  // unverifiable, so every bridged session with no configured window read
  // "window size not reported" forever. The decision was that hiding the
  // window permanently costs more than the residual risk of relaying a
  // briefly-wrong one (see context-window.ts; the module rule is in
  // context-window.test.ts). This pins that the rule reaches session state
  // through the live door: a bridged reading now shows the size it reported.
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 185_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 185_000,
    size: 200_000,
  })
})

test('a bridged window the reading itself contradicts is still withheld through the live door', async () => {
  // The surviving half of the gate the test above used to carry: trusting the
  // reported size does not mean trusting an impossible one. 531k used against a
  // reported 200k is self-contradicting, so displayableContextWindow drops it
  // even with no configured window to fall back on -- the same 265% ratio the
  // original work started from, refused at the source.
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 531_737, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 531_737,
    size: undefined,
  })
})

test('a configured window beats the reported one whether or not the reading disproves it', async () => {
  // Both directions of the same rule: the configured window wins at 185k
  // (where the reported figure is merely wrong) and at 531k (where it is also
  // impossible). Provenance decides, not arithmetic.
  for (const used of [185_000, 531_737]) {
    const h = await setup('openclaw', { contextWindow: 1_000_000 })
    handleUpdate({
      sessionId: h.sessionId,
      update: { sessionUpdate: 'usage_update', used, size: 200_000 },
    } as Parameters<typeof handleUpdate>[0])
    assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
      used,
      size: 1_000_000,
    })
    await h.client.deleteSession(h.sessionId)
  }
})

test('a restored reading gets the same rule as a live one', async () => {
  // The original bug: a session went offline holding history, the first message
  // back restored a persisted {used, size} straight into state, and the restore
  // door bypassed every check the live door applied. Both doors now run the
  // same normalizeUsage, so the sanity gate that fires on the live door
  // (531k used against a reported 200k is impossible) fires here too. A
  // persisted size earns no more trust for having survived a restart, so a
  // restored reading the report contradicts is withheld exactly as a live one
  // is -- the case where "the same rule" still has teeth after the change that
  // made an uncontradicted reported window trusted.
  const h = await setup('openclaw')
  h.client.restoreUsage(h.sessionId, { used: 531_737, size: 200_000 })
  assert.deepEqual(
    h.client.listSessions().find((s) => s.id === h.sessionId)?.usage,
    { used: 531_737, size: undefined },
    'the restore door applies the sanity gate the live door does, rather than bypassing it',
  )
  await h.client.deleteSession(h.sessionId)
})

test('a restored reading keeps a configured window, exactly as a live one does', async () => {
  const h = await setup('openclaw', { contextWindow: 1_000_000 })
  h.client.restoreUsage(h.sessionId, { used: 185_000, size: 200_000 })
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 185_000,
    size: 1_000_000,
  })
  await h.client.deleteSession(h.sessionId)
})

test('a configured window the reading itself disproves is withheld, not rendered past 100%', async () => {
  // Provenance alone would relay this: a configured window is an authority.
  // But an operator can still type a number the session demonstrably exceeds,
  // and 531k against a configured 300k is the same impossible ratio this work
  // began with — merely sourced from us rather than from the bridge.
  const h = await setup('openclaw', { contextWindow: 300_000 })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 531_737, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 531_737,
    size: undefined,
  })
})

test('a session sitting exactly at its configured window still shows the ratio', async () => {
  // `used > known` disproves; `used === known` is a real 100%, not a
  // contradiction, and a session at its cap is exactly when the ring matters.
  const h = await setup('openclaw', { contextWindow: 500_000 })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 500_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 500_000,
    size: 500_000,
  })
})

// ── what rides alongside a usage reading: session cost and rate limits ───
//
// A `usage_update` is not only the context pair. The schema carries an
// optional cumulative session `cost`, and the claude bridge decorates the
// update's `_meta` with the subscription account's rate-limit state
// (`_claude/rateLimit`, one window per event). Both describe scale larger
// than one reading, so they merge instead of replace.

test('a usage_update carrying a cost surfaces it, on the session and in the event', async () => {
  const h = await setup('openclaw', { contextWindow: 200_000 })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 12_000, size: 200_000, cost: { amount: 0.42, currency: 'USD' } },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage, {
    used: 12_000,
    size: 200_000,
    cost: { amount: 0.42, currency: 'USD' },
  })
  const usage = h.events.find((event) => event.kind === 'usage')
  assert.deepEqual(usage && 'cost' in usage ? usage.cost : undefined, { amount: 0.42, currency: 'USD' })
  await h.client.deleteSession(h.sessionId)
})

test('a cost persists across readings that carry none', async () => {
  // A turn-end result prices the session; a mid-turn or rate-limit update
  // does not — the absence is not a retraction of the cost.
  const h = await setup('openclaw', { contextWindow: 200_000 })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 12_000, size: 200_000, cost: { amount: 0.42, currency: 'USD' } },
  } as Parameters<typeof handleUpdate>[0])
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 13_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage?.cost, {
    amount: 0.42,
    currency: 'USD',
  })
  await h.client.deleteSession(h.sessionId)
})

test('a _claude/rateLimit decoration becomes a rate-limit window on the reading', async () => {
  const h = await setup('openclaw', { contextWindow: 200_000 })
  handleUpdate({
    sessionId: h.sessionId,
    update: {
      sessionUpdate: 'usage_update',
      used: 12_000,
      size: 200_000,
      _meta: {
        '_claude/rateLimit': {
          // A fraction on the wire, a percentage on the reading — see
          // normalizeUtilization.
          status: 'allowed',
          rateLimitType: 'five_hour',
          utilization: 0.34,
          resetsAt: 1_760_000_000,
        },
      },
    },
  } as Parameters<typeof handleUpdate>[0])
  const usage = h.client.listSessions().find((s) => s.id === h.sessionId)?.usage
  assert.deepEqual(usage?.rateLimits, [
    { status: 'allowed', window: 'five_hour', utilization: 34, resetsAt: 1_760_000_000_000 },
  ])
  await h.client.deleteSession(h.sessionId)
})

test('rate-limit windows merge by window name, one event per window', async () => {
  const h = await setup('openclaw', { contextWindow: 200_000 })
  for (const rateLimitType of ['five_hour', 'seven_day'] as const) {
    handleUpdate({
      sessionId: h.sessionId,
      update: {
        sessionUpdate: 'usage_update',
        used: 12_000,
        size: 200_000,
        _meta: { '_claude/rateLimit': { status: 'allowed_warning', rateLimitType, utilization: 0.9 } },
      },
    } as Parameters<typeof handleUpdate>[0])
  }
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.usage?.rateLimits, [
    { status: 'allowed_warning', window: 'five_hour', utilization: 90 },
    { status: 'allowed_warning', window: 'seven_day', utilization: 90 },
  ])
  await h.client.deleteSession(h.sessionId)
})

test('a held mid-turn reading keeps the displayed tokens but still merges limit state', async () => {
  // The monotonic hold is about the context pair; a limit window is account
  // state, and holding it would leave the reader blind to a rejection that
  // arrived mid-turn.
  const h = await setup('openclaw', { contextWindow: 200_000 })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 50_000, size: 200_000 },
  } as Parameters<typeof handleUpdate>[0])
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  handleUpdate({
    sessionId: h.sessionId,
    update: {
      sessionUpdate: 'usage_update',
      used: 1_000,
      size: 200_000,
      _meta: { '_claude/rateLimit': { status: 'rejected', rateLimitType: 'seven_day', utilization: 1 } },
    },
  } as Parameters<typeof handleUpdate>[0])
  const usage = h.client.listSessions().find((s) => s.id === h.sessionId)?.usage
  assert.equal(usage?.used, 50_000, 'the lower reading is held, exactly as without the decoration')
  assert.deepEqual(usage?.rateLimits, [{ status: 'rejected', window: 'seven_day', utilization: 100 }])
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('listSessions mirrors the session harness and model', async () => {
  // What per-harness usage accounting keys on: the selection, read back as
  // session metadata rather than re-derived from the spawn.
  const h = await setup('openclaw', { model: 'glm-5.3' })
  const meta = h.client.listSessions().find((s) => s.id === h.sessionId)
  assert.equal(meta?.adapterId, 'openclaw')
  assert.equal(meta?.model, 'glm-5.3')
  await h.client.deleteSession(h.sessionId)
})

// ── what a prompt response carries: turn usage, quota, typed failures ─────
//
// The response's experimental `usage` and `_meta.quota` say what the turn
// spent; `_meta`'s AIR sessionFailure says WHY a turn ended with no answer
// (a quota exhaustion arrives as `end_turn` plus the failure, not as an
// error). All of it is read at settlement and emitted on turn_end, so a host
// folds one event instead of parsing wire metadata.

test('turn_end carries the response usage and the per-model quota breakdown', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurnWith({
    stopReason: 'end_turn',
    usage: { totalTokens: 5_000, inputTokens: 4_000, outputTokens: 1_000, cacheReadTokens: 100_000 },
    _meta: {
      quota: {
        token_count: { totalTokens: 5_000, inputTokens: 4_000, outputTokens: 1_000 },
        model_usage: [
          { model: 'claude-sonnet-5', token_count: { totalTokens: 6_000, inputTokens: 4_500, outputTokens: 1_500 } },
        ],
      },
    },
  })
  await settle()
  const turnEnd = h.events.find((event) => event.kind === 'turn_end')
  assert.ok(turnEnd && turnEnd.kind === 'turn_end')
  assert.deepEqual(turnEnd.usage, {
    totalTokens: 5_000,
    inputTokens: 4_000,
    outputTokens: 1_000,
    cacheReadTokens: 100_000,
  })
  assert.deepEqual(turnEnd.quota, {
    tokenCount: { totalTokens: 5_000, inputTokens: 4_000, outputTokens: 1_000 },
    modelUsage: [
      { model: 'claude-sonnet-5', tokenCount: { totalTokens: 6_000, inputTokens: 4_500, outputTokens: 1_500 } },
    ],
  })
  await h.client.deleteSession(h.sessionId)
})

test('a quota exhaustion arrives as a typed failure on turn_end, not a dead end_turn', async () => {
  // The bridge settles an exhausted turn with stopReason "end_turn" and the
  // structured verdict in `_meta` — read literally, a successful turn that
  // said nothing. The failure is the actual content of the turn.
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurnWith({
    stopReason: 'end_turn',
    _meta: {
      jetbrains: {
        air: {
          // claude-agent-acp 0.79.0's `sessionFailureMeta()` shape: the
          // bridge's kind stays internal, so none rides the wire.
          sessionFailure: {
            id: 'turn-1:error',
            revision: 1,
            category: 'limit',
            severity: 'error',
            title: 'The Claude account has no available quota.',
            actions: [],
          },
        },
      },
    },
  })
  await settle()
  const turnEnd = h.events.find((event) => event.kind === 'turn_end')
  assert.ok(turnEnd && turnEnd.kind === 'turn_end')
  assert.deepEqual(turnEnd.failure, {
    id: 'turn-1:error',
    label: 'quota_exhausted',
    revision: 1,
    title: 'The Claude account has no available quota.',
    category: 'limit',
    severity: 'error',
    actions: [],
  })
  assert.equal(turnEnd.usage, undefined)
  assert.equal(turnEnd.quota, undefined)
  await h.client.deleteSession(h.sessionId)
})

test('a plain turn end carries no usage, quota or failure', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()
  const turnEnd = h.events.find((event) => event.kind === 'turn_end')
  assert.ok(turnEnd && turnEnd.kind === 'turn_end')
  assert.equal(turnEnd.usage, undefined)
  assert.equal(turnEnd.quota, undefined)
  assert.equal(turnEnd.failure, undefined)
  await h.client.deleteSession(h.sessionId)
})

// ── turn_end attribution: adapter, resolved model, per-turn cost ─────────
//
// A consumer accounting for a turn needs what ran and what it cost without a
// second lookup against the live session — which a group-chat thread, created
// with no model mirror, answers as unknown. So the boundary stamps the
// selection's adapter, the RESOLVED model (from the turn's real quota
// breakdown ahead of the selection mirror), and the turn's OWN cost delta.

test('turn_end stamps the adapter and resolves the model from the quota breakdown', async () => {
  // The selection carries no model (the group-chat case); the harness's
  // per-model breakdown names what actually ran, and the heaviest row wins
  // over a lighter subagent model.
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurnWith({
    stopReason: 'end_turn',
    usage: { totalTokens: 5_000 },
    _meta: {
      quota: {
        token_count: { totalTokens: 5_000 },
        model_usage: [
          { model: 'claude-haiku-4-5', token_count: { totalTokens: 800 } },
          { model: 'claude-opus-5', token_count: { totalTokens: 6_000 } },
        ],
      },
    },
  })
  await settle()
  const turnEnd = h.events.find((event) => event.kind === 'turn_end')
  assert.ok(turnEnd && turnEnd.kind === 'turn_end')
  assert.equal(turnEnd.adapterId, 'openclaw')
  assert.equal(turnEnd.model, 'claude-opus-5')
  await h.client.deleteSession(h.sessionId)
})

test('turn_end reports each turn its OWN cost, differenced from the cumulative reading', async () => {
  const h = await setup('openclaw', { contextWindow: 200_000 })
  const turnCosts = () =>
    h.events
      .filter((event): event is Extract<ChatEvent, { kind: 'turn_end' }> => event.kind === 'turn_end')
      .map((event) => event.cost?.amount)

  // First priced turn: the whole cumulative is its own spend. (Amounts are
  // binary-exact halves so the delta below is checked without a float epsilon —
  // the engine differences faithfully, it does not round.)
  await h.client.prompt(h.sessionId, 'one', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 12_000, size: 200_000, cost: { amount: 0.5, currency: 'USD' } },
  } as Parameters<typeof handleUpdate>[0])
  h.endTurn()
  await settle()

  // Second turn: cumulative climbs; the delta is this turn's alone.
  await h.client.prompt(h.sessionId, 'two', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 20_000, size: 200_000, cost: { amount: 2, currency: 'USD' } },
  } as Parameters<typeof handleUpdate>[0])
  h.endTurn()
  await settle()

  assert.deepEqual(turnCosts(), [0.5, 1.5])
  await h.client.deleteSession(h.sessionId)
})

test('a cumulative cost that drops (a reset) is read as the post-reset spend, never a negative turn', async () => {
  const h = await setup('openclaw', { contextWindow: 200_000 })
  await h.client.prompt(h.sessionId, 'one', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 12_000, size: 200_000, cost: { amount: 5, currency: 'USD' } },
  } as Parameters<typeof handleUpdate>[0])
  h.endTurn()
  await settle()

  // A compaction reset the harness's cumulative; the fresh figure is the whole
  // of the turn's spend, not a 5 → 0.3 negative.
  await h.client.prompt(h.sessionId, 'two', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 3_000, size: 200_000, cost: { amount: 0.3, currency: 'USD' } },
  } as Parameters<typeof handleUpdate>[0])
  h.endTurn()
  await settle()

  const last = h.events
    .filter((event): event is Extract<ChatEvent, { kind: 'turn_end' }> => event.kind === 'turn_end')
    .at(-1)
  assert.equal(last?.cost?.amount, 0.3)
  await h.client.deleteSession(h.sessionId)
})

test('a restored cumulative cost counts as already accounted for, so the first turn after a restart is not charged the history', async () => {
  const h = await setup('openclaw', { contextWindow: 200_000 })
  // What the host persisted from the previous process: a session already 4.00
  // into its cumulative, every cent of it attributed to earlier turns.
  h.client.restoreUsage(h.sessionId, { used: 8_000, size: 200_000, cost: { amount: 4, currency: 'USD' } })

  // The harness resumes with its counter intact: the boundary sees only the
  // increment.
  await h.client.prompt(h.sessionId, 'one', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 9_000, size: 200_000, cost: { amount: 4.5, currency: 'USD' } },
  } as Parameters<typeof handleUpdate>[0])
  h.endTurn()
  await settle()

  // A harness that restarted its own counter on resume reads as a reset: the
  // fresh figure is the turn's whole spend.
  await h.client.prompt(h.sessionId, 'two', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'usage_update', used: 3_000, size: 200_000, cost: { amount: 0.25, currency: 'USD' } },
  } as Parameters<typeof handleUpdate>[0])
  h.endTurn()
  await settle()

  assert.deepEqual(
    h.events
      .filter((event): event is Extract<ChatEvent, { kind: 'turn_end' }> => event.kind === 'turn_end')
      .map((event) => event.cost?.amount),
    [0.5, 0.25],
  )
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
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
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
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
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
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } }) // queues: a turn is already active
  await h.client.refreshMcpServers() // deferred: 'first' is still in flight
  h.endTurn() // ends 'first'
  await settle()
  assert.deepEqual(h.resumeCalls, [h.sessionId])
  assert.equal(h.promptCalls.length, 2, 'the queued prompt must still be delivered after the deferred resume runs')
  assert.deepEqual(partsOf(h.promptCalls[1]), ['second'])
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
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } }) // queues: a turn is already active
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['second'])
  await h.client.cancel(h.sessionId) // the mock connection's cancel is a no-op; real settlement is separate
  assert.equal(h.client.hasActiveTurn(h.sessionId), true, 'cancel alone must not touch activeTurns')
  h.endTurn() // stands in for the agent ending its turn in response to the cancel
  await settle()
  assert.equal(h.promptCalls.length, 2)
  assert.deepEqual(partsOf(h.promptCalls[1]), ['second'])
  assert.deepEqual(queueSnapshots(h.events).at(-1), [])
})

// A force is a push: everything still held reaches the agent together, so it
// can read the whole picture before acting. Draining one per turn would have it
// act on each stale message first and only then reach the newest one.
test('a flushing prompt delivers the whole queue and itself as ONE turn, in order, itself last', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'third', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'forced', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  // Still held: the interrupted turn has not settled yet.
  assert.deepEqual(deliveries(h), [['first']])
  // The push-ordering fix's invariant, asserted against the mechanism that
  // replaced it. That fix collapsed the queue into ONE entry before
  // interrupting, so a settle landing inside the cancel could not ship a single
  // stale message on its own. The collapse is gone — a drain now takes the whole
  // leading run — but the PROPERTY was always the point, and it still holds:
  // everything held arrives in one delivery, none of it stale and alone. This
  // is not a leftover assertion; it is the same guarantee under new machinery.
  //
  // So the queue keeps its messages as themselves right up to the drain, which
  // is also what lets each one keep its own author and send time.
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['second', 'third', 'forced'])

  h.endTurn()
  await settle()

  // One delivery carrying all three, in the order sent, the forced one last —
  // and each still individually readable. Asserted as the TAIL of the delivery:
  // the disclaimer that precedes it is pinned once, in its own test below, so a
  // reword does not have to be chased through every test that pushes.
  assert.equal(h.promptCalls.length, 2)
  assert.deepEqual(partsOf(h.promptCalls[1]), ['second', 'third', 'forced'], h.promptCalls[1])
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
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'forced', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()
  // No framing AND no disclaimer when there is only one message — a batch of
  // one is not a batch, so there is nothing to explain.
  assert.deepEqual(deliveries(h), [['first'], ['forced']])
  await h.client.deleteSession(h.sessionId)
})

// The note reaches the agent, ahead of the parts, and is not one of them.
//
// The sentence itself is pinned WORD FOR WORD next to the encoder, which is
// where it lives; repeating it here would be a second copy to keep in step, and
// the first reword would leave one of them lying. What belongs at this level is
// what the engine is responsible for: that an interrupt-adjacent delivery opens
// with the note, that the note precedes the first tag (so the parser drops it
// and the reader never sees it as something somebody typed), and that it is not
// mistaken for a message of its own.
test('a pushed batch opens with the interrupt note, ahead of the parts and not one of them', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'third', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()

  const delivered = h.promptCalls[1]
  assert.equal(delivered.startsWith('Your turn was interrupted'), true, delivered)
  assert.equal(
    delivered.indexOf('<agent-message') > 0,
    true,
    'the note must come before the first tag, or the parser would render it as chat',
  )
  // The note carries three things the rewrite exists for: it does not assert
  // what the interrupt meant, it says how to reconcile messages that disagree,
  // and it says continue rather than start over. Asserted separately from the
  // sentence so dropping one reads as the loss it is, not as a reword.
  assert.equal(delivered.includes('may or may not'), true, 'the note must not assert what the interrupt meant')
  assert.equal(delivered.includes('supersede'), true, 'the note must say how to reconcile disagreeing messages')
  assert.equal(delivered.includes('continue from what you had already done'), true, 'continue, not start over')
  // And it is framing, not content: the parts are exactly the two messages.
  assert.deepEqual(partsOf(delivered), ['second', 'third'])
  await h.client.deleteSession(h.sessionId)
})

// The composer's push button presses with an empty composer: it asks for what is
// already held to go through now and has nothing of its own to add.
test('a push with no text of its own delivers what is held and adds nothing', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'third', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['second', 'third'])

  const { interrupted } = await h.client.prompt(h.sessionId, '', {
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(interrupted, true)
  // Nothing of its own is appended: what goes is the two that were waiting,
  // not three, because an empty message is not a message.
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['second', 'third'])

  h.endTurn()
  await settle()
  assert.equal(h.promptCalls.length, 2)
  assert.deepEqual(
    partsOf(h.promptCalls[1]),
    ['second', 'third'],
    'the two that were waiting, and no empty third part of its own',
  )
  await h.client.deleteSession(h.sessionId)
})

// The Unread heading's deliver button on an IDLE session: nothing to
// interrupt, so the delivery itself is the only evidence the push leaves --
// and it must still open with the queue-jump note, because held messages
// leaving ahead of the cadence is what that note explains, however they left.
test('a push with no text of its own, on an idle session, delivers with the queue-jump note', async () => {
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: WINDOW_MS })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(deliveries(h), [], 'held for the window, nothing sent yet')

  const { interrupted } = await h.client.prompt(h.sessionId, '', {
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(interrupted, false, 'nothing was running to interrupt')
  await settle()
  assert.equal(h.promptCalls.length, 1)
  const delivered = h.promptCalls[0]
  assert.equal(delivered.startsWith('Your turn was interrupted'), true, delivered)
  assert.deepEqual(partsOf(delivered), ['held'])
  await h.client.deleteSession(h.sessionId)
})

test('a push with nothing held and nothing to add starts no turn', async () => {
  // The button pressed against a queue that drained between render and click.
  const h = await setup()
  const { interrupted } = await h.client.prompt(h.sessionId, '', {
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(interrupted, false)
  assert.deepEqual(h.promptCalls, [], 'an empty prompt would start a turn saying nothing')
  await h.client.deleteSession(h.sessionId)
})

test('a push that would deliver nothing does not interrupt the turn it found', async () => {
  // Ending a turn is only justified by having something to hand over instead.
  // With nothing held and nothing to add there is nothing to deliver, so the
  // turn is left alone — the disclaimer's "everything waiting could arrive at
  // once" would be a lie about an empty queue.
  const h = await setup()
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.equal(h.client.hasActiveTurn(h.sessionId), true)

  const { interrupted } = await h.client.prompt(h.sessionId, '   ', {
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(interrupted, false, 'nothing to deliver, so nothing was interrupted')
  assert.equal(h.client.hasActiveTurn(h.sessionId), true, 'the turn must still be running')

  h.endTurn()
  await settle()
  assert.deepEqual(deliveries(h), [['working']], 'and nothing extra was ever delivered')
  await h.client.deleteSession(h.sessionId)
})

test('push ignores front, so the new message is last however the caller asks', async () => {
  // `push` promises "everything held, this one last" in QueueMode, in both tool
  // descriptions and in the node manifest. `front` would invert that, so it is
  // ignored rather than trusted not to be passed.
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'pushed', {
    front: true,
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  // Under a push the new message is appended, never inserted: what matters is
  // that it is LAST — in the queue, and so in the batch the drain builds from
  // it — however the caller asked for it to be placed.
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['held', 'pushed'])

  h.endTurn()
  await settle()
  assert.deepEqual(partsOf(h.promptCalls[1]), ['held', 'pushed'], h.promptCalls[1])
  await h.client.deleteSession(h.sessionId)
})

test('front still works for wait, which is the axis it belongs to', async () => {
  // The guard above is specific to push; it must not quietly disable `front`
  // for the permission flow's corrective guidance, which is what it exists for.
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'ordinary', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'corrective', {
    front: true,
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['corrective', 'ordinary'])
  await h.client.deleteSession(h.sessionId)
})

// ── the push ordering defect, found against a real agent ─────────────────
//
// Against a REAL agent, cancelling ends the running turn, so settleTurn fires
// while prompt() is still suspended on its own `await cancelSession(...)`. The
// queue is untouched at that instant and the push flag is not set yet, so the
// drain that runs sees ordinary state. These two tests describe what a push
// must do regardless of when the settle lands.

test('a push batches everything into one delivery even when the cancel settles the turn immediately', async () => {
  const h = await setup('openclaw', { cancelEndsTurn: true })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'held-one', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'held-two', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['held-one', 'held-two'])

  await h.client.prompt(h.sessionId, 'newest', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  await settle()

  // One delivery carrying all three, not three turns draining one at a time.
  assert.equal(h.promptCalls.length, 2, `expected one batched delivery, got: ${JSON.stringify(h.promptCalls)}`)
  assert.deepEqual(partsOf(h.promptCalls[1]), ['held-one', 'held-two', 'newest'], h.promptCalls[1])
  assert.deepEqual(queueSnapshots(h.events).at(-1), [], 'nothing may be left queued')
  await h.client.deleteSession(h.sessionId)
})

test('a push reports the interrupt it performed even when the turn ends inside the cancel', async () => {
  const h = await setup('openclaw', { cancelEndsTurn: true })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  const { interrupted } = await h.client.prompt(h.sessionId, 'newest', {
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(interrupted, true, 'a turn was running when this call arrived')
  await settle()
  await h.client.deleteSession(h.sessionId)
})

// ── Stop absorbs the interrupt ────────────────────────────────────────────
//
// A reader stopping with something unread has usually written a correction, not
// asked for the work to be abandoned. So Stop cancels AND hands over what is
// held — and reads the queue HERE rather than trusting a caller, because a
// caller's view of it is a render old and a message landing between the paint
// and the click is exactly the case this exists for.

test('stopping with unread messages cancels the turn and delivers them as one batch', async () => {
  const h = await setup('openclaw', { cancelEndsTurn: true })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'unread-one', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'unread-two', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })

  const { delivered } = await h.client.stop(h.sessionId)
  assert.equal(delivered, 2, 'both unread messages were handed over')
  await settle()

  assert.equal(h.promptCalls.length, 2, 'one batched delivery, not one turn per held message')
  assert.deepEqual(partsOf(h.promptCalls[1]), ['unread-one', 'unread-two'], h.promptCalls[1])
  assert.deepEqual(queueSnapshots(h.events).at(-1), [], 'nothing may be left unread')
  await h.client.deleteSession(h.sessionId)
})

test('stopping with nothing unread is an ordinary cancel and delivers nothing', async () => {
  const h = await setup('openclaw', { cancelEndsTurn: true })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })

  const { delivered } = await h.client.stop(h.sessionId)
  assert.equal(delivered, 0)
  await settle()
  assert.deepEqual(deliveries(h), [['running']], 'a stop with nothing to say starts no new turn')
  await h.client.deleteSession(h.sessionId)
})

test('a Stop still stops when there is nothing to deliver, unlike a push', async () => {
  // The one deliberate difference between the two: a push with nothing to
  // deliver interrupts nothing, because ending a turn to say nothing is never
  // what a caller meant. A Stop with nothing to deliver still stops — that IS
  // what the reader meant.
  const h = await setup('openclaw', { cancelEndsTurn: true })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.equal(h.client.hasActiveTurn(h.sessionId), true)

  const pushed = await h.client.prompt(h.sessionId, '  ', {
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(pushed.interrupted, false, 'a push with nothing to deliver leaves the turn alone')
  assert.equal(h.client.hasActiveTurn(h.sessionId), true)

  await h.client.stop(h.sessionId)
  await settle()
  assert.equal(h.client.hasActiveTurn(h.sessionId), false, 'the stop ended it')
  await h.client.deleteSession(h.sessionId)
})

// The interrupt is part of what `push` MEANS, so it lives in prompt() rather
// than at each call site — otherwise every surface has to remember to cancel
// first, which is the same semantics written twice.
test('push interrupts a running turn and says so; wait never interrupts', async () => {
  const h = await setup()
  const idle = await h.client.prompt(h.sessionId, 'first', {
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(idle.interrupted, false, 'nothing was running, so nothing was interrupted')

  const held = await h.client.prompt(h.sessionId, 'waited', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(held.interrupted, false, 'wait never interrupts, however busy the session is')
  assert.equal(h.client.hasActiveTurn(h.sessionId), true)

  const pushed = await h.client.prompt(h.sessionId, 'pushed', {
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(pushed.interrupted, true, 'a turn was running, so this one did interrupt it')

  h.endTurn()
  await settle()
  // Both held messages arrive in the one delivery the interrupt bought.
  assert.equal(h.promptCalls.length, 2)
  assert.deepEqual(partsOf(h.promptCalls[1]), ['waited', 'pushed'])
  await h.client.deleteSession(h.sessionId)
})

test('a flush does not change how later ordinary sends drain', async () => {
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'forced', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()
  assert.equal(h.promptCalls.length, 2)

  // The interrupt is spent: the two that follow arrive as an ordinary drained
  // run, batched because they were waiting together, and with no note — nothing
  // was interrupted to deliver them.
  await h.client.prompt(h.sessionId, 'later-a', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'later-b', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()
  assert.deepEqual(deliveries(h), [['first'], ['second', 'forced'], ['later-a', 'later-b']])
  const last = h.promptCalls.at(-1) ?? ''
  assert.equal(last.startsWith('<agent-message'), true, 'an uninterrupted delivery opens with no note')
  await h.client.deleteSession(h.sessionId)
})

// ── the durable queue (write-behind) ──────────────────────────────────────
//
// The engine serves from memory and writes a copy behind itself. These use a
// fake store rather than a database because the contract being tested is the
// engine's half of it: what it writes, when, and what it does with what it
// reads back. The host's half is tested where the host implements it.

interface RecordedWrite {
  op: 'append' | 'remove' | 'clear'
  key: string
  detail: string
}

type StoreOp = 'append' | 'remove' | 'clear' | 'load'

// A genuinely asynchronous store double. Every call records itself when it
// ARRIVES and applies its effect only when it RESOLVES — a call still in
// flight has not happened yet as far as the rows are concerned. That gap is
// the point: a synchronous double makes every ordering, latency and
// interleaving question unobservable, so a suite over one stays green while a
// concurrently-issued remove loses to its own append against a real store.
// `hold` keeps every call of an op in flight until release() lands what has
// arrived; failNext() makes an op's next call reject.
function fakeStore(options: { hold?: StoreOp[] } = {}) {
  const writes: RecordedWrite[] = []
  const rows = new Map<string, QueuedPrompt[]>()
  const held = new Set<StoreOp>(options.hold ?? [])
  const failing = new Set<StoreOp>()
  let inFlight: { op: StoreOp; land: () => void }[] = []
  function perform<T>(op: StoreOp, apply: () => T): Promise<T> {
    if (failing.delete(op)) {
      return Promise.reject(new Error(`${op} refused by the test`))
    }
    if (held.has(op)) {
      return new Promise((resolve) => inFlight.push({ op, land: () => resolve(apply()) }))
    }
    // Off this tick even when nothing holds it, like any real store.
    return Promise.resolve().then(apply)
  }
  const store: QueueStore = {
    append(key, entry, placement) {
      writes.push({ op: 'append', key, detail: `${placement}:${entry.text}` })
      return perform('append', () => {
        const list = rows.get(key) ?? []
        rows.set(key, placement === 'front' ? [entry, ...list] : [...list, entry])
      })
    },
    remove(key, ids) {
      writes.push({ op: 'remove', key, detail: ids.length === 0 ? '(none)' : String(ids.length) })
      return perform('remove', () => {
        rows.set(
          key,
          (rows.get(key) ?? []).filter((entry) => !ids.includes(entry.id)),
        )
      })
    },
    clear(key) {
      writes.push({ op: 'clear', key, detail: '' })
      return perform('clear', () => {
        rows.delete(key)
      })
    },
    load: (key) => perform('load', () => [...(rows.get(key) ?? [])]),
  }
  return {
    store,
    writes,
    rows,
    release(op: StoreOp) {
      const landing = inFlight.filter((call) => call.op === op)
      inFlight = inFlight.filter((call) => call.op !== op)
      for (const call of landing) {
        call.land()
      }
    },
    failNext(op: StoreOp) {
      failing.add(op)
    },
  }
}

function heldMessage(text: string, sentAt: string): QueuedPrompt {
  return { id: `restored-${text}`, kind: 'message', sender: 'Reader', sentAt, text }
}

test('what is queued is written behind, and dropped once it is delivered', async () => {
  const fake = fakeStore()
  const h = await setup('openclaw', { sessionKey: 'agent:test:durable-1', queueStore: fake.store })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()

  // `first` is written even though it never waited: the copy records what was
  // queued, and every message goes through the queue.
  assert.deepEqual(
    fake.writes.map((write) => `${write.op} ${write.detail}`),
    ['append end:first', 'remove 1', 'append end:second'],
  )
  h.endTurn()
  await settle()
  assert.deepEqual(fake.rows.get('agent:test:durable-1'), [], 'nothing held is left recorded')
  await h.client.deleteSession(h.sessionId)
})

test('the durable copy is told where a message went, not just that it arrived', async () => {
  // `front` is a position, and a restore that put corrective guidance back in
  // the wrong place would deliver it after the thing it was correcting.
  const fake = fakeStore()
  const h = await setup('openclaw', { sessionKey: 'agent:test:durable-2', queueStore: fake.store })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'ordinary', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'corrective', {
    front: true,
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  // The copy is write-BEHIND: it catches up after the send rather than making
  // the send wait for it.
  await settle()
  assert.deepEqual(
    fake.rows.get('agent:test:durable-2')?.map((entry) => entry.text),
    ['corrective', 'ordinary'],
    'the recorded order is the queue order',
  )
  await h.client.deleteSession(h.sessionId)
})

test('a message the reader takes back does not come back at the next restart', async () => {
  const fake = fakeStore()
  const h = await setup('openclaw', { sessionKey: 'agent:test:durable-3', queueStore: fake.store })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'regretted', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  const queued = h.events.filter((event) => event.kind === 'queue').at(-1)
  assert.ok(queued && queued.kind === 'queue')
  h.client.removeQueued(h.sessionId, queued.items[0].id)
  await settle()
  assert.deepEqual(fake.rows.get('agent:test:durable-3'), [])
  await h.client.deleteSession(h.sessionId)
})

test('dropping a live session keeps what it was holding', async () => {
  // Dropping the session record is also how a host stops an agent's process
  // while keeping the conversation — the next open reattaches to the same
  // session. Clearing here would discard a queue that is about to be restored
  // into it, which is exactly the loss the durable copy exists to prevent.
  // Retiring a key for good is the host's own call, not this one.
  const fake = fakeStore()
  const h = await setup('openclaw', { sessionKey: 'agent:test:durable-4', queueStore: fake.store })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.deleteSession(h.sessionId)
  await settle()
  assert.deepEqual(
    fake.rows.get('agent:test:durable-4')?.map((entry) => entry.text),
    ['held'],
    'what was still waiting is still recorded',
  )
  assert.equal(
    fake.writes.some((write) => write.op === 'clear'),
    false,
    'the engine must not decide that a deletion was final',
  )
})

test('a session with no key writes nothing, because nothing could address it', async () => {
  // A restart mints a new session id, so rows keyed by one name nothing. They
  // would never be read and never be deleted.
  const fake = fakeStore()
  const h = await setup('openclaw', { queueStore: fake.store })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.deepEqual(fake.writes, [])
  await h.client.deleteSession(h.sessionId)
})

test('a run that never reached the harness is still there to restore', async () => {
  // The durable copy is what makes a message survive a process that dies, so
  // it has to outlive every step that could still fail to hand the message
  // over. Forgotten before the hand-over, a harness that cannot be reached
  // loses the message outright: nothing holds it any more, in memory or on
  // disk, and nobody is told it was the delivery that failed.
  const fake = fakeStore()
  const h = await setup('openclaw', { sessionKey: 'agent:test:handover-1', queueStore: fake.store })
  const entry = acpStore().connections.get(h.connectionKey) as { initialized: Promise<unknown> }
  const unreachable = Promise.reject(new Error('harness unreachable'))
  // Attached before it is ever awaited, so the rejection this test installs on
  // purpose is not also an unhandled one.
  unreachable.catch(() => {})
  entry.initialized = unreachable

  await h.client.prompt(h.sessionId, 'never-arrived', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()

  assert.deepEqual(
    fake.rows.get('agent:test:handover-1')?.map((queued) => queued.text),
    ['never-arrived'],
    'a message that never reached the agent must still be waiting for the next open',
  )
  assert.equal(
    h.events.some((event) => event.kind === 'error'),
    true,
    'and the failure is reported rather than swallowed',
  )
})

test('a remove cannot overtake the append it was issued after', async () => {
  // The store's append is still in flight when the message passes straight
  // through and is delivered. Handed over concurrently, the remove runs
  // against a table its append has not reached: the delete erases nothing,
  // the insert then lands, and the leftover row replays an already-delivered
  // message at the next open. So the engine must not hand the store the
  // remove until the append it follows has settled.
  const fake = fakeStore({ hold: ['append'] })
  const h = await setup('openclaw', { sessionKey: 'agent:test:ordered-1', queueStore: fake.store })
  await h.client.prompt(h.sessionId, 'straight-through', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  await settle()
  assert.deepEqual(
    fake.writes.map((write) => write.op),
    ['append'],
    'the remove waits for the append it follows',
  )
  fake.release('append')
  await settle()
  assert.deepEqual(
    fake.writes.map((write) => write.op),
    ['append', 'remove'],
  )
  assert.deepEqual(fake.rows.get('agent:test:ordered-1'), [], 'nothing is left for the next open to replay')
  await h.client.deleteSession(h.sessionId)
})

test('reopening a key does not restore a message whose remove is still in flight', async () => {
  // A session can be stopped and reopened without a restart, and the remove
  // for its last delivery can still be on its way to the store when the
  // reopen reads the queue back. Reading past it would restore — and then
  // redeliver — a message the agent already has.
  const fake = fakeStore({ hold: ['remove'] })
  const h = await setup('openclaw', { sessionKey: 'agent:test:reopen-1', queueStore: fake.store })
  await h.client.prompt(h.sessionId, 'delivered-once', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()
  assert.deepEqual(deliveries(h), [['delivered-once']])
  // The host stops the process; the key and whatever is durable under it stay.
  await h.client.deleteSession(h.sessionId)
  const reopening = h.client.createSession(h.selection)
  await settle()
  fake.release('remove')
  const meta = await reopening
  await settle()
  assert.deepEqual(deliveries(h), [['delivered-once']], 'delivered once means once')
  await h.client.deleteSession(meta.id)
})

test('a failed write does not wedge the writes behind it', async () => {
  // Ordered must not mean fragile: the chain steps over a write that failed,
  // so one bad moment costs that one entry's durability rather than every
  // write after it.
  const fake = fakeStore()
  fake.failNext('append')
  const h = await setup('openclaw', { sessionKey: 'agent:test:ordered-2', queueStore: fake.store })
  await h.client.prompt(h.sessionId, 'lost-to-the-copy', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  await h.client.prompt(h.sessionId, 'still-recorded', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.deepEqual(
    fake.writes.map((write) => `${write.op} ${write.detail}`),
    ['append end:lost-to-the-copy', 'remove 1', 'append end:still-recorded'],
  )
  assert.deepEqual(
    fake.rows.get('agent:test:ordered-2')?.map((entry) => entry.text),
    ['still-recorded'],
  )
  await h.client.deleteSession(h.sessionId)
})

test('a queue left by a previous process comes back when the session reopens', async () => {
  const fake = fakeStore()
  // Sent long enough ago to be due immediately under any window — the restart
  // must not restart the wait.
  fake.rows.set('agent:test:restore-1', [
    heldMessage('while-you-were-out', new Date(Date.now() - 60 * 60_000).toISOString()),
  ])
  const h = await setup('openclaw', { sessionKey: 'agent:test:restore-1', queueStore: fake.store })
  await settle()
  assert.deepEqual(deliveries(h), [['while-you-were-out']], 'restored and delivered, not silently dropped')
  await h.client.deleteSession(h.sessionId)
})

test('a restart does not deliver what the cadence was holding back', async () => {
  // The cadence is restored BEFORE the queue is evaluated. Without that
  // ordering an hourly session would hand over everything it had been holding
  // the moment it reopened, making the restart itself the interruption the
  // setting exists to prevent — and nothing later could put that back.
  const fake = fakeStore()
  fake.rows.set('agent:test:restore-2', [heldMessage('patient', new Date().toISOString())])
  const h = await setup('openclaw', {
    sessionKey: 'agent:test:restore-2',
    queueStore: fake.store,
    loadPresence: () => ({ kind: 'custom', intervalMs: 60 * 60_000 }),
  })
  await settle()
  assert.deepEqual(deliveries(h), [], 'still waiting, as it was before the restart')
  // And it is visible as unread meanwhile, rather than waiting invisibly.
  assert.deepEqual(queueSnapshots(h.events), [['patient']])
  await h.client.deleteSession(h.sessionId)
})

test('a restored wait continues from the original send time rather than starting again', async () => {
  // The point of stamping the send time at enqueue. A message that had already
  // outlasted its window before the restart is due immediately after it, not a
  // whole window later — the restart must not cost it its wait.
  const fake = fakeStore()
  const longAgo = new Date(Date.now() - 90_000).toISOString()
  fake.rows.set('agent:test:restore-3', [heldMessage('patient', longAgo)])
  const h = await setup('openclaw', {
    sessionKey: 'agent:test:restore-3',
    queueStore: fake.store,
    loadPresence: () => ({ kind: 'custom', intervalMs: 60_000 }),
  })
  await settle()
  assert.deepEqual(deliveries(h), [['patient']], 'its minute had already passed while the process was down')
  await h.client.deleteSession(h.sessionId)
})

test('a store that throws costs durability, never a message', async () => {
  // Write-behind: the copy is a side-channel. A broken store leaves the host
  // where every host without one already is, and must not fail a send.
  const broken: QueueStore = {
    append() {
      throw new Error('disk on fire')
    },
    remove() {
      throw new Error('disk on fire')
    },
    clear() {
      throw new Error('disk on fire')
    },
    load() {
      throw new Error('disk on fire')
    },
  }
  const h = await setup('openclaw', { sessionKey: 'agent:test:broken', queueStore: broken })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()
  assert.deepEqual(deliveries(h), [['first'], ['second']], 'every message still arrived')
  await h.client.deleteSession(h.sessionId)
})

// ── Presence: how often the agent reads ───────────────────────────────────
//
// `queue` says how a message relates to what is held; Presence says when what
// is held is handed over. These use a `custom` cadence of a few milliseconds so
// the real timer runs — a fake clock would prove the arithmetic (which
// presence.test.ts already does) and not the thing that actually failed to
// happen before this existed: nobody asking again.

const WINDOW_MS = 60
// Comfortably past a WINDOW_MS wait, without making the suite slow.
const afterWindow = () => new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 40))

test('a message to an IDLE session waits for the window, then arrives on its own', async () => {
  // The case with no turn boundary coming. Nothing else would ever ask again,
  // so before the timer existed an hourly agent simply never received this.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: WINDOW_MS })
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })

  assert.deepEqual(deliveries(h), [], 'nothing may reach the agent before its reading window')
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['hello'], 'and it shows as waiting meanwhile')

  await afterWindow()
  assert.deepEqual(deliveries(h), [['hello']])
  // Announced as waiting, then cleared when the window let it go — the whole
  // sequence, so an extra state appearing between them is a failure and not
  // something a tail check would absorb.
  assert.deepEqual(queueSnapshots(h.events), [['hello'], []])
  await h.client.deleteSession(h.sessionId)
})

test('everything accumulated in the window arrives as ONE delivery', async () => {
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: WINDOW_MS })
  await h.client.prompt(h.sessionId, 'one', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'two', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'three', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(deliveries(h), [])

  await afterWindow()
  assert.deepEqual(deliveries(h), [['one', 'two', 'three']], 'one turn, not three')
  // No interrupt happened, so nothing is explained: the tags are the framing.
  assert.equal(h.promptCalls[0].startsWith('<agent-message'), true, h.promptCalls[0])
  await h.client.deleteSession(h.sessionId)
})

test('a later message does not extend the wait the first one started', async () => {
  // The window is measured from the OLDEST. If each arrival reset it, a steady
  // trickle would hold the queue shut forever — which is the failure the
  // oldest-message rule exists to prevent.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: WINDOW_MS })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await new Promise((resolve) => setTimeout(resolve, WINDOW_MS / 2))
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })

  await new Promise((resolve) => setTimeout(resolve, WINDOW_MS / 2 + 40))
  assert.deepEqual(deliveries(h), [['first', 'second']], 'due on the first message its own window')
  await h.client.deleteSession(h.sessionId)
})

test('a push ignores the window, even with nothing running', async () => {
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: 60_000 })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(deliveries(h), [], 'waiting, as asked')

  await h.client.prompt(h.sessionId, 'urgent', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  // Both, together, now — a caller asking for attention is not waiting for a
  // reading window, and what was already held goes with it.
  assert.deepEqual(deliveries(h), [['held', 'urgent']])
  await h.client.deleteSession(h.sessionId)
})

test('the bypass a push spends does not disable the cadence behind it', async () => {
  // One-shot. A cadence that stayed bypassed after one urgent message would be
  // a setting that quietly switched itself off.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: 60_000 })
  await h.client.prompt(h.sessionId, 'urgent', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.deepEqual(deliveries(h), [['urgent']])
  h.endTurn()
  await settle()

  await h.client.prompt(h.sessionId, 'ordinary', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.deepEqual(deliveries(h), [['urgent']], 'the next ordinary message waits again')
  await h.client.deleteSession(h.sessionId)
})

test('Stop with something unread ignores the window too', async () => {
  const h = await setup('openclaw', { cancelEndsTurn: true })
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: 60_000 })
  await h.client.prompt(h.sessionId, 'running', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  await h.client.prompt(h.sessionId, 'unread', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })

  const { delivered } = await h.client.stop(h.sessionId)
  assert.equal(delivered, 1)
  await settle()
  assert.deepEqual(deliveries(h).at(-1), ['unread'], 'a person pressing Stop is asking to be read now')
  await h.client.deleteSession(h.sessionId)
})

test('corrective guidance sent to the front is not held by the window', async () => {
  // The permission-rejection path. The turn this belongs to has already been
  // cancelled, so a cadence holding it leaves the agent stopped and the
  // reader's answer undelivered for as long as the window lasts — a position
  // at the head of a queue nothing reaches in time is not a position at all.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: 60_000 })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(deliveries(h), [], 'waiting, as asked')

  await h.client.prompt(h.sessionId, 'do it this way instead', {
    front: true,
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  await settle()
  assert.deepEqual(deliveries(h), [['do it this way instead', 'held']], 'ahead of what was held, and now')
  await h.client.deleteSession(h.sessionId)
})

test('a system entry placed at the front leaves no bypass behind it', async () => {
  // The standing-context restore front-inserts a system entry, and system
  // entries are never gated anyway — so a bypass granted there would buy
  // nothing and then sit unspent until an ordinary message consumed it and
  // skipped a window nobody asked to skip.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: 60_000 })
  await h.client.prompt(h.sessionId, '<restore>', { front: true, queue: 'wait', origin: { kind: 'system' } })
  await settle()
  assert.deepEqual(h.promptCalls, ['<restore>'], 'delivered, as a system entry always is')
  h.endTurn()
  await settle()

  await h.client.prompt(h.sessionId, 'ordinary', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.deepEqual(h.promptCalls, ['<restore>'], 'and the next ordinary message still waits its own window')
  await h.client.deleteSession(h.sessionId)
})

test('a command is not gated by the cadence', async () => {
  // Presence gates conversation, not plumbing: compaction requested now must
  // not wait an hour because the agent reads hourly.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: 60_000 })
  await h.client.prompt(h.sessionId, '/compact', { queue: 'wait', origin: { kind: 'system' } })
  await settle()
  assert.deepEqual(h.promptCalls, ['/compact'], 'delivered as itself, and delivered now')
  await h.client.deleteSession(h.sessionId)
})

test('a command queued BEHIND held messages is not gated by their window either', async () => {
  // "Never gated" has to mean never, including from behind. Queued after a run
  // the window is holding, a command would inherit their wait — and whatever
  // waits on its turn reports a failure the cadence caused, on a session where
  // nothing is wrong.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: WINDOW_MS })
  await h.client.prompt(h.sessionId, 'one', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'two', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, '/compact', { queue: 'wait', origin: { kind: 'system' } })
  await settle()
  assert.deepEqual(h.promptCalls, ['/compact'], 'it jumps them, alone, and now')
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['one', 'two'], 'and they are still shown as waiting')

  // Its window closes while the command's own turn is still running. Nothing
  // may go over a live turn — that is what the queue is for — so the release
  // waits for the settlement rather than firing on the timer.
  await afterWindow()
  assert.deepEqual(h.promptCalls, ['/compact'], 'not delivered over the turn the command started')

  h.endTurn()
  await settle()
  assert.deepEqual(deliveries(h).at(-1), ['one', 'two'], 'released together, in the order they were sent')
  await h.client.deleteSession(h.sessionId)
})

test('a command does not drag the messages behind it out of the window', async () => {
  // It delivers first and alone; what was queued behind it still waits its own
  // window, in order.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: WINDOW_MS })
  await h.client.prompt(h.sessionId, '/compact', { queue: 'wait', origin: { kind: 'system' } })
  await h.client.prompt(h.sessionId, 'after', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.deepEqual(h.promptCalls, ['/compact'], 'the command went; the message did not')

  h.endTurn()
  await afterWindow()
  assert.deepEqual(partsOf(h.promptCalls[1]), ['after'])
  await h.client.deleteSession(h.sessionId)
})

test('switching to realtime releases what is already waiting', async () => {
  // Applied to the queue as it stands, not only to what arrives next: a reader
  // who can SEE a message sitting there and switches to realtime is asking for
  // that message, and telling them to send another to shake it loose would be
  // absurd.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: 60_000 })
  await h.client.prompt(h.sessionId, 'waiting', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(deliveries(h), [])

  h.client.setPresence(h.sessionId, { kind: 'realtime' })
  await settle()
  assert.deepEqual(deliveries(h), [['waiting']])
  await h.client.deleteSession(h.sessionId)
})

// ── High Attention: the cadence decides, the sender does not opt in ────────

test('under High Attention an ordinary send to an idle session goes now, unannotated', async () => {
  // Immediacy with nothing to interrupt: the note explains a stop, and nothing
  // stopped. `wait` was marked as wait — the cadence overrules it, which is the
  // whole distinction from a push the sender chose.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'high-attention' })
  await h.client.prompt(h.sessionId, 'urgent', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.equal(h.promptCalls[0]?.startsWith('<agent-message'), true, h.promptCalls[0])
  await h.client.deleteSession(h.sessionId)
})

test('under High Attention a send marked wait still interrupts, with the compact note', async () => {
  // The cadence decides, not the sender: `wait` under High Attention is a push,
  // and the delivery opens with the per-interrupt line — not the queue-jump
  // note, which is worded for a one-off ask rather than this cadence's ordinary
  // way of delivering. ONE message, because "per interrupt" must hold at the
  // size where a batch framing was once thought unnecessary.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'high-attention' })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  const { interrupted } = await h.client.prompt(h.sessionId, 'urgent', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(interrupted, true, 'the cadence stops the turn even though the sender said wait')
  h.endTurn()
  await settle()

  const delivered = h.promptCalls[1]
  assert.equal(
    delivered.startsWith('Your turn was interrupted to deliver the incoming messages below.'),
    true,
    delivered,
  )
  assert.equal(delivered.includes('may or may not'), false, 'the queue-jump note must not carry over')
  assert.deepEqual(partsOf(delivered), ['urgent'])
  await h.client.deleteSession(h.sessionId)
})

test('an explicit push under High Attention opens with the compact note too', async () => {
  // The note follows the cadence, not the flag: under this cadence every stop
  // is the cadence's doing, whichever word the sender used. Asserted because it
  // is a choice — the flag is visible at the same spot, and reaching for it
  // would give the same sender two different explanations for one behaviour.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'high-attention' })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  await h.client.prompt(h.sessionId, 'urgent', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()
  assert.equal(
    h.promptCalls[1].startsWith('Your turn was interrupted to deliver the incoming messages below.'),
    true,
    h.promptCalls[1],
  )
  await h.client.deleteSession(h.sessionId)
})

test('High Attention ignores `front`: everything held, the new message last', async () => {
  // It runs every message as a push, and `front` under a push would invert the
  // "this message LAST" promise the mode makes on three documented surfaces.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'high-attention' })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'urgent', {
    front: true,
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  h.endTurn()
  await settle()
  assert.deepEqual(partsOf(h.promptCalls[1]), ['held', 'urgent'])
  await h.client.deleteSession(h.sessionId)
})

test('switching to High Attention releases what is already waiting, without a note', async () => {
  // Like realtime, the window is over the moment the cadence is set. But the
  // release interrupted nothing — there was no turn — so unlike a High
  // Attention send it arrives unannotated: the note is for stops, and this is
  // a drain.
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: 60_000 })
  await h.client.prompt(h.sessionId, 'waiting', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(deliveries(h), [])

  h.client.setPresence(h.sessionId, { kind: 'high-attention' })
  await settle()
  assert.deepEqual(deliveries(h), [['waiting']])
  await h.client.deleteSession(h.sessionId)
})

test('the cadence is published as a snapshot, so a reconnecting client can read it', async () => {
  const h = await setup()
  h.client.setPresence(h.sessionId, { kind: 'hourly' })
  const presence = h.events.filter((event) => event.kind === 'presence').at(-1)
  assert.deepEqual(presence, { kind: 'presence', presence: { kind: 'hourly' } })
  assert.deepEqual(h.client.listSessions().find((s) => s.id === h.sessionId)?.presence, { kind: 'hourly' })
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
  await h.client.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.deepEqual(calls.map(partsOf), [['hello']])
  assert.deepEqual(h.promptCalls, [`[stamped] ${calls[0]}`])
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
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } }) // delivers immediately: session was idle
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } }) // queues: a turn is already active
  assert.deepEqual(calls.map(partsOf), [['first']], 'the still-queued message must not be transformed yet')

  h.endTurn()
  await settle()
  assert.deepEqual(calls.map(partsOf), [['first'], ['second']])
  assert.equal(h.promptCalls.length, 2)
  assert.deepEqual(h.promptCalls, [`[stamped] ${calls[0]}`, `[stamped] ${calls[1]}`])
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
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'forced', { queue: 'push', origin: { kind: 'message', sender: 'Reader' } })
  assert.deepEqual(calls.map(partsOf), [['first']], 'nothing held is transformed before the flush actually delivers')

  h.endTurn()
  await settle()
  assert.equal(calls.length, 2, 'one call for the idle first delivery, one for the whole joined flush')
  // What this test is about is that the transform saw the JOINED delivery once,
  // not each message — so it asserts the shape of what it saw, not the
  // disclaimer's wording, which is pinned in its own test.
  assert.deepEqual(partsOf(calls[1]), ['second', 'forced'], calls[1])
  assert.equal(h.promptCalls[1], `[stamped] ${calls[1]}`)
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
  // Configured, so the usage snapshot carries a window at all — this is about
  // snapshot delivery across a window cut, not about which windows are shown.
  const h = await setup('openclaw', { contextWindow: 1000 })
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

// -- reading a turn back, for editing --------------------------------------

test('userTurnAt names a turn by event index, and reports the ordinal that rewinds to it', async () => {
  // What an edit rebuilds from. It has to be the DELIVERED text -- tags and all
  // -- because that is where each part's author and send time live, and an edit
  // is not entitled to restate either.
  //
  // Event index, not turn ordinal: a chat opens on a bounded tail of its
  // history, so "the second user turn" means different turns to a client and to
  // this. The ordinal comes back with the text so the rewind and the read can
  // never be computed from different reads.
  const h = await setup()
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Alice' } })
  await settle()
  h.endTurn()
  await settle()
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Bob' } })
  await settle()

  const userIndices = sessionEvents(h.sessionId).flatMap((event, index) => (event.kind === 'user' ? [index] : []))
  assert.equal(userIndices.length, 2)

  const first = h.client.userTurnAt(h.sessionId, userIndices[0])
  assert.equal(first?.text, h.promptCalls[0], 'turn 0, as the agent received it')
  assert.equal(first?.turnIndex, 0)
  assert.equal(first?.text.startsWith('<agent-message'), true, 'the tags are the point, not the reader-facing text')

  const second = h.client.userTurnAt(h.sessionId, userIndices[1])
  assert.deepEqual(partsOf(second?.text ?? ''), ['second'])
  assert.equal(second?.turnIndex, 1, 'the ordinal counts user turns, not events')
  assert.notEqual(userIndices[1], 1, 'and the two numbering schemes really do differ here')

  // Anything that is not a user turn at that exact index is null rather than
  // the nearest one: a clamp would commit an edit against a different message
  // than the one it was aimed at.
  assert.equal(h.client.userTurnAt(h.sessionId, userIndices[1] + 1), null, 'an assistant event is not a turn')
  assert.equal(h.client.userTurnAt(h.sessionId, 9999), null)
  assert.equal(h.client.userTurnAt(h.sessionId, -1), null)
  assert.equal(h.client.userTurnAt('no-such-session', userIndices[0]), null)
  await h.client.deleteSession(h.sessionId)
})


// ── session/fork over ACP ───────────────────────────────────────────────────
//
// An external agent that advertised `session/fork` forks its own transcript;
// the engine adopts the agent-minted id and rewinds its own log to the same
// turn boundary. The cutoff travels in the agent's fork-point dialect, named
// by the message ids the agent itself stamped on its chunks — so the history
// below is built with chunk updates that carry one.

// Two turns, each holding one agent message with its own id: the minimum a
// cutoff anchor and a dropped turn can be told apart in.
async function twoTurnHistory(h: Awaited<ReturnType<typeof setup>>): Promise<void> {
  const push = (update: Record<string, unknown>) =>
    handleUpdate({ sessionId: h.sessionId, update } as Parameters<typeof handleUpdate>[0])
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  push({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first reply' }, messageId: 'msg_first' })
  h.endTurn()
  await settle()
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  push({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'second reply' },
    messageId: 'msg_second',
  })
  h.endTurn()
  await settle()
}

test('createSession reports canFork only when the agent advertised session/fork', async () => {
  const plain = await setup()
  const plainMeta = (acpStore().sessions.get(plain.sessionId) as { meta: { canFork: boolean } }).meta
  assert.equal(plainMeta.canFork, false, 'no advertisement, no fork')
  await plain.client.deleteSession(plain.sessionId)

  const forking = await setup('openclaw', { forkSupported: true })
  const forkMeta = (acpStore().sessions.get(forking.sessionId) as { meta: { canFork: boolean } }).meta
  assert.equal(forkMeta.canFork, true, 'the agent advertisement is what canFork reports')
  await forking.client.deleteSession(forking.sessionId)
})

test('a windowed subscribe says how many of its events are snapshots, so the rest can be numbered', async () => {
  // The replay opens with live-state events the window cut off above — they
  // are real state and belong there, but they hold no POSITION in the log. A
  // reader numbering from `fromIndex` therefore puts every logged event that
  // many slots too high, and nothing about the events themselves says so: a
  // prefixed `queue` and a logged one are the same object.
  //
  // What that costs shows up nowhere until something addresses an event by its
  // position — an edit, a fork — and reaches a different one, or nothing at
  // all, which is what a reader is told.
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  h.endTurn()
  await settle()
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()

  const log = sessionEvents(h.sessionId)
  const from = log.findIndex((event) => event.kind === 'user' && event.text.includes('second'))
  assert.ok(from > 0, 'precondition: the window starts partway into the log')

  const replayed: ChatEvent[] = []
  let snapshotPrefix = -1
  const unsubscribe = h.client.subscribe(h.sessionId, (event) => replayed.push(event), {
    fromIndex: from,
    onReplay: (info) => {
      snapshotPrefix = info.snapshotPrefix
    },
  })
  unsubscribe()

  assert.ok(snapshotPrefix >= 0, 'the count is reported')
  assert.ok(snapshotPrefix > 0, 'precondition: this window really is missing state that had to be prepended')
  assert.equal(
    replayed.length - snapshotPrefix,
    log.length - from,
    'everything after the prefix is the window itself, event for event',
  )
  // The one that matters: the first LOGGED event of the replay is the one the
  // server answers for at `from`, so a reader numbering from `from` must start
  // counting at this position and not at zero.
  assert.deepEqual(replayed[snapshotPrefix], log[from], 'and it starts exactly where the window does')
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('forkSession refuses a session whose agent never advertised session/fork', async () => {
  const h = await setup()
  await assert.rejects(h.client.forkSession(h.sessionId, 0), (error: Error) => {
    assert.match(error.message, /Forking is only supported/)
    return true
  })
  assert.deepEqual(h.forkCalls, [], 'the refusal happens before anything reaches the agent')
  await h.client.deleteSession(h.sessionId)
})

test('forkSession waits for the handshake rather than calling an unconnected agent unforkable', async () => {
  // `forkSupported` is written BY the initialize handshake, so it says nothing
  // until that handshake has finished. A session outlives its process — the
  // idle reaper stops a quiet agent, a harness exits on its own — so "the
  // capability is not there yet" and "this agent cannot fork" are different
  // facts that look identical to a read taken too early.
  //
  // Modelled as an entry whose handshake is still in flight, because that is
  // the shape the connection has while it is being re-established: present,
  // and not yet knowing what it can do.
  const h = await setup('openclaw')
  const entry = acpStore().connections.get(h.connectionKey) as {
    forkSupported: boolean
    initialized: Promise<unknown>
  }
  assert.equal(entry.forkSupported, false, 'precondition: nothing known about forking yet')
  entry.initialized = new Promise<void>((resolve) => {
    setTimeout(() => {
      entry.forkSupported = true
      resolve()
    }, 10)
  })

  const meta = await h.client.forkSession(h.sessionId, 0)
  assert.ok(meta, 'the fork is served once the agent has said what it can do')
  assert.equal(h.forkCalls.length, 1, 'and it reached the agent')
  await h.client.deleteSession(h.sessionId)
})

test('forkSession over ACP forks the agent session, rewinds the log, and adopts the forked id', async () => {
  const h = await setup('openclaw', { forkSupported: true })
  await twoTurnHistory(h)
  const source = sessionEvents(h.sessionId)
  const userIndices = source.flatMap((event, index) => (event.kind === 'user' ? [index] : []))
  assert.equal(userIndices.length, 2, 'precondition: two turns, to fork between them')

  const meta = await h.client.forkSession(h.sessionId, 1)
  assert.ok(meta)
  assert.equal(meta.id, `forked-session-${counter}`, 'the caller is handed the agent-minted fork id')
  assert.equal(meta.canFork, true)

  // The cutoff travels as the agent's own fork-point dialect, anchored on the
  // last agent message BEFORE the dropped turn: the agent keeps its transcript
  // up to the first turn's reply, and the second turn and its reply are gone.
  // The anchor is named by id and by content, so a harness whose ids moved
  // can still find it (see the fingerprint tests below).
  assert.deepEqual(h.forkCalls, [
    {
      sessionId: h.sessionId,
      cwd: h.selection.cwd,
      mcpServers: [],
      _meta: {
        jetbrains: {
          air: {
            fork: {
              version: 1,
              messageId: 'msg_first',
              // sha256("first reply")
              messageFingerprint: 'sha256:9b3ae2aded0bac2ca5da884965ca69f5951e25b12d550d9e59a61aeca9ffc8c6',
              messageOccurrence: 1,
            },
          },
        },
      },
    },
  ])

  // The fork's log is the source's, cut at the same boundary the agent trims
  // its own transcript — the rewound replay the reader sees matches the model
  // history the fork actually holds.
  assert.deepEqual(kinds(sessionEvents(meta.id)), kinds(source.slice(0, userIndices[1])))

  // And the fork speaks through the same connection: it is the same harness,
  // reached by the same spawn config as the session it was branched from.
  await h.client.prompt(meta.id, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  // Deliveries are read back through the real parser: the stored call is the
  // tagged delivery, not the bare words.
  assert.deepEqual(deliveries(h), [['first'], ['second'], ['hello']])
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
  await h.client.deleteSession(meta.id)
})

test('a cutoff with no agent message to anchor on forks without a fork point', async () => {
  const h = await setup('openclaw', { forkSupported: true })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.endTurn()
  await settle()

  const meta = await h.client.forkSession(h.sessionId, 0)
  assert.ok(meta)
  // Turn 0 has nothing before it to anchor a fork point on, and session/fork
  // has no "fork empty" spelling: no cutoff is sent, so the agent copies the
  // whole transcript — while this session's own log still rewinds, which is
  // what the reader sees.
  assert.equal((h.forkCalls[0] as { _meta?: unknown })._meta, undefined)
  assert.deepEqual(kinds(sessionEvents(meta.id)), [])
  await h.client.deleteSession(h.sessionId)
  await h.client.deleteSession(meta.id)
})

test('a fork into a named key adopts it for the fork alone', async () => {
  // The new-thread flow: the host mints the address of the conversation the
  // fork becomes, and events recorded under a key must answer to the FORK —
  // not to the session it was branched from, and not to nothing.
  const h = await setup('openclaw', { forkSupported: true, sessionKey: 'group-chat:source' })
  await twoTurnHistory(h)

  const meta = await h.client.forkSession(h.sessionId, 1, { sessionKey: 'group-chat:forked' })
  assert.ok(meta)
  assert.equal(meta.sessionKey, 'group-chat:forked')
  const forked = acpStore().sessions.get(meta.id) as { selection: { sessionKey?: string } }
  assert.equal(forked.selection.sessionKey, 'group-chat:forked')
  // The source keeps its own key: both sessions answer to exactly one address.
  const source = acpStore().sessions.get(h.sessionId) as { meta: { sessionKey?: string }; selection: { sessionKey?: string } }
  assert.equal(source.meta.sessionKey, 'group-chat:source')
  assert.equal(source.selection.sessionKey, 'group-chat:source')

  // And the key-based read finds the fork, not the source: listSessions is
  // what the host's recorder and presence reads answer from.
  assert.ok(h.client.listSessions().some((s) => s.id === meta.id && s.sessionKey === 'group-chat:forked'))
  // The full log read: exactly the trimmed copy a host seeding a durable
  // transcript under the new key would record — first turn, its reply, the
  // turn boundary; nothing from the dropped second turn.
  const seeded = h.client.getSessionEvents(meta.id)
  assert.ok(seeded, 'a live fork has a log to seed a durable transcript from')
  assert.deepEqual(kinds(seeded), kinds(sessionEvents(meta.id)))
  await h.client.deleteSession(h.sessionId)
  await h.client.deleteSession(meta.id)
})

// ── shouldHoldDelivery / resumeDelivery ─────────────────────────────────────
//
// The host's delivery gate: while it returns true nothing is drained to the
// agent — idle sends, settle drains, system entries, restores — and a `push`
// degrades to an ordinary enqueue instead of cancelling the running turn.
// resumeDelivery() is the host's wake call.

test('held idle sends stay queued and resumeDelivery drains them in order', async () => {
  let held = true
  const h = await setup('openclaw', { shouldHoldDelivery: () => held })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.deepEqual(deliveries(h), [], 'nothing may reach the agent while held')
  const announced = queueSnapshots(h.events)
  assert.deepEqual(announced[announced.length - 1], ['first', 'second'], 'the held queue is announced, not silent')
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(deliveries(h), [['first', 'second']], 'wake delivers what accumulated, in order, as one run')
  h.endTurn()
  await settle()
})

test('resumeDelivery while still held delivers nothing', async () => {
  const h = await setup('openclaw', { shouldHoldDelivery: () => true })
  await h.client.prompt(h.sessionId, 'waiting', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(deliveries(h), [], 'each drain consults the gate; a wake call cannot bypass it')
})

test('push while held degrades to enqueue: the running turn is not cancelled and completes', async () => {
  let held = false
  const h = await setup('openclaw', { shouldHoldDelivery: () => held, cancelEndsTurn: true })
  await h.client.prompt(h.sessionId, 'turn one', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.deepEqual(deliveries(h), [['turn one']], 'precondition: a turn is running')
  held = true
  const result = await h.client.prompt(h.sessionId, 'urgent', {
    queue: 'push',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(result.interrupted, false, 'a push while held interrupts nothing')
  await settle()
  assert.deepEqual(deliveries(h), [['turn one']], 'the running turn was not cancelled')
  h.endTurn()
  await settle()
  assert.deepEqual(deliveries(h), [['turn one']], 'the settle drain is gated too')
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(deliveries(h), [['turn one'], ['urgent']], 'the held push arrives after wake, un-dropped')
  h.endTurn()
  await settle()
})

test('a system entry is held like everything else', async () => {
  let held = true
  const h = await setup('openclaw', { shouldHoldDelivery: () => held })
  await h.client.prompt(h.sessionId, '/compact', { queue: 'wait', origin: { kind: 'system' } })
  await settle()
  assert.deepEqual(deliveries(h), [], 'the system-entry fast-path sits below the gate, not above it')
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.equal(h.promptCalls.length, 1, 'the system entry survives the hold and delivers on wake')
  h.endTurn()
  await settle()
})

test('a queue restored at session open stays held until the host wakes', async () => {
  let held = true
  const durable: QueuedPrompt[] = [
    {
      id: 'held-1',
      kind: 'message',
      sender: 'Reader',
      sentAt: new Date().toISOString(),
      text: 'from before the restart',
    },
  ]
  const store: QueueStore = {
    append: () => {},
    remove: () => {},
    clear: () => {},
    load: () => durable,
  }
  const h = await setup('openclaw', {
    sessionKey: `hold-restore-${counter}`,
    queueStore: store,
    shouldHoldDelivery: () => held,
  })
  await settle()
  assert.deepEqual(deliveries(h), [], 'the restore drain consults the gate: boot comes back held, not flooding')
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(deliveries(h), [['from before the restart']], 'the restored queue delivers on wake')
  h.endTurn()
  await settle()
})

// ── the wake and the reading cadence, together ─────────────────────────────
//
// Two independent holds, and waking releases exactly one of them. The gate
// answers "may anything be delivered at all"; Presence answers "is this
// agent's queue due yet". A wake that answered both would hand every agent its
// whole queue the instant the instance came back, which is the interruption
// the cadence exists to prevent -- and the moment it happens is a restart,
// when the flood is least wanted.
//
// Asserted here rather than left to compose by inspection: the wake path is
// six lines in resumeDelivery and the cadence is evaluated a call deeper, so
// nothing in either place reads as depending on the other.

test('a wake does not flood a session whose cadence is still holding', async () => {
  let held = true
  const h = await setup('openclaw', { shouldHoldDelivery: () => held })
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: WINDOW_MS })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(deliveries(h), [], 'the wake hands the queue to the cadence, not to the agent')
  // Nothing touches the session between the two assertions, so the arrival
  // below can only be the window the wake itself re-armed. That is the half
  // that separates "held by Presence" from "left until something else happens
  // along to trigger a drain".
  await afterWindow()
  assert.deepEqual(deliveries(h), [['held']], 'and the window the wake armed still fires on its own')
  h.endTurn()
  await settle()
})

test('a queue already overdue when the instance wakes goes at once', async () => {
  // The same rule in the other direction. The window is measured from when
  // each message was SENT, so a cadence that elapsed while the instance slept
  // is due the moment the gate opens: an agent does not start a fresh hour
  // because somebody held its queue for one.
  let held = true
  const durable: QueuedPrompt[] = [
    {
      id: 'overdue-1',
      kind: 'message',
      sender: 'Reader',
      sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      text: 'sent two hours ago',
    },
  ]
  const store: QueueStore = {
    append: () => {},
    remove: () => {},
    clear: () => {},
    load: () => durable,
  }
  const h = await setup('openclaw', {
    sessionKey: `wake-overdue-${counter}`,
    queueStore: store,
    loadPresence: () => ({ kind: 'hourly' }),
    shouldHoldDelivery: () => held,
  })
  await settle()
  assert.deepEqual(deliveries(h), [], 'precondition: the restored queue is held by the gate')
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(
    deliveries(h),
    [['sent two hours ago']],
    'an hourly window that elapsed under the hold is due on wake, not an hour later',
  )
  h.endTurn()
  await settle()
})

test('changing the cadence while the instance is asleep delivers nothing', async () => {
  // The two holds compose in one order only. setPresence re-evaluates what is
  // waiting -- that is what makes switching to realtime release it -- and that
  // re-evaluation meets the gate and stops, so the cadence is never a way
  // round a hold.
  const h = await setup('openclaw', { shouldHoldDelivery: () => true })
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: WINDOW_MS })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  h.client.setPresence(h.sessionId, { kind: 'realtime' })
  await afterWindow()
  assert.deepEqual(deliveries(h), [], 'the gate sits above the reading window, on this path too')
  await h.client.deleteSession(h.sessionId)
})

// ── the wake and the sessions this process does not have ───────────────────
//
// A wake can only drain what it can see, and after a restart it sees nothing:
// the queues are durable, the sessions are not. That is the case the feature
// is actually for -- the gate is closed in order to restart -- so "every idle
// session" quietly meant "every idle session that happens to still be here".
//
// The engine decides WHICH absent keys deserve a session (their own cadence
// says the queue is due now) and the host decides HOW one comes back. These
// tests are about the first half; a key that is not due must be left exactly
// where it was, because that is where it would be if the gate had never shut.

/** A durable store over a plain map, with the enumeration the wake needs. */
function keyedStore(rows: Map<string, QueuedPrompt[]>, onLoad?: (key: string) => void): QueueStore {
  return {
    append: () => {},
    remove: () => {},
    clear: () => {},
    load: (key) => {
      onLoad?.(key)
      return rows.get(key) ?? []
    },
    pendingKeys: () => [...rows.keys()],
  }
}

function waiting(text: string, sentAt = new Date().toISOString()): QueuedPrompt {
  return { id: `entry-${text}`, kind: 'message', sender: 'Reader', sentAt, text }
}

test('a wake opens a session for a due queue whose session is gone', async () => {
  // The measured gap: the queue survives a restart, the session does not, and
  // nothing went looking for it.
  let held = true
  const opened: string[] = []
  const rows = new Map([['agent:absent:due', [waiting('from before the restart')]]])
  const h = await setup('openclaw', {
    sessionKey: 'agent:resident',
    queueStore: keyedStore(rows),
    openSessionForKey: (key) => {
      opened.push(key)
    },
    shouldHoldDelivery: () => held,
  })
  await settle()
  assert.deepEqual(opened, [], 'precondition: nothing is opened while the gate is shut')
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(opened, ['agent:absent:due'], 'the wake reaches the key it has no session for')
  await h.client.deleteSession(h.sessionId)
})

test('a wake leaves a key whose cadence is still holding exactly where it was', async () => {
  // The other half of the rule, and the reason the engine reads the cadence
  // instead of opening everything: for an agent, a session is a process.
  const opened: string[] = []
  const rows = new Map([['agent:absent:waiting', [waiting('just sent')]]])
  const h = await setup('openclaw', {
    sessionKey: 'agent:resident',
    queueStore: keyedStore(rows),
    loadPresence: () => ({ kind: 'hourly' }),
    openSessionForKey: (key) => {
      opened.push(key)
    },
    shouldHoldDelivery: () => false,
  })
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(opened, [], 'an hourly key whose hour has not passed is not started for nothing')
  await h.client.deleteSession(h.sessionId)
})

test('a wake does not open a second session for a key this process already holds', async () => {
  // The store answers by key and cannot know what is resident. Opening one that
  // is would put two sessions on one conversation and deliver its queue twice --
  // and the resident drain above has it covered already.
  const opened: string[] = []
  const rows = new Map([['agent:resident', [waiting('held')]]])
  const h = await setup('openclaw', {
    sessionKey: 'agent:resident',
    queueStore: keyedStore(rows),
    openSessionForKey: (key) => {
      opened.push(key)
    },
    shouldHoldDelivery: () => false,
  })
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(opened, [], 'the key is in memory, so the wake leaves it to the drain that can see it')
  await h.client.deleteSession(h.sessionId)
})

test('a wake call made while the gate is still shut opens nothing', async () => {
  // Same rule the per-session drain obeys: every path re-asks the gate, so a
  // wake that arrives early cannot start anything.
  const opened: string[] = []
  const rows = new Map([['agent:absent:due', [waiting('held')]]])
  const h = await setup('openclaw', {
    sessionKey: 'agent:resident',
    queueStore: keyedStore(rows),
    openSessionForKey: (key) => {
      opened.push(key)
    },
    shouldHoldDelivery: () => true,
  })
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(opened, [], 'a wake cannot bypass the gate, on this path either')
  await h.client.deleteSession(h.sessionId)
})

test('a store with no enumeration still wakes what is in memory', async () => {
  // The capability is optional, and a host that has not implemented it must get
  // the older behaviour rather than an error -- the standalone product ships
  // this package too.
  let held = true
  const durable: QueuedPrompt[] = [waiting('resident and held')]
  const store: QueueStore = { append: () => {}, remove: () => {}, clear: () => {}, load: () => durable }
  const h = await setup('openclaw', {
    sessionKey: `no-enumeration-${counter}`,
    queueStore: store,
    shouldHoldDelivery: () => held,
  })
  await settle()
  assert.deepEqual(deliveries(h), [], 'precondition: held')
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(deliveries(h), [['resident and held']], 'the resident half is untouched by the new path')
  h.endTurn()
  await settle()
})

test('one key that cannot be opened does not strand the keys behind it', async () => {
  // A wake gets one chance. Stopping at the first failure would leave every
  // later queue held with nothing coming to look at it again.
  const opened: string[] = []
  const rows = new Map([
    ['agent:absent:first', [waiting('first')]],
    ['agent:absent:second', [waiting('second')]],
  ])
  const h = await setup('openclaw', {
    sessionKey: 'agent:resident',
    queueStore: keyedStore(rows),
    openSessionForKey: (key) => {
      if (key === 'agent:absent:first') {
        throw new Error('this host cannot open that one')
      }
      opened.push(key)
    },
    shouldHoldDelivery: () => false,
  })
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(opened, ['agent:absent:second'], 'the second key is still reached')
  await h.client.deleteSession(h.sessionId)
})

// ── compaction reporting (ACP compaction_update / compaction_summary_chunk) ─

function sendCompactionUpdate(sessionId: string, update: Record<string, unknown>): void {
  handleUpdate({
    sessionId,
    update: { sessionUpdate: 'compaction_update', ...update },
  } as Parameters<typeof handleUpdate>[0])
}

function sendSummaryChunk(sessionId: string, compactionId: string, text: string): void {
  handleUpdate({
    sessionId,
    update: { sessionUpdate: 'compaction_summary_chunk', compactionId, content: { type: 'text', text } },
  } as Parameters<typeof handleUpdate>[0])
}

test('a compaction lifecycle merges into one record, folds to one row, and fires the hook per transition', async () => {
  const hookCalls: CompactionState[] = []
  const h = await setup('openclaw', { onCompaction: (_sessionId, compaction) => hookCalls.push(compaction) })
  sendCompactionUpdate(h.sessionId, {
    compactionId: 'c1',
    status: 'in_progress',
    _meta: { contextCompaction: { version: 1 } },
  })
  // Streamed summary accumulates silently — no chat event per chunk.
  sendSummaryChunk(h.sessionId, 'c1', 'Streamed ')
  sendSummaryChunk(h.sessionId, 'c1', 'summary.')
  sendCompactionUpdate(h.sessionId, {
    compactionId: 'c1',
    status: 'completed',
    // The terminal summary replaces the streamed accumulation wholesale.
    summary: [{ type: 'text', text: 'Final summary.' }],
    _meta: { contextCompaction: { version: 1, trigger: 'manual', preTokens: 1000, postTokens: 200 } },
  })
  const compactions = h.events.filter((event) => event.kind === 'compaction')
  assert.equal(compactions.length, 2, 'one event per compaction_update, none per chunk')
  assert.deepEqual(compactions.at(-1), {
    kind: 'compaction',
    compaction: {
      compactionId: 'c1',
      status: 'completed',
      summary: 'Final summary.',
      trigger: 'manual',
      preTokens: 1000,
      postTokens: 200,
    },
  })
  const folded = foldEvents(sessionEvents(h.sessionId))
  const rows = folded.filter((message) => message.kind === 'tool' && message.title === COMPACTION_TITLE)
  assert.equal(rows.length, 1, 'both updates upsert the same row')
  const row = rows[0]
  assert.ok(row.kind === 'tool')
  assert.equal(row.toolCallId, 'compaction:c1')
  assert.equal(row.status, 'completed')
  assert.equal(row.output, 'Final summary.')
  assert.deepEqual(row.input, { trigger: 'manual', preTokens: 1000, postTokens: 200 })
  assert.deepEqual(
    hookCalls.map((compaction) => compaction.status),
    ['in_progress', 'completed'],
  )
  // The bridge re-sends the terminal to enrich it with boundary facts; the
  // record merges them, the hook does not fire again for the same status.
  sendCompactionUpdate(h.sessionId, {
    compactionId: 'c1',
    status: 'completed',
    _meta: { contextCompaction: { version: 1, durationMs: 42 } },
  })
  const enriched = h.events.filter((event) => event.kind === 'compaction').at(-1)
  assert.ok(enriched && enriched.kind === 'compaction')
  assert.equal(enriched.compaction.durationMs, 42)
  assert.equal(enriched.compaction.summary, 'Final summary.', 'omitted summary stays')
  assert.equal(enriched.compaction.preTokens, 1000, 'meta fields merge rather than reset')
  assert.equal(hookCalls.length, 2)
  await h.client.deleteSession(h.sessionId)
})

test('a terminal update without a summary keeps the streamed accumulation', async () => {
  const h = await setup('openclaw')
  sendCompactionUpdate(h.sessionId, { compactionId: 'c2', status: 'in_progress' })
  sendSummaryChunk(h.sessionId, 'c2', 'Part one.')
  sendSummaryChunk(h.sessionId, 'c2', ' Part two.')
  sendCompactionUpdate(h.sessionId, { compactionId: 'c2', status: 'completed' })
  const last = h.events.filter((event) => event.kind === 'compaction').at(-1)
  assert.ok(last && last.kind === 'compaction')
  assert.equal(last.compaction.summary, 'Part one. Part two.')
  await h.client.deleteSession(h.sessionId)
})

test('a cancelled compaction closes its row as terminal, and a failed one carries its error', async () => {
  const h = await setup('openclaw')
  sendCompactionUpdate(h.sessionId, { compactionId: 'c3', status: 'in_progress' })
  sendCompactionUpdate(h.sessionId, { compactionId: 'c3', status: 'cancelled' })
  sendCompactionUpdate(h.sessionId, { compactionId: 'c4', status: 'failed', error: 'ran out of road' })
  const folded = foldEvents(sessionEvents(h.sessionId))
  const cancelled = folded.find((message) => message.kind === 'tool' && message.toolCallId === 'compaction:c3')
  assert.ok(cancelled && cancelled.kind === 'tool')
  assert.equal(cancelled.status, 'cancelled')
  assert.ok(isTerminalToolStatus(cancelled.status), 'the row is settled, not forever in progress')
  const failed = folded.find((message) => message.kind === 'tool' && message.toolCallId === 'compaction:c4')
  assert.ok(failed && failed.kind === 'tool')
  assert.equal(failed.status, 'failed')
  assert.equal(failed.output, 'ran out of road')
  await h.client.deleteSession(h.sessionId)
})

test('a replayed compaction emits its event but never fires the live hook', async () => {
  const hookCalls: CompactionState[] = []
  const h = await setup('openclaw', { onCompaction: (_sessionId, compaction) => hookCalls.push(compaction) })
  const session = acpStore().sessions.get(h.sessionId) as { replaying?: boolean }
  session.replaying = true
  sendCompactionUpdate(h.sessionId, {
    compactionId: 'c5',
    status: 'completed',
    summary: [{ type: 'text', text: 'Old news.' }],
  })
  session.replaying = false
  assert.ok(
    h.events.some((event) => event.kind === 'compaction' && event.compaction.compactionId === 'c5'),
    'the transcript still shows the replayed compaction',
  )
  assert.equal(hookCalls.length, 0, 'a replayed completed is old news, not a fresh compaction')
  await h.client.deleteSession(h.sessionId)
})

// ── steering (mid-turn input via the harness's _session/steering extension) ─

test('a harness that advertised steering injects a mid-turn message instead of queuing it', async () => {
  const h = await setup('openclaw', { steeringSupported: true })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.equal(h.promptCalls.length, 1, 'the first message started the turn')

  await h.client.prompt(h.sessionId, 'steer me', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.equal(h.promptCalls.length, 1, 'the mid-turn message did NOT start a second prompt turn')
  const steer = h.extMethodCalls.find((call) => call.method === '_session/steering')
  assert.ok(steer, 'it went through the steering extension')
  // Delivered text is wrapped with the sender's queue tag, like any message run.
  assert.match((steer.params.prompt as Array<{ text: string }>)[0].text, /steer me/)
  const users = h.events.filter((event) => event.kind === 'user' && event.text.includes('steer me'))
  assert.equal(users.length, 1, 'the injected message shows once in the transcript')
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('a realtime message steers into the turn even while a subagent is running', async () => {
  // Realtime asks to be read mid-turn, and a steer is an injection, not a
  // cancel: the bridge re-applies the turn's subagent hold across it (only
  // `session/cancel` finishes subagents as cancelled), so the reader reaches
  // the agent while the delegation keeps running. Gating this on "no live
  // background work" was the exact thing that made a realtime session
  // unreachable for as long as it had a subagent out.
  const h = await setup('openclaw', { steeringSupported: true })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  sendUpdate(h.sessionId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'steer-guard-child',
    name: 'Researcher',
    task: 'dig',
    capabilities: {},
  })

  await h.client.prompt(h.sessionId, 'while it digs', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  const steered = h.extMethodCalls.filter((call) => call.method === '_session/steering')
  assert.equal(steered.length, 1, 'the message went into the running turn, subagent and all')
  assert.match((steered[0].params.prompt as Array<{ text: string }>)[0].text, /while it digs/)
  assert.equal(h.promptCalls.length, 1, 'no second prompt turn was started — it steered')
  assert.ok(h.client.hasBackgroundWork(h.sessionId), 'the subagent is untouched: no cancel was issued')

  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('steering that returns promptRequired falls through to a normal prompt', async () => {
  const h = await setup('openclaw', { steeringSupported: true, steerOutcome: 'promptRequired' })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  // The turn was still counted as running, so the second went to steering; the
  // extension declined (promptRequired), and the message must not be lost — it
  // falls through to a real prompt once the first turn ends.
  assert.ok(h.extMethodCalls.some((call) => call.method === '_session/steering'))
  h.endTurn() // first turn ends → queued 'second' drains as a prompt
  await settle()
  assert.deepEqual(deliveries(h), [['first'], ['second']], 'the declined steer was delivered as a prompt, in order')
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('without steering support a mid-turn message queues as before', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.equal(h.extMethodCalls.length, 0, 'no steering attempted')
  assert.deepEqual(deliveries(h), [['first']], 'the second message is held, not injected')
  h.endTurn()
  await settle()
  assert.deepEqual(deliveries(h), [['first'], ['second']])
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

// Steering is a cadence choice, not only a capability: only `realtime` reads a
// message into the running turn. The three below pin the other cadences on a
// harness that COULD steer — each keeps its own promise instead.

test('online holds a mid-turn message on a steering harness and reads it between turns', async () => {
  const h = await setup('openclaw', { steeringSupported: true })
  h.client.setPresence(h.sessionId, { kind: 'online' })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  await h.client.prompt(h.sessionId, 'between', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.equal(h.extMethodCalls.length, 0, 'capability is not consent: nothing steered')
  assert.deepEqual(deliveries(h), [['first']], 'held for the turn boundary')
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['between'], 'and shown as waiting meanwhile')
  h.endTurn()
  await settle()
  assert.deepEqual(deliveries(h), [['first'], ['between']], 'read the moment its own turn ended')
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('a reading window that closes mid-turn does not steer either', async () => {
  // The timer path, not the send path: a system entry jumps the held message
  // and starts a turn, so the armed window closes while that turn is still
  // open. Before the cadence gate, the timer's drain injected the held
  // message into the system turn via steering.
  const h = await setup('openclaw', { steeringSupported: true })
  h.client.setPresence(h.sessionId, { kind: 'custom', intervalMs: WINDOW_MS })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, '<restore>', { queue: 'wait', origin: { kind: 'system' } })
  await settle()
  assert.deepEqual(h.promptCalls, ['<restore>'], 'the system entry went alone, and started the turn')

  await afterWindow()
  assert.equal(h.extMethodCalls.length, 0, 'the elapsed window must not become an injection')
  assert.deepEqual(h.promptCalls.length, 1, 'still held behind the running turn')
  h.endTurn()
  await settle()
  assert.deepEqual(partsOf(h.promptCalls[1]), ['held'], 'the turn boundary delivers what came due')
  h.endTurn()
  await h.client.deleteSession(h.sessionId)
})

test('High Attention pushes the queue in through steering on a harness that supports it', async () => {
  // "Push the queue through now" is the cadence's standing word; the MECHANISM
  // is steering wherever the harness has it, because `session/cancel` finishes
  // the turn's subagents as cancelled and a push must not be what kills a
  // delegation. The reader's "stop and read" survives as a steer that pre-empts
  // the current cycle, and the compact interrupt note still rides along.
  const h = await setup('openclaw', { steeringSupported: true })
  h.client.setPresence(h.sessionId, { kind: 'high-attention' })
  await h.client.prompt(h.sessionId, 'running', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  const { interrupted } = await h.client.prompt(h.sessionId, 'urgent', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.equal(interrupted, false, 'steered around the turn rather than stopping it')
  const steered = h.extMethodCalls.filter((call) => call.method === '_session/steering')
  assert.equal(steered.length, 1, 'the push went in through steering')
  assert.match(
    (steered[0].params.prompt as Array<{ text: string }>)[0].text,
    /^Your turn was interrupted to deliver the incoming messages below\./,
    'and still opens with the compact interrupt note',
  )
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('the turn boundary closes out a subagent that never sent its terminal state', async () => {
  // The harness settles a prompt only once the subagents it spawned have
  // drained (or the turn was cancelled, which finishes them itself), so a
  // subagent still "live" at turn_end lost its state_update, not its life.
  // Reconciling at the boundary — not on a timer — is what keeps a lost event
  // from pinning background work (the Working badge, the idle-reaper guard)
  // forever.
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'delegate', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  sendUpdate(h.sessionId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'orphaned-child',
    name: 'Researcher',
    task: 'dig',
    capabilities: {},
  })
  assert.ok(h.client.hasBackgroundWork(h.sessionId), 'the spawned subagent is live background work')

  h.endTurn()
  await settle()
  assert.equal(h.client.hasBackgroundWork(h.sessionId), false, 'the boundary reconciled it')
  const lastSubagent = h.events.filter((event) => event.kind === 'subagent').at(-1)
  assert.equal(
    lastSubagent?.kind === 'subagent' ? lastSubagent.subagent.state : undefined,
    'completed',
    'and said so in the transcript, so a fold sees the terminal state',
  )
  await h.client.deleteSession(h.sessionId)
})

test('a push delivers the held queue through steering, leaving a running subagent alive', async () => {
  // The "deliver now" push (queue: push, no text of its own) on an online
  // session that is mid-delegation: it must hand the held messages over without
  // a `session/cancel`, which would finish the subagent as cancelled. This is
  // the deliverQueue path — the Unread heading's button — and it is the case
  // that once killed a delegation just by asking to be read.
  const h = await setup('openclaw', { steeringSupported: true })
  h.client.setPresence(h.sessionId, { kind: 'online' })
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  sendUpdate(h.sessionId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'push-steer-child',
    name: 'Researcher',
    task: 'dig',
    capabilities: {},
  })
  await h.client.prompt(h.sessionId, 'held', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.equal(
    h.extMethodCalls.filter((call) => call.method === '_session/steering').length,
    0,
    'online held it behind the turn; nothing steered yet',
  )

  const { interrupted } = await h.client.prompt(h.sessionId, '', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  assert.equal(interrupted, false, 'the held queue was steered in, not stopped')
  const steered = h.extMethodCalls.filter((call) => call.method === '_session/steering')
  assert.equal(steered.length, 1, 'the held message went in through steering')
  assert.match((steered[0].params.prompt as Array<{ text: string }>)[0].text, /held/)
  assert.ok(h.client.hasBackgroundWork(h.sessionId), 'the subagent is still running')
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('agent message chunks with different messageIds do not merge into one block', async () => {
  const h = await setup('openclaw')
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before.' }, messageId: 'm1' },
  } as Parameters<typeof handleUpdate>[0])
  handleUpdate({
    sessionId: h.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after.' }, messageId: 'm2' },
  } as Parameters<typeof handleUpdate>[0])
  const msgs = h.events.filter(
    (event): event is Extract<ChatEvent, { kind: 'agent_message' }> => event.kind === 'agent_message',
  )
  assert.deepEqual(
    msgs.map((m) => m.messageId),
    ['m1', 'm2'],
    'each chunk keeps its own message id for the fold to split on',
  )
  await h.client.deleteSession(h.sessionId)
})

// ── subagents (ACP #1992 subagent_spawned / subagent_state_update) ──────────

function sendUpdate(sessionId: string, update: Record<string, unknown>): void {
  handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
}

test('a spawned subagent routes its own transcript into the parent and closes on a terminal state', async () => {
  // openclaw (no per-session MCP server) so the test needs no reset() teardown;
  // subagent routing is handled in handleUpdate regardless of adapter.
  const h = await setup('openclaw')
  const childId = 'child-sess-1'
  sendUpdate(h.sessionId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: childId,
    name: 'Researcher',
    task: 'dig',
    capabilities: {},
  })
  assert.ok(h.client.hasBackgroundWork(h.sessionId), 'a live subagent is background work')

  // The child's own activity arrives addressed to ITS session id.
  sendUpdate(childId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } })
  const nested = h.events.find((event) => event.kind === 'subagent_event' && event.subagentSessionId === childId)
  assert.ok(
    nested && nested.kind === 'subagent_event' && nested.event.kind === 'agent_message',
    'the child step nested under the parent',
  )

  sendUpdate(h.sessionId, { sessionUpdate: 'subagent_state_update', subagentSessionId: childId, state: 'completed' })
  const last = h.events.filter((event) => event.kind === 'subagent').at(-1)
  assert.ok(last && last.kind === 'subagent' && last.subagent.state === 'completed')
  assert.equal(h.client.hasBackgroundWork(h.sessionId), false, 'a completed subagent is no longer background work')
  await h.client.deleteSession(h.sessionId)
})

test("a subagent's permission request is asked in the parent chat and answered from there", async () => {
  // The harness raises the request under the SUBAGENT's session id — a session
  // nobody subscribes to. Before routing, the event was emitted into the void
  // and the promise never settled: the subagent sat waiting forever unless the
  // session bypassed permissions altogether.
  const h = await setup('openclaw', { sessionKey: 'agent:perm-parent' })
  const childId = 'child-sess-perm'
  sendUpdate(h.sessionId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: childId,
    name: 'Builder',
    task: 'run it',
    capabilities: {},
  })
  const client = buildClient(() => h.sessionId, 'local')
  const response = client.requestPermission({
    sessionId: childId,
    toolCall: { toolCallId: 'call-1', title: 'Run a command' },
    options: [
      { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    ],
  })
  const asked = h.events.find((event) => event.kind === 'permission_request')
  assert.ok(asked && asked.kind === 'permission_request', 'the request reached the parent session')
  assert.equal(asked.title, 'Run a command')
  assert.deepEqual(h.client.awaitingUserSessionKeys(), ['agent:perm-parent'], 'the PARENT is the blocked one')
  h.client.resolvePermission(asked.requestId, 'yes')
  assert.deepEqual(await response, { outcome: { outcome: 'selected', optionId: 'yes' } })
  assert.ok(
    h.events.some((event) => event.kind === 'permission_resolved' && event.requestId === asked.requestId),
    'the answer is recorded in the parent session too',
  )
  await h.client.deleteSession(h.sessionId)
})

// Two sessions, so "the session it was raised in" is told apart from "a
// session": the request is raised in the second one.
test('pendingRequestSessionId names the session a permission request was raised in, until it is answered', async () => {
  const other = await setup('openclaw')
  const h = await setup('openclaw')
  const client = buildClient(() => h.sessionId, 'local')
  const response = client.requestPermission({
    sessionId: h.sessionId,
    toolCall: { toolCallId: 'call-1', title: 'Run a command' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  })
  const asked = h.events.find((event) => event.kind === 'permission_request')
  assert.ok(asked && asked.kind === 'permission_request')
  assert.notEqual(other.sessionId, h.sessionId)
  assert.equal(h.client.pendingRequestSessionId(asked.requestId), h.sessionId)
  assert.equal(h.client.pendingRequestSessionId('no-such-request'), undefined)
  h.client.resolvePermission(asked.requestId, 'yes')
  assert.deepEqual(await response, { outcome: { outcome: 'selected', optionId: 'yes' } })
  assert.equal(h.client.pendingRequestSessionId(asked.requestId), undefined)
  await h.client.deleteSession(h.sessionId)
  await other.client.deleteSession(other.sessionId)
})

test('pendingRequestSessionId names the session a question was raised in, until it is answered', async () => {
  const h = await setup('openclaw')
  const { createElicitation } = buildClient(() => h.sessionId, 'local')
  assert.ok(createElicitation)
  const response = createElicitation({
    mode: 'form',
    sessionId: h.sessionId,
    message: 'Pick one',
    requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } },
  })
  const ask = h.events.find((event) => event.kind === 'ask_user')
  assert.ok(ask && ask.kind === 'ask_user')
  assert.equal(h.client.pendingRequestSessionId(ask.requestId), h.sessionId)
  h.client.resolveElicitation(ask.requestId, { choice: 'a' })
  assert.deepEqual(await response, { action: 'accept', content: { choice: 'a' } })
  assert.equal(h.client.pendingRequestSessionId(ask.requestId), undefined)
  await h.client.deleteSession(h.sessionId)
})

// The id a reader's chat knows is the parent's: a subagent's request is drawn
// there, and that is the session an answer to it arrives naming.
test("pendingRequestSessionId names the parent session for a subagent's permission request", async () => {
  const h = await setup('openclaw', { sessionKey: 'agent:perm-owner' })
  const childId = 'child-sess-perm-owner'
  sendUpdate(h.sessionId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: childId,
    name: 'Builder',
    task: 'run it',
    capabilities: {},
  })
  const client = buildClient(() => h.sessionId, 'local')
  const response = client.requestPermission({
    sessionId: childId,
    toolCall: { toolCallId: 'call-1', title: 'Run a command' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
  })
  const asked = h.events.find((event) => event.kind === 'permission_request')
  assert.ok(asked && asked.kind === 'permission_request')
  assert.equal(h.client.pendingRequestSessionId(asked.requestId), h.sessionId)
  h.client.resolvePermission(asked.requestId, 'yes')
  assert.deepEqual(await response, { outcome: { outcome: 'selected', optionId: 'yes' } })
  assert.equal(h.client.pendingRequestSessionId(asked.requestId), undefined)
  await h.client.deleteSession(h.sessionId)
})

// ── background tasks (AIR async_task_* ) ────────────────────────────────────

test('a background task is reported, snapshot-prefixed while live, and stoppable', async () => {
  const h = await setup('openclaw', { sessionKey: 'agent:with-tasks' })
  sendUpdate(h.sessionId, {
    sessionUpdate: 'async_task_spawned',
    asyncTaskId: 'task-1',
    name: 'nightly loop',
    taskType: 'loop',
    description: 'runs the thing',
    showInTranscript: true,
    canStop: true,
  })
  assert.ok(h.client.hasBackgroundWork(h.sessionId), 'a running task is background work')
  assert.deepEqual(h.client.backgroundWorkSessionKeys(), ['agent:with-tasks'])

  // A subscriber joining PAST the task event (windowed to nothing) is still
  // handed the live task, via the snapshot prefix.
  const late: ChatEvent[] = []
  const unsub = h.client.subscribe(h.sessionId, (event) => late.push(event), { fromIndex: 9999 })
  assert.ok(
    late.some((event) => event.kind === 'async_task' && event.task.asyncTaskId === 'task-1'),
    'live task replays to a new subscriber',
  )
  unsub()

  const stopped = await h.client.stopAsyncTask(h.sessionId, 'task-1')
  assert.equal(stopped, true)
  assert.ok(h.extMethodCalls.some((call) => call.method === '_session/async_task/stop'))

  sendUpdate(h.sessionId, { sessionUpdate: 'async_task_state_update', asyncTaskId: 'task-1', state: 'stopped' })
  assert.equal(h.client.hasBackgroundWork(h.sessionId), false, 'a stopped task is no longer background work')
  await h.client.deleteSession(h.sessionId)
})

// ── background tasks the host runs (upsertAsyncTask / stopHostTask) ────────
//
// The application reports work it runs for a session in the same record a
// harness's tasks use, so session status, the idle guard, the transcript and
// restore all follow from one emit. What differs is who stops it: the harness
// has never heard of a host task, so a stop for one has to go back to the host.

const HOST_TASK: AsyncTaskInfo = {
  asyncTaskId: 'host-build',
  name: 'build',
  taskType: 'build',
  description: 'npm run build',
  state: 'running',
  canStop: true,
  showInTranscript: true,
}

test('a host task is reported as the host’s own and holds the session working only while it runs', async () => {
  const h = await setup('openclaw', { sessionKey: 'agent:host-task' })
  assert.equal(h.client.upsertAsyncTask(h.sessionId, HOST_TASK), true)
  assert.deepEqual(
    h.events.filter((event) => event.kind === 'async_task'),
    [{ kind: 'async_task', task: { ...HOST_TASK, origin: 'host' } }],
    'the ordinary async_task event, marked as the host’s although the caller did not say so',
  )
  assert.ok(h.client.hasBackgroundWork(h.sessionId), 'a running host task is background work')
  assert.ok(h.client.backgroundWorkSessionKeys().includes('agent:host-task'))

  assert.equal(h.client.upsertAsyncTask(h.sessionId, { ...HOST_TASK, state: 'completed', summary: 'exit 0' }), true)
  assert.deepEqual(h.events.filter((event) => event.kind === 'async_task').at(-1), {
    kind: 'async_task',
    task: { ...HOST_TASK, state: 'completed', summary: 'exit 0', origin: 'host' },
  })
  assert.equal(h.client.hasBackgroundWork(h.sessionId), false, 'a finished host task no longer holds the session')
  assert.equal(h.client.backgroundWorkSessionKeys().includes('agent:host-task'), false)

  assert.equal(h.client.upsertAsyncTask('no-such-session', HOST_TASK), false, 'nothing in memory to hold it')
  await h.client.deleteSession(h.sessionId)
})

test('stopping a host task goes to the host, and a harness task still goes to the harness', async () => {
  const hostStops: Array<{ sessionId: string; sessionKey?: string; asyncTaskId: string }> = []
  const h = await setup('openclaw', {
    sessionKey: 'agent:host-stop',
    stopHostTask: async (request) => {
      hostStops.push(request)
      if (request.asyncTaskId === 'host-unreachable') {
        throw new Error('runner unreachable')
      }
      return true
    },
  })
  const harnessStops = () =>
    h.extMethodCalls.filter((call) => call.method === '_session/async_task/stop').map((call) => call.params)
  h.client.upsertAsyncTask(h.sessionId, HOST_TASK)
  sendUpdate(h.sessionId, {
    sessionUpdate: 'async_task_spawned',
    asyncTaskId: 'harness-loop',
    name: 'loop',
    taskType: 'loop',
    description: 'polls',
    canStop: true,
  })

  assert.equal(await h.client.stopAsyncTask(h.sessionId, 'host-build'), true, 'the host’s answer is the answer')
  assert.deepEqual(hostStops, [{ sessionId: h.sessionId, sessionKey: 'agent:host-stop', asyncTaskId: 'host-build' }])
  assert.deepEqual(harnessStops(), [], 'the harness is never asked about a task it does not own')

  assert.equal(await h.client.stopAsyncTask(h.sessionId, 'harness-loop'), true)
  assert.deepEqual(harnessStops(), [{ sessionId: h.sessionId, asyncTaskId: 'harness-loop' }], 'today’s path, as it was')
  assert.equal(hostStops.length, 1, 'and the host is not asked about the harness’s task')

  // A stop the host could not carry out is said out loud, not folded into a
  // quiet false.
  h.client.upsertAsyncTask(h.sessionId, { ...HOST_TASK, asyncTaskId: 'host-unreachable' })
  assert.equal(await h.client.stopAsyncTask(h.sessionId, 'host-unreachable'), false)
  assert.ok(h.events.some((event) => event.kind === 'error' && event.message.includes('runner unreachable')))

  // A host that runs no work of its own has nothing to stop one with — and the
  // harness is still not the fallback.
  const bare = createAgentClient()
  assert.equal(await bare.stopAsyncTask(h.sessionId, 'host-build'), false)
  assert.equal(harnessStops().length, 1)
  await h.client.deleteSession(h.sessionId)
})

// ── updates a harness addresses to a subagent's session ────────────────────
//
// A harness sends everything a subagent does on the subagent's own session
// id, including the subagents IT spawns and the background commands it
// starts. Those ids are not sessions here; the fixtures below are the
// sequences codex-acp 1.13.1 sends, copied from the source file each one
// names, with its thread ids replaced by readable ones.

function subagentRoutes(): Map<string, string> {
  const store = (globalThis as typeof globalThis & { __acpStore?: { subagentParents: Map<string, string> } }).__acpStore
  assert.ok(store)
  return store.subagentParents
}

test('a subagent spawned by a subagent nests under it, and both close where they were announced', async () => {
  const h = await setup('openclaw')
  const childId = 'thread-worker'
  const grandchildId = 'thread-helper'
  // src/subagents/CodexSubagentEventRouter.ts, materialize(): the spawn goes to
  // the spawning session — the root for a direct child, the child for its own.
  sendUpdate(h.sessionId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: childId,
    name: 'Worker',
    task: 'split the job',
    capabilities: {},
  })
  sendUpdate(childId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: grandchildId,
    name: 'Helper',
    task: 'check one half',
    capabilities: {},
  })
  // src/subagents/CodexSubagentEventRouter.ts, notificationSessionId(): the
  // grandchild's own output is addressed to the grandchild.
  sendUpdate(grandchildId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'half checked' } })
  // src/subagents/CodexSubagentEventRouter.ts, finish(): the terminal state
  // goes to child.parentSessionId, the same session the spawn went to.
  sendUpdate(childId, { sessionUpdate: 'subagent_state_update', subagentSessionId: grandchildId, state: 'completed' })
  assert.ok(h.client.hasBackgroundWork(h.sessionId), 'the child is still running')
  sendUpdate(h.sessionId, { sessionUpdate: 'subagent_state_update', subagentSessionId: childId, state: 'completed' })

  const worker = { subagentSessionId: childId, name: 'Worker', task: 'split the job' }
  const helper = { subagentSessionId: grandchildId, name: 'Helper', task: 'check one half' }
  assert.deepEqual(
    h.events.filter((event) => event.kind === 'subagent' || event.kind === 'subagent_event'),
    [
      { kind: 'subagent', subagent: worker },
      { kind: 'subagent_event', subagentSessionId: childId, event: { kind: 'subagent', subagent: helper } },
      {
        kind: 'subagent_event',
        subagentSessionId: childId,
        event: {
          kind: 'subagent_event',
          subagentSessionId: grandchildId,
          event: { kind: 'agent_message', text: 'half checked' },
        },
      },
      {
        kind: 'subagent_event',
        subagentSessionId: childId,
        event: { kind: 'subagent', subagent: { ...helper, state: 'completed' } },
      },
      { kind: 'subagent', subagent: { ...worker, state: 'completed' } },
    ],
  )
  assert.equal(h.client.hasBackgroundWork(h.sessionId), false)

  await h.client.deleteSession(h.sessionId)
  assert.equal(subagentRoutes().has(childId), false)
  assert.equal(subagentRoutes().has(grandchildId), false, 'the whole spawn tree goes with its session')
})

test('the turn boundary closes a silent grandchild where it sits, not at the top level', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'delegate', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  sendUpdate(h.sessionId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'thread-a',
    name: 'A',
    task: 'a',
    capabilities: {},
  })
  sendUpdate('thread-a', {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: 'thread-b',
    name: 'B',
    task: 'b',
    capabilities: {},
  })
  h.endTurn()
  await settle()
  assert.equal(h.client.hasBackgroundWork(h.sessionId), false)

  const closures = h.events.filter(
    (event) =>
      (event.kind === 'subagent' && event.subagent.state === 'completed') ||
      (event.kind === 'subagent_event' &&
        event.event.kind === 'subagent' &&
        event.event.subagent.state === 'completed'),
  )
  assert.deepEqual(closures, [
    { kind: 'subagent', subagent: { subagentSessionId: 'thread-a', name: 'A', task: 'a', state: 'completed' } },
    {
      kind: 'subagent_event',
      subagentSessionId: 'thread-a',
      event: {
        kind: 'subagent',
        subagent: { subagentSessionId: 'thread-b', name: 'B', task: 'b', state: 'completed' },
      },
    },
  ])
  await h.client.deleteSession(h.sessionId)
})

test('a background command a subagent starts is the session’s task, and stops through the session', async () => {
  const h = await setup('openclaw')
  const childId = 'thread-worker'
  const itemId = 'call-dev-server'
  // src/async-tasks/CodexBackgroundTerminalTasks.ts, wireTaskId(): a child
  // command's task id is prefixed with the child thread id.
  const asyncTaskId = `${childId}:${itemId}`
  sendUpdate(h.sessionId, {
    sessionUpdate: 'subagent_spawned',
    subagentSessionId: childId,
    name: 'Worker',
    task: 'run the dev server',
    capabilities: {},
  })
  // src/async-tasks/CodexBackgroundTerminalTasks.ts, publishSpawn(): both
  // updates go to task.sessionId, the child session.
  sendUpdate(childId, {
    sessionUpdate: 'tool_call_update',
    toolCallId: itemId,
    _meta: { jetbrains: { air: { asyncTasks: { backgrounded: true } } } },
  })
  sendUpdate(childId, {
    sessionUpdate: 'async_task_spawned',
    asyncTaskId,
    name: 'npm run dev',
    taskType: 'shell',
    showInTranscript: false,
    canStop: true,
    toolCallId: itemId,
  })
  sendUpdate(h.sessionId, { sessionUpdate: 'subagent_state_update', subagentSessionId: childId, state: 'completed' })

  const running: AsyncTaskInfo = {
    asyncTaskId,
    name: 'npm run dev',
    taskType: 'shell',
    description: '',
    state: 'running',
    canStop: true,
    showInTranscript: false,
    toolCallId: itemId,
    subagentSessionId: childId,
  }
  assert.deepEqual(
    h.events.filter((event) => event.kind === 'async_task'),
    [{ kind: 'async_task', task: running }],
    'on the session’s own list, marked with the subagent that started it',
  )
  assert.ok(h.client.hasBackgroundWork(h.sessionId), 'it outlives the subagent that started it')

  // docs/async-tasks.md and CodexAcpServer.ts: the stop is resolved among the
  // root sessions only, so it must name the session whichever id the caller has.
  const stops = () =>
    h.extMethodCalls.filter((call) => call.method === '_session/async_task/stop').map((call) => call.params)
  assert.equal(await h.client.stopAsyncTask(h.sessionId, asyncTaskId), true)
  assert.equal(await h.client.stopAsyncTask(childId, asyncTaskId), true)
  assert.deepEqual(stops(), [
    { sessionId: h.sessionId, asyncTaskId },
    { sessionId: h.sessionId, asyncTaskId },
  ])

  // src/async-tasks/CodexBackgroundTerminalTasks.ts, publishTerminalState().
  sendUpdate(childId, { sessionUpdate: 'async_task_state_update', asyncTaskId, state: 'stopped', toolCallId: itemId })
  assert.deepEqual(h.events.filter((event) => event.kind === 'async_task').at(-1), {
    kind: 'async_task',
    task: { ...running, state: 'stopped' },
  })
  assert.equal(h.client.hasBackgroundWork(h.sessionId), false)
  await h.client.deleteSession(h.sessionId)
})

// ── the stream seam the draft kinds must cross ──────────────────────────────

test('a draft-kind update is taken out of the wire stream and still lands in the session', async () => {
  // The tests above feed handleUpdate directly, which is exactly how a live
  // gap once shipped: the ACP SDK validates inbound session/update against
  // its own schema union, and a draft kind fails the parse before any of
  // that code runs. This one crosses the wire seam instead.
  const h = await setup('openclaw')
  const frames = [
    {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: h.sessionId,
        update: { sessionUpdate: 'subagent_spawned', subagentSessionId: 'wire-child', name: 'Researcher', task: 'dig' },
      },
    },
    // A kind the SDK knows must pass through untouched, draft-free batches
    // included.
    {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: h.sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      },
    },
  ]
  const source = new ReadableStream({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(frame)
      }
      controller.close()
    },
  })
  const wrapped = interceptDraftSessionUpdates({
    readable: source,
    writable: new WritableStream(),
  } as Parameters<typeof interceptDraftSessionUpdates>[0])
  const forwarded: unknown[] = []
  const reader = wrapped.readable.getReader()
  for (;;) {
    const result = await reader.read()
    if (result.done) {
      break
    }
    forwarded.push(result.value)
  }
  assert.equal(forwarded.length, 1, 'the draft frame was consumed, the known one forwarded')
  assert.ok(
    h.events.some((event) => event.kind === 'subagent' && event.subagent.subagentSessionId === 'wire-child'),
    'the intercepted update reached the session anyway',
  )
  await h.client.deleteSession(h.sessionId)
})

// ── notifications from the host (notify) ────────────────────────────────────
//
// The application telling the agent that work the agent started has ended. Not
// a message: it never enters the queue, no cadence holds it, and it goes in
// verbatim. A running turn takes it by steering where the harness can and
// holds it for its settlement where it cannot; an idle session gets it as a
// turn of its own. Each test below pins one of those rules.

// A promise's outcome once the engine's own follow-up work has run, or
// 'pending' -- so a notification that never settles fails the assertion that
// expected it to, instead of hanging the file.
function outcomeOf<T>(promise: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([promise, settle().then(() => 'pending' as const)])
}

const NOTE = '<background-task id="b-1" state="completed">npm run build: exit 0</background-task>'

test('a notification to an idle session is a turn of exactly its text, answered once handed over', async () => {
  const h = await setup('openclaw')
  assert.equal(await outcomeOf(h.client.notify(h.sessionId, NOTE)), true)
  assert.deepEqual(h.promptCalls, [NOTE], 'verbatim: no queue tag, no delivery note')
  assert.deepEqual(
    h.events.filter((event) => event.kind === 'user'),
    [{ kind: 'user', text: NOTE }],
    'the ordinary user event: the turn boundary a transcript folds on',
  )
  assert.ok(h.client.hasActiveTurn(h.sessionId), 'answered at the hand-over, not at the end of the turn it started')
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('a notification held behind a turn that cannot take it goes first when that turn ends, the queue after it', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'first', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'second', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  const notified = h.client.notify(h.sessionId, NOTE)
  assert.equal(await outcomeOf(notified), 'pending', 'no steering here, so it waits for the turn')
  assert.deepEqual(deliveries(h), [['first']])

  h.endTurn()
  await settle()
  assert.equal(h.promptCalls[1], NOTE, 'the settlement hands over the notification ahead of the queued message')
  assert.equal(h.promptCalls.length, 2, 'as a turn of its own: nothing queued rode along')
  assert.equal(await outcomeOf(notified), true)
  assert.deepEqual(queueSnapshots(h.events).at(-1), ['second'], 'the message is still waiting')

  h.endTurn()
  await settle()
  assert.deepEqual(partsOf(h.promptCalls[2]), ['second'], 'the queue drains once the notification turn settles')
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('several notifications held behind one turn go out as one prompt', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  const build = h.client.notify(h.sessionId, 'build finished')
  const deploy = h.client.notify(h.sessionId, 'deploy finished')
  h.endTurn()
  await settle()
  assert.deepEqual(h.promptCalls.slice(1), ['build finished\n\ndeploy finished'], 'one turn, oldest first')
  assert.deepEqual([await outcomeOf(build), await outcomeOf(deploy)], [true, true])
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('a notification steers into a running turn whatever the cadence, and never stops it', async () => {
  // `online` keeps a MESSAGE for the turn boundary even on a harness that can
  // steer (pinned in the steering section); a notification is not a message.
  // cancelEndsTurn makes a `session/cancel` visible: it would end the turn.
  const h = await setup('openclaw', { steeringSupported: true, cancelEndsTurn: true })
  h.client.setPresence(h.sessionId, { kind: 'online' })
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  assert.equal(await outcomeOf(h.client.notify(h.sessionId, NOTE)), true, 'handed over by the accepted steer')
  const steers = h.extMethodCalls.filter((call) => call.method === '_session/steering')
  assert.equal(steers.length, 1)
  assert.equal((steers[0].params.prompt as Array<{ text: string }>)[0].text, NOTE, 'verbatim on this path too')
  assert.equal(h.promptCalls.length, 1, 'no turn of its own')
  assert.equal(kinds(h.events).includes('turn_end'), false, 'the running turn was steered, not stopped')
  assert.equal(h.events.filter((event) => event.kind === 'user' && event.text === NOTE).length, 1)
  h.endTurn()
  await settle()
  assert.equal(h.promptCalls.length, 1, 'nothing left for the settlement to deliver')
  await h.client.deleteSession(h.sessionId)
})

test('a notification whose steer is declined is held for the end of the turn, not lost and not forced in', async () => {
  const h = await setup('openclaw', { steeringSupported: true, steerOutcome: 'promptRequired' })
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  const notified = h.client.notify(h.sessionId, NOTE)
  assert.equal(await outcomeOf(notified), 'pending', 'a declined steer handed nothing over')
  assert.equal(h.extMethodCalls.filter((call) => call.method === '_session/steering').length, 1, 'it was tried')
  assert.equal(h.promptCalls.length, 1, 'and not replaced by a prompt overlapping the turn')
  h.endTurn()
  await settle()
  assert.deepEqual(h.promptCalls.slice(1), [NOTE], 'the settlement delivers it')
  assert.equal(await outcomeOf(notified), true)
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('a turn that ends while a notification steer is still unanswered delivers it before the queue', async () => {
  // The race window: the harness answers the prompt ahead of the steer, and a
  // turn that has ended refuses the injection. Waiting for that refusal before
  // touching the queue would let the queue go first.
  let answer: (outcome: string) => void = () => {}
  const h = await setup('openclaw', {
    steeringSupported: true,
    steerOutcome: new Promise<string>((resolve) => {
      answer = resolve
    }),
  })
  h.client.setPresence(h.sessionId, { kind: 'online' })
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'queued', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  const notified = h.client.notify(h.sessionId, NOTE)
  await settle()
  h.endTurn()
  await settle()
  assert.equal(h.promptCalls[1], NOTE, 'the settlement took the notification back and delivered it first')
  assert.equal(await outcomeOf(notified), true)
  answer('promptRequired')
  await settle()
  assert.equal(h.promptCalls.length, 2, 'the late refusal changes nothing')
  assert.equal(h.events.filter((event) => event.kind === 'user' && event.text === NOTE).length, 1)
  h.endTurn()
  await settle()
  assert.deepEqual(partsOf(h.promptCalls[2]), ['queued'])
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('a closed delivery gate holds a notification, and resumeDelivery delivers it ahead of the queue', async () => {
  let held = true
  const h = await setup('openclaw', { shouldHoldDelivery: () => held })
  await h.client.prompt(h.sessionId, 'waiting', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  const notified = h.client.notify(h.sessionId, NOTE)
  assert.equal(await outcomeOf(notified), 'pending', 'nothing starts a turn while the host holds delivery')
  assert.deepEqual(h.promptCalls, [])
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(h.promptCalls, [NOTE], 'the wake delivers the notification first, as its own turn')
  assert.equal(await outcomeOf(notified), true)
  h.endTurn()
  await settle()
  assert.deepEqual(partsOf(h.promptCalls[1]), ['waiting'], 'and the queue once that turn settles')
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('a closed delivery gate holds a notification even from a turn that could take it', async () => {
  let held = false
  const h = await setup('openclaw', { steeringSupported: true, shouldHoldDelivery: () => held })
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  held = true
  const notified = h.client.notify(h.sessionId, NOTE)
  assert.equal(await outcomeOf(notified), 'pending')
  assert.deepEqual(h.extMethodCalls, [], 'an injection is a hand-over too')
  h.endTurn()
  await settle()
  assert.equal(h.promptCalls.length, 1, 'and the settlement starts no turn under the gate')
  held = false
  h.client.resumeDelivery()
  await settle()
  assert.deepEqual(h.promptCalls.slice(1), [NOTE])
  assert.equal(await outcomeOf(notified), true)
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('a notification is never part of the queue: no snapshot, no durable row, not counted', async () => {
  const appended: string[] = []
  const durable: QueueStore = {
    append: (_key, entry) => {
      appended.push(entry.text)
    },
    remove: () => {},
    clear: () => {},
    load: () => [],
  }
  const h = await setup('openclaw', { sessionKey: `notify-unqueued-${counter}`, queueStore: durable })
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'waiting', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  const notified = h.client.notify(h.sessionId, NOTE)
  assert.equal(h.client.listSessions().find((meta) => meta.id === h.sessionId)?.queuedMessages, 1, 'only the message')
  h.endTurn()
  await settle()
  assert.equal(await outcomeOf(notified), true)
  h.endTurn()
  await settle()
  assert.ok(
    queueSnapshots(h.events).every((items) => !items.includes(NOTE)),
    'no queue snapshot -- and so no unread list -- ever carried it',
  )
  assert.deepEqual(appended, ['working', 'waiting'], 'nothing durable was written for it')
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})

test('a notification still held when its session is dropped is answered false, as is one for no session', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  const notified = h.client.notify(h.sessionId, NOTE)
  assert.equal(await outcomeOf(notified), 'pending')
  await h.client.deleteSession(h.sessionId)
  assert.equal(await outcomeOf(notified), false, 'answered, not stranded: the host tries again later')
  assert.equal(await h.client.notify(h.sessionId, NOTE), false, 'a session that is gone')
  assert.equal(await h.client.notify('no-such-session', NOTE), false, 'or was never here')
})

test('reset answers false for a notification held and for one out for a steer', async () => {
  let answer: (outcome: string) => void = () => {}
  const h = await setup('openclaw', {
    steeringSupported: true,
    steerOutcome: new Promise<string>((resolve) => {
      answer = resolve
    }),
  })
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await settle()
  const steering = h.client.notify(h.sessionId, 'out for a steer')
  const waiting = h.client.notify(h.sessionId, 'held behind it')
  await h.client.reset()
  assert.deepEqual([await outcomeOf(steering), await outcomeOf(waiting)], [false, false])
  // The harness's late answer lands on a session that no longer exists.
  answer('injected')
  await settle()
  assert.deepEqual([await steering, await waiting], [false, false], 'an answer once given stands')
})

test('an empty notification starts no turn and is not reported as delivered', async () => {
  const h = await setup('openclaw')
  assert.equal(await h.client.notify(h.sessionId, ' \n '), false)
  assert.deepEqual(h.promptCalls, [])
  await h.client.deleteSession(h.sessionId)
})

// ── Codex session lifecycle: fork, resume, load ────────────────────────────
//
// Contract tests against codex-acp 1.13.1, each fixture spelled the way that
// source spells it (file named per fixture). Nothing here ran against a live
// Codex: the harness is modelled on the source, not recorded from it.

// Every agent message in the log, one turn each, streamed in the chunks given.
// A chunk without an id is sent without one, as a harness notice would be.
async function historyOf(
  h: Awaited<ReturnType<typeof setup>>,
  turns: Array<Array<{ text: string; messageId?: string } | { subagentText: string }>>,
): Promise<void> {
  const push = (sessionId: string, update: Record<string, unknown>) =>
    handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
  for (const [index, chunks] of turns.entries()) {
    await h.client.prompt(h.sessionId, `turn ${index}`, {
      queue: 'wait',
      origin: { kind: 'message', sender: 'Reader' },
    })
    for (const chunk of chunks) {
      if ('subagentText' in chunk) {
        const childId = `${h.sessionId}:subagent:${index}`
        push(h.sessionId, {
          sessionUpdate: 'subagent_spawned',
          subagentSessionId: childId,
          name: 'Helper',
          task: 'help',
          capabilities: {},
        })
        push(childId, {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk.subagentText },
          messageId: `${childId}:msg`,
        })
        continue
      }
      push(h.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: chunk.text },
        ...(chunk.messageId ? { messageId: chunk.messageId } : {}),
      })
    }
    h.endTurn()
    await settle()
  }
}

function forkPointOf(call: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return (call?._meta as { jetbrains?: { air?: { fork?: Record<string, unknown> } } } | undefined)?.jetbrains?.air?.fork
}

test('a fork point names its anchor by content too: the fingerprint of the whole message and its occurrence', async () => {
  // codex-acp SessionFork.ts falls back to messageFingerprint/messageOccurrence
  // when the message id is gone from its thread; its own test ("maps a
  // persisted AIR message fingerprint when Codex item ids changed",
  // __tests__/CodexACPAgent/CodexAcpClient.test.ts) forks at the SECOND of two
  // "Same answer" messages with exactly this fingerprint and occurrence 2.
  // The same literal here is the cross-check that both sides hash the same
  // bytes.
  const h = await setup('openclaw', { forkSupported: true })
  await historyOf(h, [
    // Streamed in two chunks: the fingerprint is of the joined message, not
    // of a chunk.
    [
      { text: 'Same ', messageId: 'item-1' },
      { text: 'answer', messageId: 'item-1' },
    ],
    // Identical texts that are NOT agent messages of this session must not
    // count: a subagent's own message, and a chunk the harness sent without
    // an id (neither harness can match one).
    [{ subagentText: 'Same answer' }, { text: 'Same answer' }, { text: 'Other answer', messageId: 'item-2' }],
    [{ text: 'Same answer', messageId: 'item-3' }],
    [{ text: 'Later', messageId: 'item-4' }],
  ])

  await h.client.forkSession(h.sessionId, 3)

  assert.deepEqual(forkPointOf(h.forkCalls[0]), {
    version: 1,
    messageId: 'item-3',
    messageFingerprint: 'sha256:41153d2b46c2869f4021958d44dac18888247fd999507c28970be299a8de4a0f',
    messageOccurrence: 2,
  })
  await h.client.deleteSession(h.sessionId)
})

test('the first of two identical messages is occurrence 1, and a later duplicate does not move it', async () => {
  // claude-agent-acp 0.79.0 (fork-session.js) counts along the branch UP TO
  // the target, so a duplicate after the anchor is not part of its count
  // either; codex-acp takes the Nth match in thread order, which agrees.
  const h = await setup('openclaw', { forkSupported: true })
  await historyOf(h, [[{ text: 'Same answer', messageId: 'item-1' }], [{ text: 'Same answer', messageId: 'item-2' }]])

  await h.client.forkSession(h.sessionId, 1)

  const point = forkPointOf(h.forkCalls[0])
  assert.equal(point?.messageId, 'item-1')
  assert.equal(point?.messageOccurrence, 1)
  await h.client.deleteSession(h.sessionId)
})

// codex-acp's modes, as AgentMode.toSessionModeState() spells them
// (src/AgentMode.ts).
const CODEX_MODES = [
  {
    id: 'read-only',
    name: 'Ask for approval',
    description: 'Always ask to edit external files and use the internet',
    _meta: { kind: 'standard' },
  },
  {
    id: 'agent',
    name: 'Approve for me',
    description: 'Only ask for actions detected as potentially unsafe',
    _meta: { kind: 'auto_review' },
  },
  {
    id: 'agent-full-access',
    name: 'Full access',
    description: 'Unrestricted access to the internet and any file on your computer',
    _meta: { kind: 'full_access' },
  },
]

// codex-acp's config options for a session state: AgentMode.toConfigOption()
// (src/AgentMode.ts) and createModelConfigOption (src/ModelConfigOption.ts),
// in the order CodexAcpServer.createSessionConfigOptions lists them.
function codexConfigOptions(state: { mode: string; model: string }) {
  return [
    {
      id: 'mode',
      name: 'Mode',
      description: 'Approval and sandboxing preset for the session',
      category: 'mode',
      type: 'select',
      currentValue: state.mode,
      options: CODEX_MODES.map((mode) => ({
        value: mode.id,
        name: mode.name,
        description: mode.description,
        _meta: mode._meta,
      })),
    },
    {
      id: 'model',
      name: 'Model',
      description: 'Model Codex uses for the session',
      category: 'model',
      type: 'select',
      currentValue: state.model,
      options: [
        { value: 'gpt-5', name: '5', description: null },
        { value: 'gpt-5-codex', name: '5 Codex', description: null },
      ],
    },
  ]
}

// What the host logged for a Codex session the reader had put on `mode`.
function recordedCodexSession(mode: string, available = CODEX_MODES): ChatEvent[] {
  return [
    {
      kind: 'modes',
      available: available.map((entry) => ({ id: entry.id, name: entry.name, description: entry.description })),
      current: mode,
    },
    { kind: 'config_options', options: codexConfigOptions({ mode, model: 'gpt-5' }) } as ChatEvent,
    { kind: 'user', text: 'fix it' },
    { kind: 'agent_message', text: 'fixed', messageId: 'item-1' },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
}

// A connection that behaves like codex-acp 1.13.1 across a resume:
// tryCreateSession (CodexAcpServer.ts) installs a fresh SessionState on every
// session/resume with `agentMode: AgentMode.getInitialAgentMode()` — `agent`
// unless INITIAL_AGENT_MODE says otherwise — while the model comes back from
// the thread; resumeSession answers with `modes` and `configOptions` built
// from that state. setSessionMode and the `mode` config option both write
// the same agentMode (applyModeChange), and neither sends a notification.
//
// `keepsState` models the other kind of harness: one whose resume of a live
// session answers with what it already had (claude-agent-acp 0.79.0,
// getOrCreateSession, when the resume changes nothing).
function codexSetup(
  options: { closeSupported?: boolean; refuseMode?: boolean; keepsState?: boolean; startMode?: string } = {},
) {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
    sessionKey: `codex-key-${counter}`,
  }
  const sessionId = `codex-thread-${counter}`
  const state = { mode: options.startMode ?? 'agent', model: 'gpt-5' }
  const wire: string[] = []
  const setMode = (modeId: string) => {
    if (options.refuseMode) {
      throw new Error('Invalid params')
    }
    state.mode = modeId
  }
  const connection = {
    resumeSession: async () => {
      wire.push('resume')
      if (!options.keepsState) {
        state.mode = 'agent'
      }
      return {
        modes: { availableModes: CODEX_MODES, currentModeId: state.mode },
        configOptions: codexConfigOptions(state),
      }
    },
    closeSession: async () => {
      wire.push('close')
      return {}
    },
    setSessionMode: async (params: { modeId: string }) => {
      wire.push(`mode:${params.modeId}`)
      setMode(params.modeId)
      return {}
    },
    setSessionConfigOption: async (params: { configId: string; value: string }) => {
      wire.push(`config:${params.configId}=${params.value}`)
      if (params.configId === 'mode') {
        setMode(params.value)
      } else {
        state.model = params.value
      }
      return { configOptions: codexConfigOptions(state) }
    },
  } as unknown as AgentConnection
  acpStore().connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: true,
    resumeSession: true,
    forkSupported: false,
    closeSupported: options.closeSupported === true,
    initialized: Promise.resolve(),
  })
  const observed: ChatEvent[] = []
  const client = createAgentClient({ onEvent: (_sessionId, event) => observed.push(event) })
  return { client, sessionId, selection, wire, state, observed }
}

function storedConfigOptions(sessionId: string): unknown {
  return (acpStore().sessions.get(sessionId) as { configOptions: unknown }).configOptions
}

test('a restored Codex session gets back the mode its log recorded, not the one the harness restarted on', async () => {
  const h = codexSetup()

  await h.client.restoreSession(h.sessionId, h.selection, recordedCodexSession('read-only'))

  // The mode travels both ways Codex takes it; neither answer tells us the
  // other changed, so both are set. Both write one field, so the second is a
  // no-op on the harness.
  assert.deepEqual(h.wire, ['resume', 'mode:read-only', 'config:mode=read-only'])
  assert.equal(h.state.mode, 'read-only', 'the harness runs on the logged choice again')
  assert.equal(h.client.sessionModes(h.sessionId)?.current, 'read-only')
  assert.deepEqual(storedConfigOptions(h.sessionId), codexConfigOptions({ mode: 'read-only', model: 'gpt-5' }))
  // The end state is the logged one, so nothing is appended to the host log:
  // a snapshot per reopen would grow every Codex chat each time it opened.
  assert.deepEqual(
    h.observed.filter((event) => event.kind === 'modes' || event.kind === 'config_options' || event.kind === 'error'),
    [],
  )
  await h.client.deleteSession(h.sessionId)
})

test('a harness that kept its state is sent nothing after a resume', async () => {
  // The Claude bridge answers a resume of an unchanged live session with the
  // modes and options it already had: nothing differs, nothing is set.
  const h = codexSetup({ keepsState: true, startMode: 'read-only' })

  await h.client.restoreSession(h.sessionId, h.selection, recordedCodexSession('read-only'))

  assert.deepEqual(h.wire, ['resume'])
  assert.deepEqual(h.observed, [])
  await h.client.deleteSession(h.sessionId)
})

test('a logged choice the harness no longer offers gives way to what the harness reports', async () => {
  const retired = [
    ...CODEX_MODES,
    { id: 'retired', name: 'Retired', description: 'Gone in this version', _meta: { kind: 'standard' } },
  ]
  const h = codexSetup()

  await h.client.restoreSession(h.sessionId, h.selection, recordedCodexSession('retired', retired))

  assert.deepEqual(h.wire, ['resume'], 'nothing is asked for that the harness does not offer')
  assert.equal(h.client.sessionModes(h.sessionId)?.current, 'agent', 'the reader sees what actually runs')
  const modes = h.observed.filter((event) => event.kind === 'modes')
  assert.equal(modes.length, 1, 'and the log learns it once')
  assert.equal(modes[0].kind === 'modes' && modes[0].current, 'agent')
  await h.client.deleteSession(h.sessionId)
})

test('a harness that refuses the logged choice keeps its own, and the chat says so', async () => {
  const h = codexSetup({ refuseMode: true })

  await h.client.restoreSession(h.sessionId, h.selection, recordedCodexSession('read-only'))

  assert.equal(h.client.sessionModes(h.sessionId)?.current, 'agent', 'not the choice the harness turned down')
  const configMode = (storedConfigOptions(h.sessionId) as Array<{ id: string; currentValue: unknown }>).find(
    (option) => option.id === 'mode',
  )
  assert.equal(configMode?.currentValue, 'agent')
  const errors = h.observed.filter((event) => event.kind === 'error')
  assert.equal(errors.length, 1)
  assert.match(errors[0].kind === 'error' ? errors[0].message : '', /read-only/)
  await h.client.deleteSession(h.sessionId)
})

test('an MCP refresh resume puts the logged choice back too', async () => {
  const h = codexSetup()
  await h.client.restoreSession(h.sessionId, h.selection, recordedCodexSession('read-only'))
  h.wire.length = 0

  await h.client.resumeSession(h.sessionId)

  assert.deepEqual(
    h.wire,
    ['resume', 'mode:read-only', 'config:mode=read-only'],
    'no close: the adapter did not opt in',
  )
  assert.equal(h.client.sessionModes(h.sessionId)?.current, 'read-only')
  await h.client.deleteSession(h.sessionId)
})

test('an adapter that opts in closes before the refresh resume, and only when the agent can close', async () => {
  const adapter = findAdapter('openclaw')
  assert.ok(adapter)
  adapter.mcpRefreshReopens = true
  try {
    const closing = codexSetup({ closeSupported: true })
    await closing.client.restoreSession(closing.sessionId, closing.selection, recordedCodexSession('read-only'))
    closing.wire.length = 0
    await closing.client.resumeSession(closing.sessionId)
    assert.deepEqual(closing.wire.slice(0, 2), ['close', 'resume'])
    assert.equal(closing.client.sessionModes(closing.sessionId)?.current, 'read-only')
    await closing.client.deleteSession(closing.sessionId)

    const unable = codexSetup({ closeSupported: false })
    await unable.client.restoreSession(unable.sessionId, unable.selection, recordedCodexSession('read-only'))
    unable.wire.length = 0
    await unable.client.resumeSession(unable.sessionId)
    assert.equal(unable.wire[0], 'resume', 'an agent that never advertised close is not sent one')
    await unable.client.deleteSession(unable.sessionId)
  } finally {
    delete adapter.mcpRefreshReopens
  }
})

test('a Codex session/load replay rebuilds the transcript and seeds modes and options from the answer', async () => {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/agent-client-test-${counter}`,
  }
  const sessionId = `codex-loaded-${counter}`
  const push = (update: Record<string, unknown>) =>
    handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
  const connection = {
    // CodexAcpServer.loadSession streams each thread item through
    // createHistoryUpdates, then answers with models, modes and options.
    loadSession: async () => {
      // userMessage -> createUserMessageChunk (src/ContentChunks.ts)
      push({ sessionUpdate: 'user_message_chunk', messageId: 'item-user-1', content: { type: 'text', text: 'Fix it' } })
      // reasoning -> createAgentTextThoughtChunk, one per summary part
      push({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'item-reasoning-1',
        content: { type: 'text', text: 'Reading the failing step' },
      })
      // commandExecution -> createCommandExecutionUpdate +
      // createCommandExecutionCompleteUpdate (src/CodexToolCallMapper.ts)
      push({
        sessionUpdate: 'tool_call',
        toolCallId: 'item-cmd-1',
        kind: 'execute',
        title: 'npm test',
        status: 'completed',
        content: [{ type: 'terminal', terminalId: 'item-cmd-1' }],
        rawInput: { command: 'npm test', cwd: '/workspace' },
        _meta: { terminal_info: { cwd: '/workspace', terminal_id: 'item-cmd-1' } },
      })
      push({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'item-cmd-1',
        status: 'completed',
        rawOutput: { formatted_output: 'ok', exit_code: 0 },
      })
      // agentMessage -> one agent_message_chunk carrying the whole text
      push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'item-agent-1',
        content: { type: 'text', text: 'Fixed.' },
        _meta: { codex: { phase: 'final_answer' } },
      })
      // plan -> createPlanHistoryUpdate: a client that did not declare the
      // `plan` capability (this one does not) gets the plan as an agent
      // message in the final_answer phase, under the plan item's id.
      push({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'item-plan-1',
        content: { type: 'text', text: '1. Ship it' },
        _meta: { codex: { phase: 'final_answer' } },
      })
      // contextCompaction -> createCompactionUpdate (src/CodexSessionCompactions.ts),
      // since this client declares session.compaction
      push({ sessionUpdate: 'compaction_update', compactionId: 'item-compact-1', status: 'completed' })
      return {
        modes: { availableModes: CODEX_MODES, currentModeId: 'agent' },
        configOptions: codexConfigOptions({ mode: 'agent', model: 'gpt-5' }),
      }
    },
  } as unknown as AgentConnection
  acpStore().connections.set(JSON.stringify(buildSpawnConfig(selection)), {
    connection,
    lastSessionId: null,
    loadSession: true,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient()

  assert.ok(await client.loadSession(sessionId, selection))

  const events = sessionEvents(sessionId)
  const conversation = events.filter((event) =>
    ['user', 'agent_thought', 'tool_call', 'tool_update', 'agent_message', 'compaction'].includes(event.kind),
  )
  assert.deepEqual(kinds(conversation), [
    'user',
    'agent_thought',
    'tool_call',
    'tool_update',
    'agent_message',
    'agent_message',
    'compaction',
  ])
  // The ids survive: they are what a later fork point names.
  assert.deepEqual(
    conversation.map((event) => ('messageId' in event ? event.messageId : undefined)),
    ['item-user-1', 'item-reasoning-1', undefined, undefined, 'item-agent-1', 'item-plan-1', undefined],
  )
  const compaction = conversation.at(-1)
  assert.equal(compaction?.kind === 'compaction' && compaction.compaction.status, 'completed')
  // A replay that ends on a settled compaction closed its turn.
  assert.deepEqual(events.at(-1), { kind: 'turn_end', stopReason: 'replayed' })
  // Codex replays no current_mode_update, so the answer is the only source.
  assert.equal(client.sessionModes(sessionId)?.current, 'agent')
  assert.deepEqual(storedConfigOptions(sessionId), codexConfigOptions({ mode: 'agent', model: 'gpt-5' }))
  await client.deleteSession(sessionId)
})

// Last in the file, after the reset above: refreshMcpServers resumes EVERY
// session in the process-wide store, and this keeps that set to the one below.
test('a deferred MCP resume still runs first, then the held notification, then the queue', async () => {
  const h = await setup('openclaw')
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.prompt(h.sessionId, 'waiting', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } })
  await h.client.refreshMcpServers()
  const notified = h.client.notify(h.sessionId, NOTE)
  h.endTurn()
  await settle()
  assert.deepEqual(h.wire, ['prompt', 'resume', 'prompt'], 'the resume first, and only then a turn over its connection')
  assert.equal(h.promptCalls[1], NOTE)
  assert.equal(await outcomeOf(notified), true)
  h.endTurn()
  await settle()
  assert.deepEqual(partsOf(h.promptCalls[2]), ['waiting'])
  h.endTurn()
  await settle()
  await h.client.deleteSession(h.sessionId)
})
