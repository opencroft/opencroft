import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { connectionKey, createAgentClient, handleUpdate } from './agent-client'
import type { AgentConnection } from './connection'
import { COMPACTION_TITLE, compactionView, foldEvents } from './fold'
import { findAdapter } from './resolve'
import type { AgentSelection, ChatEvent, CompactionState } from './types'

// ── codex-acp 1.13.1 wire contract ─────────────────────────────────────────
//
// What codex-acp actually puts on the wire, fed through the same seams
// agent-client.test.ts uses: a mock connection seeded under the selection's
// spawn key, updates through handleUpdate, prompt responses through the
// connection's prompt promise. Every fixture is copied from codex-acp's own
// source (the file is named beside it) or was observed live against 1.13.1,
// so a failure here means the client stopped consuming what Codex sends — not
// that a hand-written payload drifted from a guess.
//
// The selection is the real `codex` adapter, so what the engine derives from
// it (spawn key, per-session MCP servers, the adapter id on turn_end) is the
// production path. That adapter wants the built-in MCP server, which is why
// every test ends with reset().

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
  usage?: { used: number; size?: number; cost?: unknown; rateLimits?: unknown }
  compactions?: Map<string, CompactionState>
  replaying?: boolean
}

function storedSession(sessionId: string): SessionShape {
  const session = acpStore().sessions.get(sessionId) as SessionShape | undefined
  assert.ok(session, 'session must exist in the store')
  return session
}

let counter = 0

function codexSelection(cwd?: string): AgentSelection {
  counter += 1
  return {
    providerId: 'test-provider',
    adapterId: 'codex',
    model: 'gpt-5.1-codex',
    apiKey: '',
    cwd: cwd ?? `/tmp/codex-contract-${counter}`,
  }
}

