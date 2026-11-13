import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import { RequestError } from '@agentclientprotocol/sdk'

import { connectionKey, createAgentClient, handleUpdate } from './agent-client'
import type { AgentConnection } from './connection'
import type { AgentSelection, ChatEvent } from './types'

// ── Copilot CLI 1.0.95 session lifecycle: load, resume, fork, mid-turn input ─
//
// What 1.0.95 does, measured against the real `@github/copilot@1.0.95 --acp`
// driven by a scripted OpenAI-compatible model:
//  - initialize advertises `loadSession` and `sessionCapabilities {close,
//    list}`: no `resume`, no `fork`, no steering;
//  - `session/resume` and `session/fork` answer -32601 "Method not found";
//  - `session/load` of a session the process holds answers -32602 "Session …
//    is already loaded"; after `session/close` it loads, connects the MCP
//    servers it is given, and answers with the mode and options the session
//    was on. Before the answer it replays the conversation as user and agent
//    chunks, tool calls and their updates, and a `current_mode_update`; after
//    it, it announces the session's commands (`available_commands_update`);
//  - a second `session/prompt` during a turn cancels the running one.
// The mock connection below answers the same way. It is seeded under the real
// `copilot` adapter's spawn key, so the engine reads the adapter's own flags.

interface AcpStoreShape {
  connections: Map<string, unknown>
  sessions: Map<string, { attachedTo?: AgentConnection; events: ChatEvent[] }>
}

function acpStore(): AcpStoreShape {
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  return store
}

const MODE_URL = 'https://agentclientprotocol.com/protocol/session-modes#'
const MODES = ['agent', 'plan', 'autopilot'].map((name) => ({ id: `${MODE_URL}${name}`, name }))

const configOptions = (mode: string, allowAll: string) => [
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: `${MODE_URL}${mode}`,
    options: MODES.map((entry) => ({ value: entry.id, name: entry.name })),
  },
  {
    id: 'allow_all',
    name: 'Allow all',
    category: 'permissions',
    type: 'select',
    currentValue: allowAll,
    options: [
      { value: 'on', name: 'On' },
      { value: 'off', name: 'Off' },
    ],
  },
]

let counter = 0

const update = (sessionId: string, body: Record<string, unknown>) =>
  handleUpdate({ sessionId, update: body } as Parameters<typeof handleUpdate>[0])

const textOfPrompt = (prompt: Array<{ type: string; text?: string }>) =>
  prompt.filter((block) => block.type === 'text').at(-1)?.text ?? ''

// One Copilot process: the sessions it holds, and every request it received.
// `loadGates` hold the loads open in turn, each after the replay's first
// update, until the test releases them.
function copilotProcess(
  state: { mode: string; allowAll: string },
  held: Set<string>,
  loadGates: Array<Promise<void>> = [],
) {
  const wire: string[] = []
  const loads: Array<{ sessionId: string; mcpServers: unknown[] }> = []
  const turns: Array<(response: Record<string, unknown>) => void> = []
  const connection = {
    newSession: async () => {
      const sessionId = `copilot-lifecycle-session-${counter}`
      held.add(sessionId)
      return {
        sessionId,
        modes: { availableModes: MODES, currentModeId: `${MODE_URL}${state.mode}` },
        configOptions: configOptions(state.mode, state.allowAll),
      }
    },
    // A turn answers at once with one reply chunk, and ends when the test
    // ends it.
    prompt: (params: { sessionId: string; prompt: Array<{ type: string; text?: string }> }) => {
      wire.push('prompt')
      if (!held.has(params.sessionId)) {
        return Promise.reject(RequestError.resourceNotFound(params.sessionId))
      }
      update(params.sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: `reply to ${textOfPrompt(params.prompt)}` },
      })
      return new Promise((resolve) => {
        turns.push(resolve as (response: Record<string, unknown>) => void)
      })
    },
    resumeSession: async () => {
      wire.push('resume')
      throw RequestError.methodNotFound('session/resume')
    },
    unstable_forkSession: async () => {
      wire.push('fork')
      throw RequestError.methodNotFound('session/fork')
    },
    closeSession: async (params: { sessionId: string }) => {
      wire.push('close')
      held.delete(params.sessionId)
      return {}
    },
    loadSession: async (params: { sessionId: string; mcpServers: unknown[] }) => {
      wire.push('load')
      if (held.has(params.sessionId)) {
        throw RequestError.invalidParams(undefined, `Session ${params.sessionId} is already loaded`)
      }
      held.add(params.sessionId)
      loads.push({ sessionId: params.sessionId, mcpServers: params.mcpServers })
      const gate = loadGates.shift()
      // The replay goes out ahead of the answer, as notifications.
      const replay = [
        { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first message' } },
        { sessionUpdate: 'tool_call', toolCallId: 'replayed-call', title: 'echo', status: 'pending' },
        { sessionUpdate: 'tool_call_update', toolCallId: 'replayed-call', status: 'completed' },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'first reply' } },
        { sessionUpdate: 'current_mode_update', currentModeId: `${MODE_URL}${state.mode}` },
      ]
      for (const [index, body] of replay.entries()) {
        update(params.sessionId, body)
        if (index === 0 && gate) {
          await gate
        }
      }
      // State the loaded session announces. 1.0.95 sent its commands after
      // the answer; sending them before it is the case the reload must let
      // through.
      update(params.sessionId, {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'probe-command', description: 'from the reload' }],
      })
      return {
        modes: { availableModes: MODES, currentModeId: `${MODE_URL}${state.mode}` },
        configOptions: configOptions(state.mode, state.allowAll),
      }
    },
    setSessionConfigOption: async (params: { configId: string; value: string }) => {
      if (params.configId === 'allow_all') {
        state.allowAll = params.value
      }
      return { configOptions: configOptions(state.mode, state.allowAll) }
    },
    setSessionMode: async (params: { modeId: string }) => {
      state.mode = params.modeId.slice(MODE_URL.length)
      return {}
    },
    cancel: async () => {
      turns.shift()?.({ stopReason: 'cancelled' })
    },
  } as unknown as AgentConnection
  return {
    connection,
    wire,
    loads,
    endTurn: () => turns.shift()?.({ stopReason: 'end_turn' }),
  }
}

