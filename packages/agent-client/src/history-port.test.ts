import assert from 'node:assert/strict'
import test from 'node:test'

import { connectionKey, createAgentClient, handleUpdate, type RecordedLogOpts } from './agent-client'
import type { AgentConnection } from './connection'
import { tailByRecords } from './pagination'
import { type HistoryPort, type LogWrite, type PlacedEntry, SESSION_LOG } from './transcript-log'
import type { AgentSelection, ChatEvent } from './types'

// The engine with a history port: a session holds only the tail of its own
// log, lets its oldest turns go once they are the host's, and reads below the
// tail through the port. The host here is a map of every write it was handed,
// plus what it was seeded with, standing in for a store.

interface AcpStoreShape {
  connections: Map<string, unknown>
}

let counter = 0

// A host keeping every log by position, as a store would.
function hostCopy() {
  const logs = new Map<string, Map<number, ChatEvent>>()
  const logOf = (log: string) => {
    let held = logs.get(log)
    if (!held) {
      held = new Map()
      logs.set(log, held)
    }
    return held
  }
  const port: HistoryPort = {
    read: async (_sessionId, log, from, to) =>
      [...logOf(log)]
        .filter(([position]) => position >= from && position < to)
        .sort(([a], [b]) => a - b)
        .map(([position, event]): PlacedEntry => ({ position, event })),
    turnStartBefore: async (_sessionId, log, position) => {
      let found: number | null = null
      for (const [at, event] of logOf(log)) {
        if (event.kind === 'user' && at < position && (found === null || at > found)) {
          found = at
        }
      }
      return found
    },
    end: async (_sessionId, log) => Math.max(-1, ...logOf(log).keys()) + 1,
  }
  return {
    port,
    record: (write: LogWrite) => logOf(write.log).set(write.position, write.event),
    seed: (log: string, events: readonly ChatEvent[], start = 0) =>
      events.forEach((event, offset) => logOf(log).set(start + offset, event)),
    size: (log = SESSION_LOG) => logOf(log).size,
  }
}

// `turns` turns of a question, `calls` tool calls and an end: 2 + calls
// entries each.
function turnsOf(turns: number, calls: number, from = 0): ChatEvent[] {
  const events: ChatEvent[] = []
  for (let t = from; t < from + turns; t++) {
    events.push({ kind: 'user', text: `question ${t}` })
    for (let c = 0; c < calls; c++) {
      events.push({ kind: 'tool_call', toolCallId: `t${t}-${c}`, title: `call ${t}.${c}`, status: 'completed' })
    }
    events.push({ kind: 'turn_end', stopReason: 'end_turn' })
  }
  return events
}

