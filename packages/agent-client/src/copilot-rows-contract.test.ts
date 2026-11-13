import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { connectionKey, createAgentClient, handleUpdate, type SessionActivity } from './agent-client'
import type { AgentConnection } from './connection'
import { foldEvents } from './fold'
import type { AgentSelection, ChatEvent, CompactionState } from './types'

// ── Copilot CLI 1.0.95 wire contract: compaction, plan, subagents, background ─
//
// Over ACP, Copilot 1.0.95 reports none of these four as such: no
// compaction_update, no populated plan, no subagent announcements, no
// async-task updates. These tests pin what it does send, and that each one
// takes the platform's fallback path without an error: ordinary tool cards,
// inline text, the turn itself standing for its background work. The last
// section pins its usage readings and its failed model calls.
//
// Every payload was recorded from the real `@github/copilot@1.0.95 --acp`
// driven by a scripted OpenAI-compatible model, with the client capabilities
// the engine declares. Paths and ids are replaced by neutral ones; shapes and
// texts are as recorded. The seams are those of codex-rows-contract.test.ts: a
// mock connection seeded under the real `copilot` adapter's spawn key, updates
// through handleUpdate, prompt responses through the connection's prompt.

interface AcpStoreShape {
  connections: Map<string, unknown>
  sessions: Map<string, unknown>
}

function acpStore(): AcpStoreShape {
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  return store
}

interface SessionShape {
  events: ChatEvent[]
  plan?: unknown[]
  usage?: { used: number; size?: number }
  compactions?: Map<string, CompactionState>
  subagents?: Map<string, unknown>
  asyncTasks?: Map<string, unknown>
}

function storedSession(sessionId: string): SessionShape {
  const session = acpStore().sessions.get(sessionId) as SessionShape | undefined
  assert.ok(session, 'session must exist in the store')
  return session
}

let counter = 0

function copilotSelection(overrides: Partial<AgentSelection>): AgentSelection {
  counter += 1
  return {
    providerId: 'zai',
    adapterId: 'copilot',
    model: 'glm-5.3',
    apiKey: 'test-key',
    cwd: `/tmp/copilot-contract-${counter}`,
    ...overrides,
  }
}

async function copilotSetup(overrides: Partial<AgentSelection> = {}) {
  const selection = copilotSelection(overrides)
  const turns: Array<(response: Record<string, unknown>) => void> = []
  const connection = {
    newSession: async () => ({ sessionId: `copilot-contract-session-${counter}` }),
    prompt: () =>
      new Promise((resolve) => {
        turns.push(resolve as (response: Record<string, unknown>) => void)
      }),
    cancel: async () => {
      // Copilot answers session/cancel by ending the open prompt `cancelled`.
      turns.shift()?.({ stopReason: 'cancelled' })
    },
  } as unknown as AgentConnection
  acpStore().connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const compactions: CompactionState[] = []
  const activity: SessionActivity[] = []
  const client = createAgentClient({
    onCompaction: (_sessionId, compaction) => compactions.push(compaction),
    onActivityChange: (reported) => activity.push(reported),
  })
  const meta = await client.createSession(selection)
  const events: ChatEvent[] = []
  client.subscribe(meta.id, (event) => events.push(event))
  return {
    client,
    sessionId: meta.id,
    events,
    compactions,
    activity,
    endTurnWith: (response: Record<string, unknown>) => turns.shift()?.(response),
  }
}

function push(sessionId: string, update: Record<string, unknown>): void {
  handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
}

// Let the promise chain after a resolved turn (turn_end, drain) run out.
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

function ofKind<K extends ChatEvent['kind']>(events: ChatEvent[], kind: K): Extract<ChatEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<ChatEvent, { kind: K }> => event.kind === kind)
}

// The transcript as a reader sees it: tool rows by title and status, text by kind.
function transcript(sessionId: string): string[] {
  return foldEvents(storedSession(sessionId).events).map((message) => {
    if (message.kind === 'tool') {
      return `tool ${message.title} ${message.status}`
    }
    return message.kind === 'assistant' || message.kind === 'user' ? `${message.kind} ${message.text}` : message.kind
  })
}

// The same end_turn response every recorded turn ended with.
const END_TURN = {
  stopReason: 'end_turn',
  usage: { inputTokens: 2000, outputTokens: 40, totalTokens: 2040, cachedReadTokens: 0, cachedWriteTokens: 0 },
}