function seed(selection: AgentSelection, process: ReturnType<typeof copilotProcess>, closeSupported = true): void {
  acpStore().connections.set(connectionKey(selection), {
    connection: process.connection,
    lastSessionId: null,
    // As 1.0.95 advertises at initialize.
    loadSession: true,
    resumeSession: false,
    forkSupported: false,
    closeSupported,
    steeringSupported: false,
    initialized: Promise.resolve(),
  })
}

async function copilotSetup(
  t: TestContext,
  options: { closeSupported?: boolean; loadGates?: Array<Promise<void>> } = {},
) {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'zai',
    adapterId: 'copilot',
    model: 'glm-5.3',
    apiKey: 'test-key',
    cwd: `/tmp/copilot-lifecycle-${counter}`,
  }
  const state = { mode: 'agent', allowAll: 'off' }
  const held = new Set<string>()
  const first = copilotProcess(state, held, options.loadGates)
  seed(selection, first, options.closeSupported ?? true)
  const client = createAgentClient()
  t.after(() => client.reset())
  const meta = await client.createSession(selection)
  return { client, selection, state, held, meta, sessionId: meta.id, process: first }
}

function gate(): { opened: Promise<void>; open: () => void } {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { opened, open }
}

// How long one wait may take before it fails its test. Measured 2026-10-29,
// the whole file ran in about a second on an idle machine and in at most 18
// seconds for all nine tests with the machine saturated; the bound only stops
// a wait whose event never comes from holding the file open.
const WAIT_MS = 5_000

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_MS
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out after ${WAIT_MS} ms waiting for ${what}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// For a check that something did NOT happen. A prompt held behind a load emits
// nothing to wait for, so this is a window in which a wrong send would show.
// Load can only make it miss a defect, never fail a correct run.
const quietWindow = () => new Promise((resolve) => setTimeout(resolve, 20))

// Every test has room for several waits; the bound turns a wait the test does
// not guard into a failure of that test instead of a stalled file.
const BOUNDED = { timeout: 30_000 }

// Each test's reset() runs in its `after` hook, so a failed test also closes
// the client's MCP server, whose listening socket would keep this process
// alive. Should anything else still hold the process once every test has run,
// it fails the file instead of leaving it asleep. Unref'd: a process that ends
// on its own never sees it fire.
const EXIT_GRACE_MS = 30_000
test.after(() => {
  setTimeout(() => {
    console.error(
      `the tests have ended, but after ${EXIT_GRACE_MS} ms this process is still held open by`,
      process.getActiveResourcesInfo(),
    )
    process.exit(1)
  }, EXIT_GRACE_MS).unref()
})

const turnEnds = (h: { client: ReturnType<typeof createAgentClient>; sessionId: string }) =>
  (h.client.getSessionEvents(h.sessionId) ?? []).filter((event) => event.kind === 'turn_end').length

const conversation = (events: readonly ChatEvent[]) =>
  events.filter((event) => event.kind === 'user' || event.kind === 'agent_message')