async function open(
  options: { recorded: ChatEvent[]; seed?: RecordedLogOpts; port?: boolean; below?: ChatEvent[] } = { recorded: [] },
) {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/history-port-test-${counter}`,
    sessionKey: `history-port-key-${counter}`,
  }
  const sessionId = `history-port-session-${counter}`
  const forkCalls: Record<string, unknown>[] = []
  const connection = {
    resumeSession: async () => ({}),
    newSession: async () => ({ sessionId: `${sessionId}-new` }),
    unstable_forkSession: async (params: Record<string, unknown>) => {
      forkCalls.push(params)
      return { sessionId: `${sessionId}-fork-${forkCalls.length}` }
    },
  } as unknown as AgentConnection
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  store.connections.set(connectionKey(selection), {
    connection,
    lastSessionId: null,
    loadSession: true,
    resumeSession: true,
    forkSupported: true,
    initialized: Promise.resolve(),
  })
  const host = hostCopy()
  host.seed(SESSION_LOG, [...(options.below ?? []), ...options.recorded])
  const client = createAgentClient({
    compactLog: true,
    onRecord: (_sessionId, write) => host.record(write),
    ...(options.port === false ? {} : { history: host.port }),
  })
  const meta = await client.restoreSession(sessionId, selection, options.recorded, undefined, options.seed)
  assert.ok(meta, 'precondition: the session reopened')
  const push = (update: Record<string, unknown>) =>
    handleUpdate({ sessionId, update } as Parameters<typeof handleUpdate>[0])
  return { client, sessionId, host, push, forkCalls }
}

const userText = (event: ChatEvent | undefined) => (event?.kind === 'user' ? event.text : event?.kind)

test('a long session lets its oldest whole turns go, keeping a tail that starts a turn', async () => {
  // 39 turns of 102 entries: 3978, just under where eviction starts.
  const recorded = turnsOf(39, 100)
  const h = await open({ recorded })
  assert.equal(h.client.getLogStart(h.sessionId), 0)
  for (let i = 0; i < 30; i++) {
    h.push({ sessionUpdate: 'tool_call', toolCallId: `live-${i}`, title: 'live', status: 'completed' })
  }
  const start = h.client.getLogStart(h.sessionId) ?? 0
  const held = h.client.getSessionEvents(h.sessionId) ?? []
  assert.ok(start > 0, 'the oldest turns were let go')
  assert.equal(start % 102, 0, 'at a turn start')
  assert.equal(held[0]?.kind, 'user')
  assert.ok(held.length >= 2000 && held.length < 4000, `holds ${held.length}`)
  // Positions are the log's: the newest entry is where the host has it.
  const newest = h.client.getLogEntry(h.sessionId, recorded.length + 29)
  assert.equal(newest?.kind === 'tool_call' ? newest.toolCallId : null, 'live-29')
  assert.equal(h.client.getLogEntry(h.sessionId, 0), undefined, 'not held any more')
  // A turn below the tail is not one the session can fork at.
  assert.equal(h.client.userTurnAt(h.sessionId, 0), null)
  assert.equal(h.client.userTurnAt(h.sessionId, start)?.turnIndex, start / 102)
  await h.client.deleteSession(h.sessionId)
})

test('pages read below the tail through the port, down to the first turn, as if the log were held whole', async () => {
  const recorded = turnsOf(39, 100)
  const h = await open({ recorded })
  for (let i = 0; i < 30; i++) {
    h.push({ sessionUpdate: 'tool_call', toolCallId: `live-${i}`, title: 'live', status: 'completed' })
  }
  assert.ok((h.client.getLogStart(h.sessionId) ?? 0) > 0, 'precondition: the session holds a tail')
  const whole = [...recorded, ...(h.client.getSessionEvents(h.sessionId) ?? []).slice(-30)]
  const opening = h.client.getRecordsWindow(h.sessionId, { records: 20 })
  assert.ok(opening?.hasMore)
  assert.equal(opening?.startIndex, tailByRecords(whole, 20).startIndex)

  // Page up until nothing is left, collecting every question on the way.
  const questions = new Set<string>()
  let before: number | undefined = opening?.startIndex
  let pages = 0
  while (before !== undefined && pages < 1000) {
    const page = await h.client.getRecordsPage(h.sessionId, { beforeIndex: before, records: 400 })
    assert.ok(page)
    for (const event of page.events) {
      if (event.kind === 'user') {
        questions.add(event.text)
      }
    }
    pages += 1
    before = page.hasMore ? page.startIndex : undefined
  }
  assert.ok(questions.has('question 0'), 'the first turn is reached')
  assert.equal(questions.size, 39 - [...(opening?.events ?? [])].filter((event) => event.kind === 'user').length)
  await h.client.deleteSession(h.sessionId)
})

test('a session seeded with its tail numbers from the tail, and takes its state from below it', async () => {
  const below = [
    { kind: 'modes', available: [{ id: 'ask', name: 'Ask' }], current: 'ask' } as ChatEvent,
    ...turnsOf(3, 1),
  ]
  const recorded = turnsOf(2, 1, 3)
  const h = await open({
    recorded,
    below,
    seed: { start: below.length, turnsBefore: 3, before: [{ position: 0, event: below[0] }] },
  })
  assert.equal(h.client.getLogStart(h.sessionId), below.length)
  assert.equal(h.client.sessionModes(h.sessionId)?.current, 'ask', 'the modes recorded below the tail')
  assert.equal(userText(h.client.getLogEntry(h.sessionId, below.length)), 'question 3')
  assert.equal(h.client.userTurnAt(h.sessionId, below.length)?.turnIndex, 3)

  const positions: (number | undefined)[] = []
  h.client.subscribe(h.sessionId, (_event, position) => positions.push(position), { fromIndex: below.length + 3 })
  assert.equal(positions.filter((position) => position !== undefined)[0], below.length + 3)

  h.push({ sessionUpdate: 'tool_call', toolCallId: 'next', title: 'next', status: 'completed' })
  const next = h.client.getLogEntry(h.sessionId, below.length + recorded.length)
  assert.equal(next?.kind === 'tool_call' ? next.toolCallId : null, 'next')
  // The whole log reads through, below the tail included.
  const page = await h.client.getRecordsPage(h.sessionId, { beforeIndex: below.length, records: 50 })
  assert.equal(page?.startIndex, 0)
  assert.equal(page?.hasMore, false)
  assert.deepEqual(
    page?.events.filter((event) => event.kind === 'user').map(userText),
    ['question 0', 'question 1', 'question 2'],
  )
  await h.client.deleteSession(h.sessionId)
})

test('a fork of a session holding a tail keeps its positions and its count of turns', async () => {
  const below = turnsOf(3, 1)
  const recorded = turnsOf(2, 1, 3)
  const h = await open({ recorded, below, seed: { start: below.length, turnsBefore: 3 } })
  const turn = h.client.userTurnAt(h.sessionId, below.length + 3)
  assert.equal(turn?.turnIndex, 4)
  const fork = await h.client.forkSession(h.sessionId, turn?.turnIndex)
  assert.ok(fork)
  assert.equal(h.client.getLogStart(fork.id), below.length)
  assert.deepEqual(h.client.getSessionEvents(fork.id), recorded.slice(0, 3))
  assert.equal(h.client.userTurnAt(fork.id, below.length)?.turnIndex, 3)
  await assert.rejects(h.client.forkSession(h.sessionId, 1), /older than the history this session holds/)
  await h.client.deleteSession(fork.id)
  await h.client.deleteSession(h.sessionId)
})

test("a fork point counts the anchor's identical messages below the tail, and finds an anchor there", async () => {
  // The harness counts identical texts along its whole thread, below the tail
  // the session holds included.
  const answer = (messageId: string): ChatEvent => ({ kind: 'agent_message', text: 'Same answer', messageId })
  const below: ChatEvent[] = [{ kind: 'user', text: 'question 0' }, answer('m0'), { kind: 'turn_end', stopReason: 'end_turn' }]
  const recorded: ChatEvent[] = [
    { kind: 'user', text: 'question 1' },
    answer('m1'),
    { kind: 'turn_end', stopReason: 'end_turn' },
    { kind: 'user', text: 'question 2' },
  ]
  const h = await open({ recorded, below, seed: { start: below.length, turnsBefore: 1 } })
  const forkPoint = (call: Record<string, unknown> | undefined) =>
    (call?._meta as { jetbrains?: { air?: { fork?: Record<string, unknown> } } } | undefined)?.jetbrains?.air?.fork
  // 'Same answer', as the engine's fork-point tests spell its fingerprint.
  const fingerprint = 'sha256:41153d2b46c2869f4021958d44dac18888247fd999507c28970be299a8de4a0f'

  const atHeld = await h.client.forkSession(h.sessionId, 2)
  assert.deepEqual(forkPoint(h.forkCalls[0]), {
    version: 1,
    messageId: 'm1',
    messageFingerprint: fingerprint,
    messageOccurrence: 2,
  })
  // The first turn held: its anchor is the last message below the tail.
  const atFirstHeld = await h.client.forkSession(h.sessionId, 1)
  assert.deepEqual(forkPoint(h.forkCalls[1]), {
    version: 1,
    messageId: 'm0',
    messageFingerprint: fingerprint,
    messageOccurrence: 1,
  })
  for (const fork of [atHeld, atFirstHeld]) {
    if (fork) {
      await h.client.deleteSession(fork.id)
    }
  }
  await h.client.deleteSession(h.sessionId)
})

test('without a port a session holds its whole log, however long', async () => {
  const recorded = turnsOf(39, 100)
  const h = await open({ recorded, port: false })
  for (let i = 0; i < 30; i++) {
    h.push({ sessionUpdate: 'tool_call', toolCallId: `live-${i}`, title: 'live', status: 'completed' })
  }
  assert.equal(h.client.getLogStart(h.sessionId), 0)
  assert.equal(h.client.getSessionEvents(h.sessionId)?.length, recorded.length + 30)
  await h.client.deleteSession(h.sessionId)
})

test("a finished subagent's log below the tail is read through the port", async () => {
  const below: ChatEvent[] = [
    { kind: 'user', text: 'delegate' },
    { kind: 'subagent', subagent: { subagentSessionId: 'old', name: 'Old', task: 't', state: 'completed', steps: 1 } },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  const recorded = turnsOf(1, 1, 1)
  const h = await open({ recorded, below, seed: { start: below.length, turnsBefore: 1 } })
  h.host.seed('old', [{ kind: 'agent_message', text: 'done long ago' }])
  assert.equal(h.client.getSubagentRecordsWindow(h.sessionId, 'old', { records: 10 }), null, 'not held')
  const window = await h.client.getSubagentRecordsPage(h.sessionId, 'old', { records: 10 })
  assert.deepEqual(window?.events, [{ kind: 'agent_message', text: 'done long ago' }])
  assert.equal(await h.client.getSubagentRecordsPage(h.sessionId, 'never', { records: 10 }), null)
  await h.client.deleteSession(h.sessionId)
})

test('closures a reopen adds past the recorded log are handed to the host, so its copy has no gap', async () => {
  const recorded: ChatEvent[] = [
    { kind: 'user', text: 'may I' },
    { kind: 'permission_request', requestId: 'r1', toolCallId: 'x', title: 'Run', options: [] } as unknown as ChatEvent,
  ]
  const h = await open({ recorded })
  assert.equal(h.host.size(), recorded.length + 2, 'the closure and the turn end are both recorded')
  await h.client.deleteSession(h.sessionId)
})
