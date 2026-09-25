// Advertised commands, from the wire to the session record.
//
// These run through the real ACP SDK connection and the real client wiring
// (interceptDraftSessionUpdates + buildClient) rather than calling handleUpdate
// by hand, because the one ordering question here -- does a list sent right
// behind the session/new answer reach a session that exists? -- is decided by
// how many microtasks separate the two on the client, and a direct call has
// none of them.

import assert from 'node:assert/strict'
import test from 'node:test'

import { type AvailableCommand, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

import {
  buildClient,
  connectionKey,
  createAgentClient,
  handleUpdate,
  interceptDraftSessionUpdates,
} from './agent-client'
import { HARNESS_ADAPTERS, type HarnessAdapter } from './harness-adapters'
import type { AgentSelection, ChatEvent } from './types'

// What codex-acp 1.13.1 advertises after session/new, load and resume: its
// built-ins in their own order (src/CodexCommands.ts, getBuiltinCommands), then
// one entry per configured skill named `$<skill>` with the skill's short
// description (src/CodexCommands.ts, buildAvailableCommands). The `plan` action
// ids are the constants of src/CollaborationModeConfig.ts. The skill is a
// placeholder; everything else is copied from those sources.
const CODEX_COMMANDS: AvailableCommand[] = [
  {
    name: 'plan',
    description: 'Turn plan mode on.',
    input: null,
    _meta: {
      commandAction: {
        kind: 'setConfigOption',
        configId: 'collaboration_mode',
        value: 'plan',
        resetValue: 'default',
        presentation: 'state',
      },
    },
  },
  { name: 'mcp', description: 'List configured Model Context Protocol (MCP) tools.', input: null },
  { name: 'skills', description: 'List available skills.', input: null },
  { name: 'status', description: 'Display session configuration and token usage.', input: null },
  {
    name: 'review',
    description: 'Review uncommitted changes, or review with custom instructions.',
    input: { hint: 'optional review instructions' },
  },
  { name: 'review-branch', description: 'Review changes relative to a base branch.', input: { hint: 'branch name' } },
  { name: 'review-commit', description: 'Review a specific commit.', input: { hint: 'commit sha' } },
  { name: 'compact', description: 'Summarize conversation to avoid hitting the context limit.', input: null },
  {
    name: 'goal',
    description: 'Set a goal to keep pursuing.',
    input: { hint: '[<objective>|clear|pause|resume]' },
    _meta: { commandAction: { kind: 'prefixPrompt', presentation: 'state' } },
  },
  { name: 'rename', description: 'Rename the current session.', input: { hint: 'new name' } },
  {
    name: 'logout',
    description: 'Sign out of Codex. This option is available when you are logged in via ChatGPT.',
    input: null,
  },
  { name: '$my-skill', description: 'Does the one thing this skill does', input: null },
]

// A table entry of its own, so a test can give it `hiddenCommands` without
// claiming anything about a real harness's entry. Removed again by `after`.
const ADAPTER: HarnessAdapter = {
  id: 'available-commands-test',
  label: 'Commands test harness',
  command: 'unused',
  args: [],
  protocol: 'openai',
  // No built-in MCP server to start and stop around each test.
  supportsTools: false,
}
HARNESS_ADAPTERS.push(ADAPTER)
test.after(() => {
  HARNESS_ADAPTERS.splice(HARNESS_ADAPTERS.indexOf(ADAPTER), 1)
})

interface StoreShape {
  connections: Map<string, unknown>
  sessions: Map<string, { commands: AvailableCommand[]; events: ChatEvent[] }>
}

function store(): StoreShape {
  const held = (globalThis as typeof globalThis & { __acpStore?: StoreShape }).__acpStore
  assert.ok(held, 'agent-client global store must exist after import')
  return held
}

const encoder = new TextEncoder()

// A harness on the far side of a real ndjson stream. It answers session/new
// and, when asked, puts the command list in the SAME write as the answer: the
// tightest the two can arrive once the client's event loop has fallen behind
// the pipe, and the case where the fewest microtasks stand between them.
function fakeHarness(sessionId: string, listWithAnswer: AvailableCommand[] | null) {
  const toClient = new TransformStream<Uint8Array, Uint8Array>()
  const toAgent = new TransformStream<Uint8Array, Uint8Array>()
  const writer = toClient.writable.getWriter()
  void (async () => {
    const reader = toAgent.readable.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        return
      }
      buffered += decoder.decode(value, { stream: true })
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const request = JSON.parse(buffered.slice(0, end)) as { id?: number; method?: string }
        buffered = buffered.slice(end + 1)
        if (request.method !== 'session/new') {
          // Anything else asked of it (a close on delete) gets an empty answer,
          // so no caller waits on a harness that will never reply.
          if (request.id !== undefined) {
            await writer.write(encoder.encode(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} })}\n`))
          }
          continue
        }
        let frames = `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { sessionId } })}\n`
        if (listWithAnswer) {
          frames += `${JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: { sessionUpdate: 'available_commands_update', availableCommands: listWithAnswer },
            },
          })}\n`
        }
        await writer.write(encoder.encode(frames))
      }
    }
  })()
  return new ClientSideConnection(
    () => buildClient(() => null, 'unused'),
    interceptDraftSessionUpdates(ndJsonStream(toAgent.writable, toClient.readable)),
  )
}

let counter = 0

async function openSession(listWithAnswer: AvailableCommand[] | null = null) {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: ADAPTER.id,
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/available-commands-test-${counter}`,
  }
  const sessionId = `commands-session-${counter}`
  store().connections.set(connectionKey(selection), {
    connection: fakeHarness(sessionId, listWithAnswer),
    lastSessionId: null,
    loadSession: false,
    resumeSession: false,
    steeringSupported: false,
    forkSupported: false,
    closeSupported: false,
    imagePrompt: false,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient({})
  const meta = await client.createSession(selection)
  assert.equal(meta.id, sessionId)
  return { client, sessionId }
}

function advertise(sessionId: string, availableCommands: AvailableCommand[]): void {
  handleUpdate({ sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands } })
}