const transcript = (events: readonly ChatEvent[]) =>
  events.filter((event) => ['user', 'agent_message', 'tool_call', 'tool_update'].includes(event.kind))

const errors = (events: readonly ChatEvent[]) => events.filter((event) => event.kind === 'error')

const textsOf = (events: readonly ChatEvent[]) =>
  conversation(events).map((event) => `${event.kind}: ${'text' in event ? event.text : ''}`)

test('a changed MCP list reaches a live Copilot session by close and load, without an error or a second copy of the history', BOUNDED, async (t) => {
  const h = await copilotSetup(t)
  await h.client.setMode(h.sessionId, `${MODE_URL}plan`)
  await h.client.setConfigOption(h.sessionId, 'allow_all', 'on')
  await h.client.prompt(h.sessionId, 'first message', { queue: 'wait', origin: { kind: 'system' } })
  h.process.endTurn()
  await until(() => turnEnds(h) === 1, 'the first turn to end')
  const before = [...(h.client.getSessionEvents(h.sessionId) ?? [])]

  await h.client.refreshMcpServers()

  assert.deepEqual(h.process.wire.slice(1), ['close', 'load'], 'no session/resume: Copilot has none')
  assert.equal(h.process.loads.length, 1)
  assert.ok(Array.isArray(h.process.loads[0].mcpServers), 'the load carries the current MCP servers')
  const after = (h.client.getSessionEvents(h.sessionId) ?? []).slice(before.length)
  assert.deepEqual(errors(after), [])
  assert.deepEqual(transcript(after), [], 'the replay is not added to the conversation it repeats')
  assert.equal(h.client.sessionModes(h.sessionId)?.current, `${MODE_URL}plan`)
  assert.equal(
    h.client.sessionConfigOptions(h.sessionId)?.find((option) => option.id === 'allow_all')?.currentValue,
    'on',
  )

  // The session takes prompts again, on the same process.
  await h.client.prompt(h.sessionId, 'second message', { queue: 'wait', origin: { kind: 'system' } })
  h.process.endTurn()
  await until(() => turnEnds(h) === 2, 'the second turn to end')
  assert.deepEqual(h.process.wire.slice(-1), ['prompt'])
  assert.deepEqual(errors(h.client.getSessionEvents(h.sessionId) ?? []), [])
})

test('the commands a reloading Copilot session announces reach it while the replayed transcript does not', BOUNDED, async (t) => {
  const h = await copilotSetup(t)
  const before = (h.client.getSessionEvents(h.sessionId) ?? []).length

  await h.client.refreshMcpServers()

  const after = (h.client.getSessionEvents(h.sessionId) ?? []).slice(before)
  assert.deepEqual(transcript(after), [])
  assert.deepEqual(
    after.filter((event) => event.kind === 'available_commands'),
    [{ kind: 'available_commands', commands: [{ name: 'probe-command', description: 'from the reload' }] }],
  )
})

test('a prompt sent while a Copilot session reloads goes out after the load, and its reply is kept', BOUNDED, async (t) => {
  const load = gate()
  const h = await copilotSetup(t, { loadGates: [load.opened] })
  const before = (h.client.getSessionEvents(h.sessionId) ?? []).length

  const refreshed = h.client.refreshMcpServers()
  await until(() => h.process.loads.length === 1, 'the load to open')
  assert.deepEqual(h.process.wire, ['close', 'load'], 'the load is open')
  const sent = h.client.prompt(h.sessionId, 'during the load', { queue: 'wait', origin: { kind: 'system' } })
  await quietWindow()
  assert.deepEqual(h.process.wire, ['close', 'load'], 'the prompt waits for the load')

  load.open()
  await Promise.all([refreshed, sent])
  await until(() => h.process.wire.length === 3, 'the held prompt to go out')
  assert.deepEqual(h.process.wire, ['close', 'load', 'prompt'])
  h.process.endTurn()
  await until(() => turnEnds(h) === 1, 'the turn to end')

  const after = (h.client.getSessionEvents(h.sessionId) ?? []).slice(before)
  assert.deepEqual(errors(after), [])
  assert.deepEqual(textsOf(after), ['user: during the load', 'agent_message: reply to during the load'])
})