async function codexSetup(options: { onCompaction?: (sessionId: string, compaction: CompactionState) => void } = {}) {
  const selection = codexSelection()
  const turns: Array<(response: Record<string, unknown>) => void> = []
  const connection = {
    newSession: async () => ({ sessionId: `codex-contract-session-${counter}` }),
    prompt: () =>
      new Promise((resolve) => {
        turns.push(resolve as (response: Record<string, unknown>) => void)
      }),
    cancel: async () => {},
  } as unknown as AgentConnection
  acpStore().connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient(options.onCompaction ? { onCompaction: options.onCompaction } : {})
  const meta = await client.createSession(selection)
  const events: ChatEvent[] = []
  client.subscribe(meta.id, (event) => events.push(event))
  return {
    client,
    sessionId: meta.id,
    events,
    // Resolve the oldest open prompt with the full response codex-acp sends.
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

function compactionRows(sessionId: string) {
  return foldEvents(storedSession(sessionId).events).filter(
    (message) => message.kind === 'tool' && message.title === COMPACTION_TITLE,
  )
}

// ── initialize: what we declare decides which shapes Codex sends ───────────

// A stand-in for the codex-acp binary: answers initialize and session/new,
// writes the initialize params it received to the file named by its first
// argument, and answers any other request (authenticate included) with an
// empty result. It advertises the gateway method the codex adapter
// authenticates with.
const FAKE_AGENT = `
const fs = require('node:fs')
const rl = require('node:readline').createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.id === undefined) return
  let result = {}
  if (message.method === 'initialize') {
    fs.writeFileSync(process.argv[1], JSON.stringify(message.params))
    result = {
      protocolVersion: message.params.protocolVersion,
      agentCapabilities: {},
      authMethods: [{ id: 'gateway', name: 'Custom model gateway' }],
    }
  } else if (message.method === 'session/new') {
    result = { sessionId: 'fake-codex-session' }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
})
`

test('initialize declares compaction, notices and typed failures, and does NOT declare plan', async () => {
  // Each declaration switches a codex-acp code path:
  // - session.compaction -> compaction_update instead of a synthetic tool call
  //   (clientSupportsCompaction, src/CodexSessionCompactions.ts);
  // - session.notices -> advisories as `notice` updates rather than agent
  //   text, for a bridge that implements them; one that does not ignores it;
  // - `_meta.jetbrains.air.capabilities` incl. `sessionFailure` -> a typed
  //   failure on the prompt response (clientSupportsTypedSessionFailures,
  //   src/CodexAcpServer.ts);
  // - `plan` -> the draft `plan_update` instead of the stable `plan` update
  //   (clientSupportsPlanUpdates, src/PlanCapabilities.ts). handleUpdate has
  //   no case for plan_update, so declaring it would make every Codex plan
  //   vanish.
  const adapter = findAdapter('codex')
  assert.ok(adapter)
  const original = { command: adapter.command, args: adapter.args }
  const dir = mkdtempSync(join(tmpdir(), 'codex-contract-'))
  const captured = join(dir, 'initialize.json')
  adapter.command = process.execPath
  adapter.args = ['-e', FAKE_AGENT, captured]
  const client = createAgentClient()
  try {
    // A real provider and a key: the codex adapter authenticates after
    // initialize and refuses to start without either.
    await client.createSession({ ...codexSelection(dir), providerId: 'openai', apiKey: 'sk-contract-test-0000' })
    const params = JSON.parse(readFileSync(captured, 'utf8')) as { clientCapabilities: Record<string, unknown> }
    const capabilities = params.clientCapabilities
    assert.equal(Object.hasOwn(capabilities, 'plan'), false, 'no plan capability: Codex must keep sending `plan`')
    assert.deepEqual(capabilities.session, { compaction: {}, notices: {} })
    assert.deepEqual(capabilities._meta, {
      jetbrains: { air: { version: 1, capabilities: ['asyncTasks', 'nativeSubagentSessions', 'sessionFailure'] } },
    })
  } finally {
    adapter.command = original.command
    adapter.args = original.args
    await client.reset()
  }
})

// ── compaction ─────────────────────────────────────────────────────────────

test('a live Codex compaction folds to one row, fires the hook on completed, and invents no summary', async () => {
  const hookCalls: CompactionState[] = []
  const h = await codexSetup({ onCompaction: (_sessionId, compaction) => hookCalls.push(compaction) })
  // item/started contextCompaction -> CodexSessionCompactions.start ->
  // createCompactionUpdate(item.id, 'in_progress') (src/CodexEventHandler.ts,
  // src/CodexSessionCompactions.ts)
  push(h.sessionId, { sessionUpdate: 'compaction_update', compactionId: 'item-compact-1', status: 'in_progress' })
  // item/completed contextCompaction -> CodexSessionCompactions.complete ->
  // createCompactionUpdate(item.id, 'completed') (same files)
  push(h.sessionId, { sessionUpdate: 'compaction_update', compactionId: 'item-compact-1', status: 'completed' })

  const record: CompactionState = { compactionId: 'item-compact-1', status: 'completed' }
  assert.deepEqual(ofKind(h.events, 'compaction').at(-1), { kind: 'compaction', compaction: record })
  // Codex carries no summary and no `_meta.contextCompaction`; the view must
  // not fill either gap.
  assert.deepEqual(compactionView(record), {
    id: 'compaction:item-compact-1',
    title: COMPACTION_TITLE,
    status: 'completed',
    input: {},
    output: undefined,
    isError: false,
  })
  const rows = compactionRows(h.sessionId)
  assert.equal(rows.length, 1, 'both updates upsert one row')
  const row = rows[0]
  assert.ok(row.kind === 'tool')
  assert.equal(row.toolCallId, 'compaction:item-compact-1')
  assert.equal(row.status, 'completed')
  assert.equal(row.output, undefined, 'no summary is invented')
  assert.deepEqual(row.input, {})
  assert.deepEqual(
    hookCalls.map((compaction) => compaction.status),
    ['in_progress', 'completed'],
  )
  assert.deepEqual(hookCalls.at(-1), record)
  await h.client.reset()
})

test('a failed Codex compaction shows as failed, with its error only when Codex sent one', async () => {
  const h = await codexSetup()
  // finishOutstanding('failed') -> createCompactionUpdate(id, 'failed') with
  // no error (src/CodexSessionCompactions.ts)
  push(h.sessionId, { sessionUpdate: 'compaction_update', compactionId: 'item-compact-2', status: 'in_progress' })
  push(h.sessionId, { sessionUpdate: 'compaction_update', compactionId: 'item-compact-2', status: 'failed' })
  // finishTurn('failed', error) -> createCompactionUpdate(id, 'failed', error)
  // (src/CodexSessionCompactions.ts)
  push(h.sessionId, { sessionUpdate: 'compaction_update', compactionId: 'item-compact-3', status: 'in_progress' })
  push(h.sessionId, {
    sessionUpdate: 'compaction_update',
    compactionId: 'item-compact-3',
    status: 'failed',
    error: 'stream disconnected before completion',
  })
  // finishOutstanding('cancelled') on an interrupted turn (same file)
  push(h.sessionId, { sessionUpdate: 'compaction_update', compactionId: 'item-compact-4', status: 'in_progress' })
  push(h.sessionId, { sessionUpdate: 'compaction_update', compactionId: 'item-compact-4', status: 'cancelled' })

  const bare = storedSession(h.sessionId).compactions?.get('item-compact-2')
  assert.deepEqual(bare, { compactionId: 'item-compact-2', status: 'failed' })
  assert.ok(bare)
  assert.equal(compactionView(bare).isError, true)
  const rows = compactionRows(h.sessionId)
  assert.deepEqual(
    rows.map((row) => row.kind === 'tool' && [row.toolCallId, row.status, row.output]),
    [
      ['compaction:item-compact-2', 'failed', undefined],
      ['compaction:item-compact-3', 'failed', 'stream disconnected before completion'],
      ['compaction:item-compact-4', 'cancelled', undefined],
    ],
  )
  await h.client.reset()
})

test('a Codex session/load replays a completed compaction into the transcript without firing the hook', async () => {
  const hookCalls: CompactionState[] = []
  const selection = codexSelection()
  const sessionId = `codex-contract-loaded-${counter}`
  const connection = {
    loadSession: async () => {
      // contextCompaction in thread history -> createCompactionUpdate(item.id,
      // 'completed') (createHistoryUpdates, src/CodexAcpServer.ts)
      push(sessionId, { sessionUpdate: 'compaction_update', compactionId: 'item-compact-old', status: 'completed' })
      return {}
    },
  } as unknown as AgentConnection
  acpStore().connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: true,
    initialized: Promise.resolve(),
  })
  const client = createAgentClient({ onCompaction: (_sessionId, compaction) => hookCalls.push(compaction) })

  assert.ok(await client.loadSession(sessionId, selection))

  const rows = compactionRows(sessionId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind === 'tool' && rows[0].status, 'completed')
  assert.equal(hookCalls.length, 0, 'a replayed compaction is history, not a fresh one')
  await client.reset()
})