const toolCall = (toolCallId: string, title: string, kind: string, rawInput: unknown, meta?: unknown) => ({
  sessionUpdate: 'tool_call',
  toolCallId,
  title,
  kind,
  status: 'pending',
  rawInput,
  ...(meta ? { _meta: meta } : {}),
})

const toolDone = (toolCallId: string, text: string, meta?: unknown) => ({
  sessionUpdate: 'tool_call_update',
  toolCallId,
  status: 'completed',
  content: [{ type: 'content', content: { type: 'text', text } }],
  rawOutput: { content: text, detailedContent: text },
  ...(meta ? { _meta: meta } : {}),
})

const agentText = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

// ── agent plan ──────────────────────────────────────────────────────────────

test("Copilot's todos stay ordinary sql tool cards, and its one empty plan draws no checklist", async () => {
  const h = await copilotSetup()
  await h.client.prompt(h.sessionId, 'track three steps', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  // The todos live in Copilot's own SQLite; its sql tool writes them. The
  // first write sends Copilot's only `plan` update, always empty; later writes
  // send none.
  const insert = "INSERT INTO todos (id, title, description) VALUES ('write-a', 'Writing a', 'Write a.txt')"
  push(h.sessionId, toolCall('call_insert', 'Insert probe todos', 'other', { description: 'Insert probe todos', query: insert }))
  push(h.sessionId, { sessionUpdate: 'plan', entries: [] })
  push(h.sessionId, toolDone('call_insert', '1 row(s) inserted. Last inserted row ID: 1.'))
  const start = "UPDATE todos SET status = 'in_progress' WHERE id = 'write-a'"
  push(h.sessionId, toolCall('call_start', 'Start write-a', 'other', { description: 'Start write-a', query: start }))
  push(h.sessionId, toolDone('call_start', '1 row(s) updated.'))
  push(h.sessionId, agentText('todos exercised'))
  h.endTurnWith(END_TURN)
  await settle()

  assert.deepEqual(
    ofKind(h.events, 'plan').map((event) => event.entries),
    [[]],
  )
  assert.deepEqual(storedSession(h.sessionId).plan, [], 'no checklist to draw')
  assert.deepEqual(transcript(h.sessionId), [
    'user track three steps',
    'tool Insert probe todos completed',
    'tool Start write-a completed',
    'assistant todos exercised',
  ])
  assert.deepEqual(ofKind(h.events, 'error'), [])
  await h.client.reset()
})

// ── subagents ───────────────────────────────────────────────────────────────

// Copilot tags a subagent's tool calls, and only those, with its agent id.
const SUB_A = { 'github.com/copilot': { agentId: 'agent-a' } }

test("a Copilot subagent renders inline in the parent's transcript, with no subagent record", async () => {
  const h = await copilotSetup()
  await h.client.prompt(h.sessionId, 'use a subagent', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  const task = { name: 'probe-a', agent_type: 'explore', description: 'Explore probe files', prompt: 'list the files', mode: 'sync' }
  push(h.sessionId, toolCall('call_task', 'Explore probe files', 'other', task))
  push(h.sessionId, toolCall('call_glob', 'Finding files matching *', 'read', { pattern: '*' }, SUB_A))
  push(h.sessionId, toolDone('call_glob', 'No files matched the pattern.', SUB_A))
  // The subagent's own words, untagged: nothing tells them from the parent's.
  push(h.sessionId, agentText('sub A found the files'))
  push(h.sessionId, toolDone('call_task', 'sub A found the files'))
  push(h.sessionId, agentText('parent saw sub A'))
  h.endTurnWith(END_TURN)
  await settle()

  assert.deepEqual(ofKind(h.events, 'subagent'), [])
  assert.deepEqual(ofKind(h.events, 'subagent_event'), [])
  assert.equal(storedSession(h.sessionId).subagents, undefined)
  const rows = transcript(h.sessionId)
  assert.deepEqual(rows.slice(0, 3), [
    'user use a subagent',
    'tool Explore probe files completed',
    'tool Finding files matching * completed',
  ])
  // Only a tool_call_update stands between the subagent's last words and the
  // parent's reply, and that does not end a text run, so the two may share one
  // assistant message. Both stay in the transcript.
  const text = rows.slice(3).join('\n')
  assert.ok(text.includes('sub A found the files') && text.includes('parent saw sub A'), text)
  assert.deepEqual(ofKind(h.events, 'error'), [])
  await h.client.reset()
})

test("a background Copilot subagent holds the parent's turn open until it is done, and Stop ends it", async () => {
  const h = await copilotSetup()
  await h.client.prompt(h.sessionId, 'use a background subagent', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  const task = { name: 'probe-b', agent_type: 'explore', description: 'Background probe', prompt: 'list', mode: 'background' }
  push(h.sessionId, toolCall('call_bg_task', 'Background probe', 'other', task))
  push(
    h.sessionId,
    toolDone('call_bg_task', "Agent started in background with agent_id: agent-b. You'll be notified when it completes."),
  )
  push(h.sessionId, agentText('started background agent'))
  await settle()
  assert.equal(h.client.hasActiveTurn(h.sessionId), true, 'the prompt is still open while the subagent works')

  await h.client.cancel(h.sessionId)
  await settle()
  const ends = ofKind(h.events, 'turn_end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].stopReason, 'cancelled')
  assert.equal(h.client.hasActiveTurn(h.sessionId), false)
  assert.ok(h.activity.every((reported) => !reported.backgroundWork), 'no background task is invented')
  await h.client.reset()
})

// ── background tasks ────────────────────────────────────────────────────────

const BG_SHELL = { command: 'sleep 10; echo bg-done', description: 'Sleep in the background', mode: 'async', shellId: 'bg1', initial_wait: 30 }

test('an attached Copilot background shell is the open turn itself, with no async task', async () => {
  const h = await copilotSetup()
  await h.client.prompt(h.sessionId, 'run in background', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  push(h.sessionId, toolCall('call_bash', 'Sleep in the background', 'execute', BG_SHELL))
  push(h.sessionId, toolDone('call_bash', '<command started in background with shellId: bg1>'))
  push(h.sessionId, agentText('started bg1'))
  await settle()
  assert.equal(h.client.hasActiveTurn(h.sessionId), true, 'Copilot keeps the prompt open while the shell runs')

  // When the command ends, Copilot reads it itself (a call id of its own) and
  // answers its own completion notice, inside the same turn.
  push(h.sessionId, toolCall('9a1b2c3d-0000-4000-8000-000000000001', 'Reading shell output', 'read', { shellId: 'bg1', delay: 0 }))
  push(h.sessionId, toolDone('9a1b2c3d-0000-4000-8000-000000000001', 'bg-done\n<shellId: bg1 completed with exit code 0>'))
  push(h.sessionId, agentText('bg1 is done'))
  h.endTurnWith(END_TURN)
  await settle()

  assert.deepEqual(ofKind(h.events, 'async_task'), [])
  assert.equal(storedSession(h.sessionId).asyncTasks, undefined)
  assert.ok(h.activity.every((reported) => !reported.backgroundWork))
  assert.equal(ofKind(h.events, 'turn_end').length, 1)
  assert.deepEqual(transcript(h.sessionId), [
    'user run in background',
    'tool Sleep in the background completed',
    'assistant started bg1',
    'tool Reading shell output completed',
    'assistant bg1 is done',
  ])
  await h.client.reset()
})

// Whether the shell outlives Stop depends on when the cancel lands. A cancel
// that aborts a model call in flight (the reply after the bash card is still
// being generated) ends Copilot's background shells with the turn: nothing
// arrives afterwards. A cancel while Copilot only holds the prompt open for
// the shell, with no model call running, leaves the shell running; this test
// is that case. Nothing on the wire says whether a model call is still
// running: reply text streams while the call is in flight, a call can end
// with no text, and ACP has no end-of-message signal. So the client cannot
// tell at Stop which of the two it is.
test("a shell that outlives Stop wakes Copilot into a turn of its own, kept in the transcript after the stopped one", async () => {
  const h = await copilotSetup()
  await h.client.prompt(h.sessionId, 'run in background', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  push(h.sessionId, toolCall('call_bash', 'Sleep in the background', 'execute', BG_SHELL))
  push(h.sessionId, toolDone('call_bash', '<command started in background with shellId: bg1>'))
  // The model has answered: the open prompt is only waiting on the shell.
  push(h.sessionId, agentText('started bg1'))
  await settle()
  await h.client.cancel(h.sessionId)
  await settle()
  assert.equal(ofKind(h.events, 'turn_end').at(-1)?.stopReason, 'cancelled')

  // Recorded when the shell ended, after Stop: no session/prompt of ours, no end signal.
  push(h.sessionId, toolCall('9a1b2c3d-0000-4000-8000-000000000002', 'Reading shell output', 'read', { shellId: 'bg1', delay: 0 }))
  push(h.sessionId, toolDone('9a1b2c3d-0000-4000-8000-000000000002', '\n<shellId: bg1 completed with exit code 0>'))
  push(h.sessionId, agentText('the shell finished'))
  await settle()

  assert.deepEqual(transcript(h.sessionId).slice(-2), ['tool Reading shell output completed', 'assistant the shell finished'])
  assert.equal(h.client.hasActiveTurn(h.sessionId), false)
  assert.equal(ofKind(h.events, 'turn_end').length, 1)
  assert.deepEqual(ofKind(h.events, 'error'), [])
  await h.client.reset()
})

// ── compaction ──────────────────────────────────────────────────────────────

test("Copilot's /compact is one line of agent text: no compaction record, no hook, no reading change", async () => {
  const h = await copilotSetup()
  push(h.sessionId, { sessionUpdate: 'usage_update', used: 8854, size: 128000 })
  await h.client.prompt(h.sessionId, '/compact', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  push(h.sessionId, agentText('Compacted conversation history and removed 1 message and -27 tokens.'))
  h.endTurnWith(END_TURN)
  await settle()

  assert.equal(storedSession(h.sessionId).compactions, undefined)
  assert.deepEqual(h.compactions, [], 'the event-driven restore is not triggered')
  assert.ok(h.activity.every((reported) => !reported.compacting))
  // No usage_update inside the turn: a reading before and after is the same,
  // which is what the Compact button's verdict reads as "unknown".
  assert.deepEqual(storedSession(h.sessionId).usage, { used: 8854, size: 128000 })
  assert.deepEqual(transcript(h.sessionId).slice(-1), [
    'assistant Compacted conversation history and removed 1 message and -27 tokens.',
  ])
  assert.deepEqual(ofKind(h.events, 'error'), [])
  await h.client.reset()
})

// ── usage and failures ──────────────────────────────────────────────────────

test("Copilot's usage readings carry the window and nothing else: no cost, no limit windows", async (t) => {
  const h = await copilotFor(t)
  await h.client.prompt(h.sessionId, 'Say hello.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  push(h.sessionId, { sessionUpdate: 'usage_update', used: 8912, size: 128000 })
  push(h.sessionId, agentText('Hello.'))
  h.endTurnWith(END_TURN)
  await settle()

  assert.deepEqual(ofKind(h.events, 'usage'), [{ kind: 'usage', used: 8912, size: 128000 }])
  assert.deepEqual(storedSession(h.sessionId).usage, { used: 8912, size: 128000 })
  const [end] = ofKind(h.events, 'turn_end')
  assert.equal(end.cost, undefined)
  assert.equal(end.failure, undefined)
  assert.deepEqual(end.usage, { inputTokens: 2000, outputTokens: 40, totalTokens: 2040, cacheReadTokens: 0, cacheWriteTokens: 0 })
})

// A failed model call reaches the wire only as reply text, the turn ending
// `end_turn`; the typed failure is in Copilot's session event log, under the
// agent's Copilot home. Lines as Copilot 1.0.95 wrote them, the endpoint made
// neutral.
const ENDPOINT = 'https://models.example.test/v1'
const AUTH_MESSAGE = `Authentication failed with provider at ${ENDPOINT} (HTTP 401).\n  Check your COPILOT_PROVIDER_API_KEY, COPILOT_PROVIDER_API_KEY_COMMAND, or COPILOT_PROVIDER_BEARER_TOKEN.`
const RATE_MESSAGE =
  'Failed to get response from the AI model; retried 5 times (total retry wait time: 5.40 seconds) Last error: 429 Rate limit reached'
const logLine = (type: string, data: Record<string, unknown>, id = `event-${type}`) =>
  `${JSON.stringify({ type, data, id, timestamp: '2026-01-01T00:00:00.000Z', parentId: null })}\n`
const TURN_START = logLine('assistant.turn_start', { turnId: '0', interactionId: 'interaction-1' })
const TURN_END = logLine('assistant.turn_end', { turnId: '0' })
const authError = logLine('session.error', { errorType: 'authentication', message: AUTH_MESSAGE, statusCode: 401 }, 'error-401')
const rateError = logLine('session.error', { errorType: 'rate_limit', message: RATE_MESSAGE, statusCode: 429 }, 'error-429')

interface TestContext {
  after: (fn: () => unknown) => void
}

// A Copilot session reset after the test whatever its outcome: a session left
// open keeps the file's process alive past a failed assertion.
async function copilotFor(t: TestContext, overrides: Partial<AgentSelection> = {}) {
  const h = await copilotSetup(overrides)
  t.after(() => h.client.reset())
  return h
}

// A Copilot session whose agent workdir is a real directory, with a writer for
// the session's event log where the adapter points COPILOT_HOME.
async function copilotWithLog(t: TestContext, overrides: Partial<AgentSelection> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'copilot-failure-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const h = await copilotFor(t, { cwd, ...overrides })
  const dir = join(cwd, '.harness-home', 'copilot', 'session-state', h.sessionId)
  mkdirSync(dir, { recursive: true })
  const log = (...lines: string[]) => appendFileSync(join(dir, 'events.jsonl'), lines.join(''))
  log(logLine('session.start', { sessionId: h.sessionId }))
  return { ...h, log }
}

test('a wrong key ends the Copilot turn as a typed failure, with no reply in its place', async (t) => {
  const h = await copilotWithLog(t)
  await h.client.prompt(h.sessionId, 'Say hello.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.log(TURN_START)
  push(h.sessionId, { sessionUpdate: 'usage_update', used: 8916, size: 128000 })
  push(h.sessionId, agentText(`Error: ${AUTH_MESSAGE}`))
  h.log(TURN_END, authError)
  h.endTurnWith({ stopReason: 'end_turn' })
  await settle()

  assert.deepEqual(ofKind(h.events, 'agent_message'), [])
  const ends = ofKind(h.events, 'turn_end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].stopReason, 'end_turn')
  assert.deepEqual(ends[0].failure, {
    id: 'error-401',
    label: 'auth_required',
    kind: 'authentication',
    title: 'The model provider refused the credentials (HTTP 401)',
    category: 'access',
    severity: 'error',
    details: AUTH_MESSAGE,
    actions: ['login'],
  })
  assert.deepEqual(transcript(h.sessionId), ['user Say hello.'])
  assert.deepEqual(ofKind(h.events, 'error'), [])
})

test('a rate-limited Copilot turn ends as a rate-limit failure', async (t) => {
  const h = await copilotWithLog(t)
  await h.client.prompt(h.sessionId, 'Say hello.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.log(TURN_START)
  push(h.sessionId, agentText(`Error: ${RATE_MESSAGE}`))
  h.log(TURN_END, rateError)
  h.endTurnWith({ stopReason: 'end_turn' })
  await settle()

  assert.deepEqual(ofKind(h.events, 'agent_message'), [])
  const failure = ofKind(h.events, 'turn_end')[0].failure
  assert.equal(failure?.label, 'rate_limited')
  assert.equal(failure?.title, 'The model provider is limiting requests (HTTP 429)')
})

test("without a log Copilot wrote, Copilot's error text stays the turn's reply", async (t) => {
  // The workdir does not exist, so there is no log to read.
  const h = await copilotFor(t)
  await h.client.prompt(h.sessionId, 'Say hello.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  push(h.sessionId, agentText(`Error: ${AUTH_MESSAGE}`))
  h.endTurnWith({ stopReason: 'end_turn' })
  await settle()

  assert.deepEqual(
    ofKind(h.events, 'agent_message').map((event) => event.text),
    [`Error: ${AUTH_MESSAGE}`],
  )
  assert.equal(ofKind(h.events, 'turn_end')[0].failure, undefined)
  assert.deepEqual(transcript(h.sessionId), ['user Say hello.', `assistant Error: ${AUTH_MESSAGE}`])
})

test('a container-spawned Copilot keeps its error text: its log is not the one on the server', async (t) => {
  // The container's home has the same path inside the container; a log at
  // that path on the server belongs to some other process.
  const h = await copilotWithLog(t, { containerName: 'agent-box' })
  await h.client.prompt(h.sessionId, 'Say hello.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.log(TURN_START)
  push(h.sessionId, agentText(`Error: ${AUTH_MESSAGE}`))
  h.log(TURN_END, authError)
  h.endTurnWith({ stopReason: 'end_turn' })
  await settle()

  assert.deepEqual(
    ofKind(h.events, 'agent_message').map((event) => event.text),
    [`Error: ${AUTH_MESSAGE}`],
  )
  assert.equal(ofKind(h.events, 'turn_end')[0].failure, undefined)
})

test("an earlier turn's logged failure does not swallow a later reply with the same text", async (t) => {
  const h = await copilotWithLog(t)
  h.log(TURN_START, TURN_END, authError)
  await h.client.prompt(h.sessionId, 'Say hello.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.log(TURN_START)
  push(h.sessionId, agentText(`Error: ${AUTH_MESSAGE}`))
  h.log(logLine('assistant.message', { content: `Error: ${AUTH_MESSAGE}` }), TURN_END)
  h.endTurnWith(END_TURN)
  await settle()

  assert.deepEqual(
    ofKind(h.events, 'agent_message').map((event) => event.text),
    [`Error: ${AUTH_MESSAGE}`],
  )
  assert.equal(ofKind(h.events, 'turn_end')[0].failure, undefined)
})

test('a reply that differs from the logged failure is delivered as it came, and the turn ends plain', async (t) => {
  const h = await copilotWithLog(t)
  await h.client.prompt(h.sessionId, 'Say hello.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.log(TURN_START)
  push(h.sessionId, agentText('Error: something else'))
  h.log(TURN_END, rateError)
  h.endTurnWith({ stopReason: 'end_turn' })
  await settle()

  assert.deepEqual(
    ofKind(h.events, 'agent_message').map((event) => event.text),
    ['Error: something else'],
  )
  assert.equal(ofKind(h.events, 'turn_end')[0].failure, undefined)
})

test('a model reply that starts like an error keeps its place among the chunks after it', async (t) => {
  const h = await copilotWithLog(t)
  await h.client.prompt(h.sessionId, 'What does the log say?', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.log(TURN_START)
  push(h.sessionId, agentText('Error: '))
  push(h.sessionId, agentText('the build log ends with a missing module.'))
  h.log(TURN_END)
  h.endTurnWith(END_TURN)
  await settle()

  assert.deepEqual(
    ofKind(h.events, 'agent_message').map((event) => event.text),
    ['Error: ', 'the build log ends with a missing module.'],
  )
  assert.deepEqual(transcript(h.sessionId).slice(-1), ['assistant Error: the build log ends with a missing module.'])
  assert.equal(ofKind(h.events, 'turn_end')[0].failure, undefined)
})

test('a held reply is delivered when the turn is stopped instead of ending', async (t) => {
  const h = await copilotWithLog(t)
  await h.client.prompt(h.sessionId, 'Say hello.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.log(TURN_START)
  push(h.sessionId, agentText(`Error: ${AUTH_MESSAGE}`))
  h.log(TURN_END, authError)
  await h.client.cancel(h.sessionId)
  await settle()

  assert.deepEqual(
    ofKind(h.events, 'agent_message').map((event) => event.text),
    [`Error: ${AUTH_MESSAGE}`],
  )
  const [end] = ofKind(h.events, 'turn_end')
  assert.equal(end.stopReason, 'cancelled')
  assert.equal(end.failure, undefined)
})

test("a held reply is delivered in its own turn when the prompt response carries a failure, and the next turn's reply stays its own", async (t) => {
  const h = await copilotWithLog(t)
  await h.client.prompt(h.sessionId, 'Say hello.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.log(TURN_START)
  push(h.sessionId, agentText('Error: something else'))
  h.log(TURN_END)
  h.endTurnWith({
    stopReason: 'end_turn',
    _meta: {
      jetbrains: {
        air: { sessionFailure: { id: 'turn-1:error', category: 'service', severity: 'error', title: 'The turn failed' } },
      },
    },
  })
  await settle()
  await h.client.prompt(h.sessionId, 'Again.', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  h.log(TURN_START)
  push(h.sessionId, agentText('Hello.'))
  h.log(TURN_END)
  h.endTurnWith(END_TURN)
  await settle()

  const turns = h.events
    .filter((event) => event.kind === 'agent_message' || event.kind === 'turn_end')
    .map((event) => (event.kind === 'agent_message' ? event.text : `turn_end ${event.failure?.title ?? ''}`.trim()))
  assert.deepEqual(turns, ['Error: something else', 'turn_end The turn failed', 'Hello.', 'turn_end'])
})
