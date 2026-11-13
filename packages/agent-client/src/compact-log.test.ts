import assert from 'node:assert/strict'
import test from 'node:test'

import { buildClient, connectionKey, createAgentClient, handleUpdate } from './agent-client'
import type { AgentConnection } from './connection'
import type { LogWrite } from './transcript-log'
import type { AgentSelection, ChatEvent } from './types'

// The engine with and without `compactLog`, driven the way a harness drives
// it: a session reopened over a recorded log (resume, no replay), then the
// harness's own notifications through handleUpdate. A seeded connection stands
// in for the subprocess, as in agent-client.test.ts.

interface AcpStoreShape {
  connections: Map<string, unknown>
}

let counter = 0

// A recording that ends on a turn boundary, so the reopen adds none: the live
// events below start at position 2.
const RECORDED: ChatEvent[] = [
  { kind: 'user', text: 'delegate this' },
  { kind: 'turn_end', stopReason: 'end_turn' },
]

interface Frame {
  event: ChatEvent
  position?: number
}

async function open(
  options: { compactLog?: boolean; recorded?: ChatEvent[]; subagentLogs?: Map<string, ChatEvent[]> } = {},
) {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/compact-log-test-${counter}`,
    sessionKey: `compact-log-key-${counter}`,
  }
  const sessionId = `compact-log-session-${counter}`
  const connection = {
    resumeSession: async () => ({}),
    newSession: async () => ({ sessionId: `${sessionId}-new` }),
    unstable_forkSession: async () => ({ sessionId: `${sessionId}-fork` }),
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
  const writes: LogWrite[] = []
  const client = createAgentClient({
    compactLog: options.compactLog === true,
    onRecord: (_sessionId, write) => writes.push(write),
  })
  const recorded = options.recorded ?? RECORDED
  const meta = await client.restoreSession(sessionId, selection, recorded, undefined, {
    ...(options.subagentLogs ? { subagentLogs: options.subagentLogs } : {}),
  })
  assert.ok(meta, 'precondition: the session reopened')
  const frames: Frame[] = []
  client.subscribe(sessionId, (event, position) =>
    frames.push({ event, ...(position !== undefined ? { position } : {}) }),
  )
  frames.length = 0
  const push = (sid: string, update: Record<string, unknown>) =>
    handleUpdate({ sessionId: sid, update } as Parameters<typeof handleUpdate>[0])
  return { client, selection, sessionId, frames, writes, push }
}

const text = (value: string) => ({ type: 'text', text: value })

// A subagent that says something in two chunks, runs a tool and finishes.
function delegate(h: Awaited<ReturnType<typeof open>>, childId: string): void {
  h.push(h.sessionId, { sessionUpdate: 'subagent_spawned', subagentSessionId: childId, name: 'Worker', task: 'dig' })
  h.push(childId, { sessionUpdate: 'agent_message_chunk', content: text('dig'), messageId: 'c1' })
  h.push(childId, { sessionUpdate: 'agent_message_chunk', content: text('ging'), messageId: 'c1' })
  h.push(childId, { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read', status: 'pending' })
  h.push(childId, { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'in_progress' })
  h.push(childId, { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', rawOutput: 'ok' })
  h.push(h.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('summary') })
}

test("with compactLog a subagent's steps go to its own log, and the session holds its header with a step count", async () => {
  const h = await open({ compactLog: true })
  delegate(h, 'worker')
  h.push(h.sessionId, { sessionUpdate: 'subagent_state_update', subagentSessionId: 'worker', state: 'completed' })

  const own = h.client.getSessionEvents(h.sessionId)
  assert.deepEqual(own, [
    ...RECORDED,
    {
      kind: 'subagent',
      subagent: { subagentSessionId: 'worker', name: 'Worker', task: 'dig', state: 'completed', steps: 2 },
    },
    { kind: 'agent_message', text: 'summary' },
  ])
  const steps = h.client.getSessionEvents(h.sessionId, 'worker')
  assert.deepEqual(
    steps?.map((event) => event.kind),
    ['agent_message', 'tool_call', 'tool_update'],
  )
  assert.deepEqual(steps?.[0], { kind: 'agent_message', text: 'digging', messageId: 'c1' })
  assert.equal(
    steps?.[2]?.kind === 'tool_update' ? steps[2].status : undefined,
    'completed',
    "the call's updates are one entry",
  )
  await h.client.deleteSession(h.sessionId)
})

test('with compactLog every frame still goes out, each with where it landed', async () => {
  const h = await open({ compactLog: true })
  delegate(h, 'worker')

  const steps = h.frames.filter((frame) => frame.event.kind === 'subagent_event')
  assert.deepEqual(
    steps.map((frame) => (frame.event.kind === 'subagent_event' ? frame.event.position : null)),
    [0, 0, 1, 2, 2],
    "each step names its entry in the subagent's log; chunks and updates that merged share one",
  )
  assert.ok(
    steps.every((frame) => frame.position === undefined),
    "a step has no position in the session's own log",
  )
  const headers = h.frames.filter((frame) => frame.event.kind === 'subagent')
  assert.deepEqual(
    headers.map((frame) => [frame.position, frame.event.kind === 'subagent' ? frame.event.subagent.steps : null]),
    [
      [2, 0],
      [2, 1],
      [2, 2],
    ],
    'the spawn, then the header again for each step that added an entry, all at the spawn position',
  )
  assert.deepEqual(h.frames.at(-1), { event: { kind: 'agent_message', text: 'summary' }, position: 3 })
  await h.client.deleteSession(h.sessionId)
})

test("with compactLog the host's writes rebuild the log exactly", async () => {
  const h = await open({ compactLog: true })
  delegate(h, 'worker')
  h.push(h.sessionId, { sessionUpdate: 'agent_message_chunk', content: text(' and more') })

  const copies = new Map<string, ChatEvent[]>([['', [...RECORDED]]])
  for (const write of h.writes) {
    const copy = copies.get(write.log) ?? []
    assert.equal(write.appended, write.position === copy.length, 'an append lands at the end, a rewrite inside')
    copy[write.position] = write.event
    copies.set(write.log, copy)
  }
  assert.deepEqual(copies.get(''), h.client.getSessionEvents(h.sessionId))
  assert.deepEqual(copies.get('worker'), h.client.getSessionEvents(h.sessionId, 'worker'))
  await h.client.deleteSession(h.sessionId)
})

test("getSubagentRecordsWindow pages a subagent's own log, tail first", async () => {
  const h = await open({ compactLog: true })
  h.push(h.sessionId, { sessionUpdate: 'subagent_spawned', subagentSessionId: 'worker', name: 'Worker', task: 'dig' })
  for (let i = 0; i < 5; i++) {
    h.push('worker', { sessionUpdate: 'tool_call', toolCallId: `call-${i}`, title: `Step ${i}`, status: 'pending' })
    h.push('worker', { sessionUpdate: 'tool_call_update', toolCallId: `call-${i}`, status: 'completed' })
  }
  const calls = (events: ChatEvent[] | undefined) =>
    events?.flatMap((event) => (event.kind === 'tool_call' ? [event.toolCallId] : []))

  const tail = h.client.getSubagentRecordsWindow(h.sessionId, 'worker', { records: 2 })
  assert.ok(tail)
  assert.equal(tail.startIndex, 6, "a position in the subagent's log: the call and its update are two entries")
  assert.equal(tail.hasMore, true)
  assert.deepEqual(calls(tail.events), ['call-3', 'call-4'])
  const older = h.client.getSubagentRecordsWindow(h.sessionId, 'worker', { beforeIndex: tail.startIndex, records: 2 })
  assert.deepEqual(calls(older?.events), ['call-1', 'call-2'])
  assert.equal(older?.startIndex, 2)
  await h.client.deleteSession(h.sessionId)
})

test('getSubagentRecordsWindow: empty for a subagent with no steps yet, null for one the session does not know', async () => {
  const h = await open({ compactLog: true })
  h.push(h.sessionId, { sessionUpdate: 'subagent_spawned', subagentSessionId: 'quiet', name: 'Quiet', task: 'wait' })

  const quiet = h.client.getSubagentRecordsWindow(h.sessionId, 'quiet', { records: 5 })
  assert.deepEqual(
    quiet && { events: quiet.events, startIndex: quiet.startIndex, hasMore: quiet.hasMore, header: quiet.header },
    { events: [], startIndex: 0, hasMore: false, header: undefined },
  )
  assert.equal(h.client.getSubagentRecordsWindow(h.sessionId, 'nobody', { records: 5 }), null)
  assert.equal(h.client.getSubagentRecordsWindow('no-such-session', 'quiet', { records: 5 }), null)
  await h.client.deleteSession(h.sessionId)
})

test('without compactLog the log is every event as emitted, and frames carry their index', async () => {
  const h = await open()
  delegate(h, 'worker')

  const own = h.client.getSessionEvents(h.sessionId) ?? []
  assert.equal(own.filter((event) => event.kind === 'subagent_event').length, 5, 'the steps stay nested in the log')
  assert.deepEqual(
    h.frames.map((frame) => frame.position),
    h.frames.map((_frame, index) => index + RECORDED.length),
    'each frame names its index, after the recorded events',
  )
  assert.ok(
    h.frames.every((frame) => frame.event.kind !== 'subagent_event' || frame.event.position === undefined),
    'and no step carries a position of its own',
  )
  assert.equal(h.client.getSubagentRecordsWindow(h.sessionId, 'worker', { records: 5 }), null)
  assert.deepEqual(
    h.writes.map((write) => write.position),
    own.map((_event, index) => index).slice(RECORDED.length),
    'each write is an append at the next index',
  )
  await h.client.deleteSession(h.sessionId)
})

test('a replayed subscription names each log event by its position, and the snapshot prefix by none', async () => {
  const h = await open({
    recorded: [
      { kind: 'user', text: 'one' },
      { kind: 'agent_message', text: 'a' },
      { kind: 'turn_end', stopReason: 'end_turn' },
      { kind: 'user', text: 'two' },
      { kind: 'agent_message', text: 'b' },
      { kind: 'turn_end', stopReason: 'end_turn' },
    ],
  })
  h.push(h.sessionId, { sessionUpdate: 'session_info_update', title: 'Named' })
  h.push(h.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('c') })
  const replay: Frame[] = []
  h.client.subscribe(h.sessionId, (event, position) => replay.push({ event, position }), { fromIndex: 3 })

  assert.deepEqual(replay, [
    { event: { kind: 'user', text: 'two' }, position: 3 },
    { event: { kind: 'agent_message', text: 'b' }, position: 4 },
    { event: { kind: 'turn_end', stopReason: 'end_turn' }, position: 5 },
    { event: { kind: 'session_info', title: 'Named' }, position: 6 },
    { event: { kind: 'agent_message', text: 'c' }, position: 7 },
  ])
  const prefixed: Frame[] = []
  h.client.subscribe(h.sessionId, (event, position) => prefixed.push({ event, position }), { fromIndex: 7 })
  assert.deepEqual(prefixed, [
    { event: { kind: 'session_info', title: 'Named' }, position: undefined },
    { event: { kind: 'agent_message', text: 'c' }, position: 7 },
  ])
  await h.client.deleteSession(h.sessionId)
})

test('with compactLog a subscriber joining below a running subagent is handed its header', async () => {
  const h = await open({ compactLog: true })
  h.push(h.sessionId, { sessionUpdate: 'subagent_spawned', subagentSessionId: 'worker', name: 'Worker', task: 'dig' })
  h.push('worker', { sessionUpdate: 'agent_message_chunk', content: text('digging') })
  h.push(h.sessionId, { sessionUpdate: 'subagent_spawned', subagentSessionId: 'done', name: 'Done', task: 'quick' })
  h.push(h.sessionId, { sessionUpdate: 'subagent_state_update', subagentSessionId: 'done', state: 'completed' })
  h.push(h.sessionId, { sessionUpdate: 'agent_message_chunk', content: text('waiting') })

  const window = h.client.getRecordsWindow(h.sessionId, { records: 1 })
  assert.ok(window)
  const replay: Frame[] = []
  h.client.subscribe(h.sessionId, (event, position) => replay.push({ event, position }), {
    fromIndex: window.startIndex,
  })
  const headers = replay.filter((frame) => frame.event.kind === 'subagent')
  assert.deepEqual(headers, [
    {
      event: { kind: 'subagent', subagent: { subagentSessionId: 'worker', name: 'Worker', task: 'dig', steps: 1 } },
      position: undefined,
    },
  ])
  await h.client.deleteSession(h.sessionId)
})

test("with compactLog a reopened session takes its subagents' logs back, nested spawns included", async () => {
  const h = await open({
    compactLog: true,
    recorded: [
      { kind: 'user', text: 'delegate this' },
      { kind: 'subagent', subagent: { subagentSessionId: 'worker', name: 'Worker', task: 'split', steps: 1 } },
    ],
    subagentLogs: new Map<string, ChatEvent[]>([
      [
        'worker',
        [
          { kind: 'agent_message', text: 'splitting' },
          { kind: 'subagent', subagent: { subagentSessionId: 'helper', name: 'Helper', task: 'half', steps: 0 } },
        ],
      ],
    ]),
  })
  assert.ok(h.client.hasBackgroundWork(h.sessionId), 'the nested subagent is live work again')

  h.push('helper', { sessionUpdate: 'agent_message_chunk', content: text('checking') })

  assert.deepEqual(h.client.getSessionEvents(h.sessionId, 'helper'), [{ kind: 'agent_message', text: 'checking' }])
  assert.deepEqual(h.client.getSessionEvents(h.sessionId, 'worker')?.[1], {
    kind: 'subagent',
    subagent: { subagentSessionId: 'helper', name: 'Helper', task: 'half', steps: 1 },
  })
  assert.deepEqual(h.frames.at(-1), {
    event: {
      kind: 'subagent_event',
      subagentSessionId: 'worker',
      event: {
        kind: 'subagent',
        subagent: { subagentSessionId: 'helper', name: 'Helper', task: 'half', steps: 1 },
      },
      position: 1,
    },
  })
  await h.client.deleteSession(h.sessionId)
})

test("with compactLog a subagent's permission request finds the call it announced in its own log", async () => {
  const h = await open({ compactLog: true })
  h.push(h.sessionId, { sessionUpdate: 'subagent_spawned', subagentSessionId: 'worker', name: 'Worker', task: 'dig' })
  h.push('worker', {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Find nodes',
    status: 'pending',
    _meta: { claudeCode: { toolName: 'mcp__local__find_nodes' } },
  })
  const seen: Array<string | undefined> = []
  const answer = await buildClient(
    () => h.sessionId,
    'local',
    (context) => {
      seen.push(context.localToolName)
      return 'allow'
    },
  ).requestPermission({
    sessionId: 'worker',
    toolCall: { toolCallId: 'call-1', title: 'Find nodes' },
    options: [{ optionId: 'yes', name: 'Yes', kind: 'allow_once' }],
  })
  assert.deepEqual(seen, ['find_nodes'], 'the request names only a title; the announced call names the tool')
  assert.deepEqual(answer, { outcome: { outcome: 'selected', optionId: 'yes' } })
  await h.client.deleteSession(h.sessionId)
})

test("with compactLog a new session carrying a recorded history takes its subagents' logs too", async () => {
  const h = await open({ compactLog: true })
  const history: ChatEvent[] = [
    { kind: 'user', text: 'delegate' },
    {
      kind: 'subagent',
      subagent: { subagentSessionId: 'carried', name: 'Worker', task: 'dig', state: 'completed', steps: 1 },
    },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  const carriedLog: ChatEvent[] = [{ kind: 'agent_message', text: 'dug' }]
  const meta = await h.client.createSession(h.selection, undefined, undefined, history, {
    subagentLogs: new Map([['carried', carriedLog]]),
  })

  assert.deepEqual(h.client.getSessionEvents(meta.id, 'carried'), [{ kind: 'agent_message', text: 'dug' }])
  const window = h.client.getSubagentRecordsWindow(meta.id, 'carried', { records: 5 })
  assert.deepEqual(window?.events, [{ kind: 'agent_message', text: 'dug' }])
  assert.deepEqual(
    h.client.getSessionEvents(meta.id)?.map((event) => event.kind),
    ['user', 'subagent', 'turn_end', 'session_start'],
    'the history, then the new session',
  )
  await h.client.deleteSession(meta.id)
  await h.client.deleteSession(h.sessionId)
})

test('with compactLog a fork keeps the logs of the subagents spawned before its turn, and only those', async () => {
  const h = await open({
    compactLog: true,
    recorded: [
      { kind: 'user', text: 'first' },
      {
        kind: 'subagent',
        subagent: { subagentSessionId: 'early', name: 'Early', task: 'a', state: 'completed', steps: 1 },
      },
      { kind: 'turn_end', stopReason: 'end_turn' },
      { kind: 'user', text: 'second' },
      {
        kind: 'subagent',
        subagent: { subagentSessionId: 'late', name: 'Late', task: 'b', state: 'completed', steps: 1 },
      },
      { kind: 'turn_end', stopReason: 'end_turn' },
    ],
    subagentLogs: new Map<string, ChatEvent[]>([
      ['early', [{ kind: 'agent_message', text: 'early work' }]],
      ['late', [{ kind: 'agent_message', text: 'late work' }]],
    ]),
  })

  const fork = await h.client.forkSession(h.sessionId, 1)
  assert.ok(fork)
  assert.deepEqual(h.client.getSessionEvents(fork.id, 'early'), [{ kind: 'agent_message', text: 'early work' }])
  assert.equal(h.client.getSessionEvents(fork.id, 'late'), null)
  assert.deepEqual(
    [...(h.client.getSubagentLogs(fork.id) ?? [])],
    [['early', [{ kind: 'agent_message', text: 'early work' }]]],
  )
  await h.client.deleteSession(fork.id)
  await h.client.deleteSession(h.sessionId)
})

test('getLogEntry reads an entry as its log holds it now, grown past the frame that named it', async () => {
  const h = await open({ compactLog: true })
  delegate(h, 'worker')
  // The chunks of the subagent's first reply named one entry, which grew.
  const chunkFrames = h.frames.filter(
    (frame) => frame.event.kind === 'subagent_event' && frame.event.event.kind === 'agent_message',
  )
  const named = chunkFrames.map((frame) => (frame.event.kind === 'subagent_event' ? frame.event.position : null))
  assert.deepEqual(named, [0, 0])
  assert.deepEqual(h.client.getLogEntry(h.sessionId, 0, 'worker'), {
    kind: 'agent_message',
    text: 'digging',
    messageId: 'c1',
  })
  assert.deepEqual(h.client.getLogEntry(h.sessionId, 0), RECORDED[0])
  assert.equal(h.client.getLogEntry(h.sessionId, 99, 'worker'), undefined)
  assert.equal(h.client.getLogEntry(h.sessionId, 0, 'unknown'), undefined)
  assert.equal(h.client.getLogEntry('no-such-session', 0), undefined)
  assert.deepEqual([...(h.client.getSubagentLogs(h.sessionId)?.keys() ?? [])], ['worker'])
  assert.equal(h.client.getSubagentLogs('no-such-session'), null)
  await h.client.deleteSession(h.sessionId)
})