// ── plan ───────────────────────────────────────────────────────────────────

test('a Codex plan arrives as the plan, and an empty one clears it', async () => {
  const h = await codexSetup()
  // turn/plan/updated -> updatePlan: status inProgress -> in_progress, step ->
  // content, priority always 'medium' (src/CodexEventHandler.ts)
  const entries = [
    { status: 'completed', content: 'Read the failing test', priority: 'medium' },
    { status: 'in_progress', content: 'Fix the parser', priority: 'medium' },
    { status: 'pending', content: 'Run the suite', priority: 'medium' },
  ]
  push(h.sessionId, { sessionUpdate: 'plan', entries })

  assert.deepEqual(ofKind(h.events, 'plan').at(-1), { kind: 'plan', entries })
  assert.deepEqual(storedSession(h.sessionId).plan, entries)

  // The same updatePlan with an empty turn plan.
  push(h.sessionId, { sessionUpdate: 'plan', entries: [] })
  assert.deepEqual(ofKind(h.events, 'plan').at(-1), { kind: 'plan', entries: [] })
  assert.deepEqual(storedSession(h.sessionId).plan, [])
  await h.client.reset()
})

// ── context reading, cost, rate limits ─────────────────────────────────────

// thread/tokenUsage/updated -> createUsageUpdate: `used` is the last turn's
// totalTokens, `size` the model context window; no cost, no `_meta`
// (src/CodexEventHandler.ts)
const CODEX_USAGE_UPDATE = { sessionUpdate: 'usage_update', used: 41250, size: 258400 }

// Codex's per-turn token count (toTokenCount, src/TokenCount.ts): inputTokens
// is NON-cached input, reasoning is counted inside outputTokens.
const CODEX_TOKEN_COUNT = {
  totalTokens: 1500,
  inputTokens: 800,
  cachedInputTokens: 400,
  outputTokens: 300,
  reasoningOutputTokens: 100,
}

// The end_turn prompt response: ACP `usage` from toPromptUsage
// (src/TokenCount.ts) and `_meta` from buildQuotaMeta, whose only key is
// `quota` (src/CodexAcpServer.ts). No cost, no rate limits.
const CODEX_PROMPT_RESPONSE = {
  stopReason: 'end_turn',
  usage: { totalTokens: 1500, inputTokens: 800, cachedReadTokens: 400, outputTokens: 300, thoughtTokens: 100 },
  _meta: {
    quota: {
      token_count: CODEX_TOKEN_COUNT,
      model_usage: [{ model: 'gpt-5.1-codex', token_count: CODEX_TOKEN_COUNT }],
    },
  },
}

const TURN_USAGE = { totalTokens: 1500, inputTokens: 800, outputTokens: 300, thoughtTokens: 100, cacheReadTokens: 400 }