test('overlapping refreshes reload a Copilot session one after another, with no replayed copy', BOUNDED, async (t) => {
  const load = gate()
  const h = await copilotSetup(t, { loadGates: [load.opened] })
  const before = (h.client.getSessionEvents(h.sessionId) ?? []).length

  const first = h.client.refreshMcpServers()
  await until(() => h.process.loads.length === 1, 'the first load to open')
  assert.deepEqual(h.process.wire, ['close', 'load'], 'the first load is open')
  // Both arrive while the first load runs: the second queues behind it, and
  // the third joins the second, which has not read the MCP list yet.
  const second = h.client.refreshMcpServers()
  const third = h.client.refreshMcpServers()
  await quietWindow()
  assert.deepEqual(h.process.wire, ['close', 'load'], 'nothing reaches the session while it loads')

  load.open()
  await Promise.all([first, second, third])
  await until(() => h.process.loads.length === 2, 'the second load to answer')

  assert.deepEqual(h.process.wire, ['close', 'load', 'close', 'load'])
  const after = (h.client.getSessionEvents(h.sessionId) ?? []).slice(before)
  assert.deepEqual(errors(after), [])
  assert.deepEqual(transcript(after), [])
})

test('a Copilot reload waits for the running turn, so the close never cancels it', BOUNDED, async (t) => {
  const h = await copilotSetup(t)
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'system' } })

  await h.client.refreshMcpServers()
  assert.deepEqual(h.process.wire, ['prompt'], 'nothing reaches the session while its turn runs')

  h.process.endTurn()
  // The commands are the last thing the load sends before it answers.
  await until(
    () => (h.client.getSessionEvents(h.sessionId) ?? []).some((event) => event.kind === 'available_commands'),
    'the load the refresh left for the end of the turn',
  )
  assert.deepEqual(h.process.wire, ['prompt', 'close', 'load'])
  assert.deepEqual(errors(h.client.getSessionEvents(h.sessionId) ?? []), [])
})

test('a Copilot session whose process exited is loaded on the new one, and the conversation goes on', BOUNDED, async (t) => {
  const h = await copilotSetup(t)
  await h.client.prompt(h.sessionId, 'first message', { queue: 'wait', origin: { kind: 'system' } })
  h.process.endTurn()
  await until(() => turnEnds(h) === 1, 'the first turn to end')
  // The process is gone: a new one holds no session and owes nothing a close.
  h.held.clear()
  const next = copilotProcess(h.state, h.held)
  seed(h.selection, next)

  await h.client.prompt(h.sessionId, 'second message', { queue: 'wait', origin: { kind: 'system' } })
  next.endTurn()
  await until(() => turnEnds(h) === 2, 'the second turn to end')

  assert.deepEqual(next.wire, ['load', 'prompt'])
  const events = h.client.getSessionEvents(h.sessionId) ?? []
  assert.deepEqual(errors(events), [])
  assert.deepEqual(
    textsOf(events),
    [
      'user: first message',
      'agent_message: reply to first message',
      'user: second message',
      'agent_message: reply to second message',
    ],
    'the two turns, and no replayed copy of the first',
  )
})

test('without close advertised, a Copilot session is not reloaded', BOUNDED, async (t) => {
  // The process still holds the session and would refuse the load, so the
  // reload is not attempted; the resume is, and fails as Copilot answers it.
  const h = await copilotSetup(t, { closeSupported: false })

  await h.client.refreshMcpServers()

  assert.deepEqual(h.process.wire, ['resume'])
})

test('editing an earlier message is not offered on Copilot, and a fork is refused before it reaches the harness', BOUNDED, async (t) => {
  const h = await copilotSetup(t)
  assert.equal(h.meta.canFork, false)

  await assert.rejects(h.client.forkSession(h.sessionId, 0))
  assert.deepEqual(h.process.wire, [], 'no session/fork is sent')
})

test('a message sent while Copilot works waits for the turn to end, and is then delivered', BOUNDED, async (t) => {
  // A second session/prompt would cancel Copilot's running turn, so it must
  // never go out while one runs.
  const h = await copilotSetup(t)
  await h.client.prompt(h.sessionId, 'working', { queue: 'wait', origin: { kind: 'system' } })

  const answer = await h.client.prompt(h.sessionId, 'meanwhile', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  assert.deepEqual(answer, { interrupted: false })
  assert.deepEqual(h.process.wire, ['prompt'], 'held, not sent into the running turn')

  h.process.endTurn()
  await until(() => h.process.wire.length === 2, 'the held message to go out')
  assert.deepEqual(h.process.wire, ['prompt', 'prompt'])
  const delivered = conversation(h.client.getSessionEvents(h.sessionId) ?? [])
    .filter((event) => event.kind === 'user')
    .at(-1)
  assert.ok(delivered?.kind === 'user' && delivered.text.includes('meanwhile'))
  h.process.endTurn()
  await until(() => turnEnds(h) === 2, 'the delivered turn to end')
})