function snapshots(sessionId: string): AvailableCommand[][] {
  const session = store().sessions.get(sessionId)
  assert.ok(session, 'session must exist in the store')
  return session.events
    .filter((event): event is Extract<ChatEvent, { kind: 'available_commands' }> => event.kind === 'available_commands')
    .map((event) => event.commands)
}

test('a list written together with the session/new answer lands on the session', async () => {
  // codex-acp starts publishing as it answers session/new, so the list is the
  // first thing behind the answer. If the record were put after anything that
  // yields, the list would be handled for a session that does not exist yet,
  // dropped, and never sent again.
  const { client, sessionId } = await openSession(CODEX_COMMANDS)
  // createSession itself goes on past registering the record, so the list may
  // be handled after it returns rather than before; a turn of the event loop
  // lets it land either way. Its arriving BEFORE the record is what fails.
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.deepEqual(store().sessions.get(sessionId)?.commands, CODEX_COMMANDS)
  assert.deepEqual(snapshots(sessionId), [CODEX_COMMANDS])
  await client.deleteSession(sessionId)
})

test('without hiddenCommands every advertised name passes through as spelled, `$` skills included', async () => {
  const { client, sessionId } = await openSession()
  advertise(sessionId, CODEX_COMMANDS)
  assert.deepEqual(store().sessions.get(sessionId)?.commands, CODEX_COMMANDS)
  assert.deepEqual(snapshots(sessionId), [CODEX_COMMANDS])
  await client.deleteSession(sessionId)
})

test("an adapter's hiddenCommands never reach the record or the event log", async () => {
  ADAPTER.hiddenCommands = ['logout']
  try {
    const { client, sessionId } = await openSession()
    advertise(sessionId, CODEX_COMMANDS)
    const expected = CODEX_COMMANDS.filter((command) => command.name !== 'logout')
    // The rest keeps the harness's own order: only the named entry is gone.
    assert.deepEqual(store().sessions.get(sessionId)?.commands, expected)
    assert.deepEqual(snapshots(sessionId), [expected])
    await client.deleteSession(sessionId)
  } finally {
    delete ADAPTER.hiddenCommands
  }
})