test('a Codex usage_update shows used and size as the session reading', async () => {
  const h = await codexSetup()
  push(h.sessionId, CODEX_USAGE_UPDATE)
  assert.deepEqual(ofKind(h.events, 'usage').at(-1), { kind: 'usage', used: 41250, size: 258400 })
  assert.deepEqual(storedSession(h.sessionId).usage, { used: 41250, size: 258400 })
  await h.client.reset()
})

test('a Codex turn settles cleanly with no cost anywhere', async () => {
  const h = await codexSetup()
  await h.client.prompt(h.sessionId, 'go', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  push(h.sessionId, CODEX_USAGE_UPDATE)
  h.endTurnWith(CODEX_PROMPT_RESPONSE)
  await settle()

  const ends = ofKind(h.events, 'turn_end')
  assert.equal(ends.length, 1)
  assert.equal(ends[0].stopReason, 'end_turn')
  assert.equal(Object.hasOwn(ends[0], 'cost'), false, 'Codex prices nothing, so no turn cost is derived')
  assert.equal(Object.hasOwn(ends[0], 'failure'), false)
  assert.equal(storedSession(h.sessionId).usage?.cost, undefined)
  assert.ok(
    ofKind(h.events, 'usage').every((event) => !Object.hasOwn(event, 'cost')),
    'no usage event carries a cost',
  )
  assert.deepEqual(ofKind(h.events, 'error'), [])
  assert.equal(h.client.hasActiveTurn(h.sessionId), false)
  await h.client.reset()
})

test('a Codex prompt response _meta.quota yields turn usage and no rate-limit entry', async () => {
  const h = await codexSetup()
  await h.client.prompt(h.sessionId, 'go', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  push(h.sessionId, CODEX_USAGE_UPDATE)
  h.endTurnWith(CODEX_PROMPT_RESPONSE)
  await settle()

  const end = ofKind(h.events, 'turn_end').at(-1)
  assert.ok(end)
  assert.deepEqual(end.usage, TURN_USAGE)
  assert.deepEqual(end.quota, {
    tokenCount: TURN_USAGE,
    modelUsage: [{ model: 'gpt-5.1-codex', tokenCount: TURN_USAGE }],
  })
  assert.equal(end.adapterId, 'codex')
  assert.equal(end.model, 'gpt-5.1-codex')
  // Codex keeps its rate-limit windows to /status text; nothing on the wire
  // may be mistaken for one.
  assert.equal(storedSession(h.sessionId).usage?.rateLimits, undefined)
  assert.ok(ofKind(h.events, 'usage').every((event) => !Object.hasOwn(event, 'rateLimits')))
  await h.client.reset()
})

test('a Codex failed turn settles with a typed failure (observed live against 1.13.1)', async () => {
  const h = await codexSetup()
  await h.client.prompt(h.sessionId, 'go', { queue: 'push', origin: { kind: 'system' } })
  await settle()
  // stopReason and a null usage (no token count yet) come from
  // terminalFailurePromptResponse (src/CodexAcpServer.ts); the `_meta` is the
  // one observed live against 1.13.1 with an endpoint answering 401. The
  // observation elided the id's turn prefix and the title's tail; those two
  // strings are filled in, the structure and every other value are as seen.
  h.endTurnWith({
    stopReason: 'end_turn',
    usage: null,
    _meta: {
      quota: { token_count: null, model_usage: [] },
      jetbrains: {
        air: {
          version: 1,
          sessionFailure: {
            id: 'turn-1:error',
            revision: 6,
            category: 'service',
            severity: 'error',
            title: 'unexpected status 401 Unauthorized',
            actions: ['retry'],
          },
        },
      },
    },
  })
  await settle()

  const ends = ofKind(h.events, 'turn_end')
  assert.equal(ends.length, 1)
  const end = ends[0]
  assert.equal(end.stopReason, 'end_turn')
  // `service` + `retry` names two codex kinds (overloaded, provider error), so
  // the label stays the category rather than guessing between them.
  assert.deepEqual(end.failure, {
    id: 'turn-1:error',
    label: 'service',
    revision: 6,
    title: 'unexpected status 401 Unauthorized',
    category: 'service',
    severity: 'error',
    actions: ['retry'],
  })
  assert.equal(Object.hasOwn(end, 'usage'), false, 'a null usage is no reading')
  assert.equal(Object.hasOwn(end, 'quota'), false, 'a null token_count is no reading')
  assert.deepEqual(ofKind(h.events, 'error'), [])
  assert.equal(h.client.hasActiveTurn(h.sessionId), false)
  await h.client.reset()
})
