import assert from 'node:assert/strict'
import test from 'node:test'

import { foldEvents } from './fold'
import { compactTranscript, type LogWrite, SESSION_LOG, TranscriptLog } from './transcript-log'
import type { ChatEvent } from './types'

const say = (text: string, messageId?: string): ChatEvent => ({
  kind: 'agent_message',
  text,
  ...(messageId ? { messageId } : {}),
})
const think = (text: string): ChatEvent => ({ kind: 'agent_thought', text })
const call = (toolCallId: string): ChatEvent => ({ kind: 'tool_call', toolCallId, title: 'Read', status: 'pending' })
const update = (toolCallId: string, fields: Omit<Extract<ChatEvent, { kind: 'tool_update' }>, 'kind' | 'toolCallId'>) =>
  ({ kind: 'tool_update', toolCallId, ...fields }) satisfies ChatEvent
const step = (subagentSessionId: string, event: ChatEvent): ChatEvent => ({
  kind: 'subagent_event',
  subagentSessionId,
  event,
})
const spawn = (subagentSessionId: string, state?: string): ChatEvent => ({
  kind: 'subagent',
  subagent: { subagentSessionId, name: 'Worker', task: 'dig', ...(state ? { state } : {}) },
})

function appendAll(log: TranscriptLog, events: ChatEvent[]): LogWrite[] {
  return events.flatMap((event) => log.append(event))
}

// What a reader draws from a log, ids aside: the ids count messages, and a
// merged log is allowed fewer events, never different messages.
function drawn(events: ChatEvent[]) {
  return foldEvents(events).map(({ id: _id, ...message }) => message)
}

test('a run of chunks of one message is one entry, drawn as the chunks were', () => {
  const events = [{ kind: 'user', text: 'go' } as ChatEvent, say('Hel', 'm1'), say('lo', 'm1'), say(' there', 'm1')]
  const log = new TranscriptLog()
  appendAll(log, events)
  assert.deepEqual(log.entries(), [events[0], say('Hello there', 'm1')])
  assert.deepEqual(drawn(log.entries() ?? []), drawn(events))
})

test('chunks of different messages or kinds stay apart', () => {
  const events = [say('a', 'm1'), say('b', 'm2'), think('c'), think('d'), say('e')]
  const log = new TranscriptLog()
  appendAll(log, events)
  assert.deepEqual(log.entries(), [say('a', 'm1'), say('b', 'm2'), think('cd'), say('e')])
})

test('a run stays open across what draws nothing between its chunks, and ends at what does', () => {
  const usage: ChatEvent = { kind: 'usage', used: 10 }
  const plan: ChatEvent = { kind: 'plan', entries: [] }
  const resolved: ChatEvent = { kind: 'permission_resolved', requestId: 'r1' }
  const across = [call('t1'), say('a'), usage, update('t1', { status: 'completed' }), plan, resolved, say('b')]
  const log = new TranscriptLog()
  appendAll(log, across)
  assert.deepEqual(log.entries(), [call('t1'), say('ab'), usage, update('t1', { status: 'completed' }), plan, resolved])
  assert.deepEqual(drawn(log.entries() ?? []), drawn(across))

  const broken = new TranscriptLog()
  appendAll(broken, [say('a'), call('t2'), say('b'), { kind: 'turn_end', stopReason: 'end_turn' }, say('c')])
  assert.deepEqual(
    broken.entries()?.filter((event) => event.kind === 'agent_message'),
    [say('a'), say('b'), say('c')],
    'a tool call and a turn boundary each end the run',
  )
})

test("a tool call's updates are one entry at the first update, merged field by field", () => {
  const events = [
    call('t1'),
    update('t1', { status: 'in_progress', input: { path: 'a' } }),
    say('reading'),
    update('t1', { output: 'partial' }),
    update('t1', { status: 'completed', output: 'whole' }),
  ]
  const log = new TranscriptLog()
  const writes = appendAll(log, events)
  assert.deepEqual(log.entries(), [
    call('t1'),
    update('t1', { status: 'completed', input: { path: 'a' }, output: 'whole' }),
    say('reading'),
  ])
  assert.deepEqual(
    writes.map((write) => [write.position, write.appended]),
    [
      [0, true],
      [1, true],
      [2, true],
      [1, false],
      [1, false],
    ],
  )
  assert.deepEqual(drawn(log.entries() ?? []), drawn(events))
})

test('an update that comes before its call stays its own entry, and the updates after the call merge after it', () => {
  // A permission request carries the call's diffs as an update, and can come
  // before the call is announced.
  const events = [
    update('t1', { diffs: [{ path: 'a', oldText: null, newText: 'x' }] }),
    call('t1'),
    update('t1', { status: 'in_progress' }),
    update('t1', { status: 'completed', output: 'done' }),
  ]
  const log = new TranscriptLog()
  appendAll(log, events)
  assert.deepEqual(drawn(log.entries() ?? []), drawn(events))
  assert.deepEqual(log.entries(), [
    update('t1', { diffs: [{ path: 'a', oldText: null, newText: 'x' }] }),
    call('t1'),
    update('t1', { status: 'completed', output: 'done' }),
  ])
})

test("a call's updates merge within a turn, and one after the turn's end is its own entry", () => {
  // The turn's end reads a still-open call as cancelled; an update after it
  // reads on top of that, so it must not be folded in before the end.
  const events = [
    call('t1'),
    update('t1', { status: 'in_progress' }),
    { kind: 'turn_end', stopReason: 'cancelled' } as ChatEvent,
    update('t1', { status: 'in_progress', output: 'more' }),
  ]
  const log = new TranscriptLog()
  appendAll(log, events)
  assert.deepEqual(drawn(log.entries() ?? []), drawn(events))
  assert.deepEqual(log.entries(), events)
})

test('a log built over recorded entries merges only into an update recorded after its call, in the turn', () => {
  const recorded: ChatEvent[] = [update('t1', { diffs: [{ path: 'a', oldText: null, newText: 'x' }] }), call('t1')]
  const log = new TranscriptLog(recorded)
  appendAll(log, [update('t1', { status: 'in_progress' }), update('t1', { status: 'completed' })])
  assert.deepEqual(log.entries(), [
    update('t1', { diffs: [{ path: 'a', oldText: null, newText: 'x' }] }),
    call('t1'),
    update('t1', { status: 'completed' }),
  ])

  const ended: ChatEvent[] = [
    call('t2'),
    update('t2', { status: 'in_progress' }),
    { kind: 'turn_end', stopReason: 'cancelled' },
  ]
  const resumed = new TranscriptLog([...ended])
  appendAll(resumed, [update('t2', { status: 'in_progress', output: 'more' })])
  assert.deepEqual(resumed.entries(), [...ended, update('t2', { status: 'in_progress', output: 'more' })])
})

test('a mixed transcript draws the same compacted as appended, in the session and in each subagent', () => {
  const compaction = (status: 'running' | 'completed'): ChatEvent => ({
    kind: 'compaction',
    compaction: {
      compactionId: 'c1',
      trigger: 'automatic',
      status,
      ...(status === 'completed' ? { summary: 'short' } : {}),
    },
  })
  const commands: ChatEvent = { kind: 'available_commands', commands: [{ name: 'compact', description: '' }] }
  const subagentSteps: ChatEvent[] = [
    { kind: 'user', text: 'dig here' },
    update('s1', { diffs: [{ path: 'b', oldText: null, newText: 'y' }] }),
    say('look', 'n1'),
    call('s1'),
    say('ing', 'n1'),
    update('s1', { status: 'completed', output: 'found' }),
    think('hm'),
    think('m'),
  ]
  const events: ChatEvent[] = [
    commands,
    { kind: 'user', text: 'go' },
    update('t1', { diffs: [{ path: 'a', oldText: null, newText: 'x' }] }),
    { kind: 'permission_request', requestId: 'r1', title: 'Edit a', options: [] },
    say('Hel', 'm1'),
    { kind: 'usage', used: 10 },
    say('lo', 'm1'),
    call('t1'),
    { kind: 'permission_resolved', requestId: 'r1', optionId: 'allow' },
    update('t1', { status: 'in_progress' }),
    spawn('w'),
    ...subagentSteps.map((event) => step('w', event)),
    compaction('running'),
    { kind: 'usage', used: 20 },
    commands,
    compaction('completed'),
    call('t2'),
    { kind: 'turn_end', stopReason: 'end_turn' },
    update('t1', { status: 'completed', output: 'late' }),
    update('t2', { status: 'failed' }),
    { kind: 'user', text: 'again' },
    say('fine'),
    spawn('w', 'completed'),
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  const { log } = compactTranscript(events)
  assert.ok((log.entries()?.length ?? 0) < events.length - subagentSteps.length, 'the session log is compacted')
  assert.deepEqual(drawn(log.entries() ?? []), drawn(events))
  assert.ok((log.entries('w')?.length ?? 0) < subagentSteps.length, "the subagent's log is compacted")
  assert.deepEqual(drawn(log.entries('w') ?? []), drawn(subagentSteps))
})

test('an entity keeps one entry at its first sighting, holding its newest state', () => {
  const task = (state: string): ChatEvent => ({
    kind: 'async_task',
    task: {
      asyncTaskId: 'job',
      name: 'build',
      taskType: 'shell',
      description: '',
      state,
      canStop: true,
      showInTranscript: true,
    },
  })
  const log = new TranscriptLog()
  appendAll(log, [task('running'), say('meanwhile'), task('completed')])
  assert.deepEqual(log.entries(), [task('completed'), say('meanwhile')])
})

test('usage keeps one entry per turn, and a reading without a cost keeps the last cost', () => {
  const cost = { amount: 1.5, currency: 'USD' }
  const log = new TranscriptLog()
  appendAll(log, [
    { kind: 'user', text: 'one' },
    { kind: 'usage', used: 10, cost },
    say('a'),
    { kind: 'usage', used: 20 },
    { kind: 'turn_end', stopReason: 'end_turn' },
    { kind: 'user', text: 'two' },
    { kind: 'usage', used: 30 },
  ])
  assert.deepEqual(
    log.entries()?.filter((event) => event.kind === 'usage'),
    [
      { kind: 'usage', used: 20, cost },
      { kind: 'usage', used: 30 },
    ],
  )
})

test('a snapshot equal to the current one is not appended; a changed one is', () => {
  const commands = (name: string): ChatEvent => ({ kind: 'available_commands', commands: [{ name, description: '' }] })
  const log = new TranscriptLog()
  assert.equal(log.append(commands('compact')).length, 1)
  assert.deepEqual(log.append(commands('compact')), [], 'the same snapshot again writes nothing')
  assert.equal(log.append(commands('review')).length, 1)
  assert.equal(log.append(commands('compact')).length, 1, 'equal to an older one is still a change')
  assert.equal(log.entries()?.length, 3)
})

test("a subagent's steps go to its own log, and its header counts them where it stands", () => {
  const log = new TranscriptLog()
  const writes = appendAll(log, [
    { kind: 'user', text: 'delegate' },
    spawn('w'),
    step('w', { kind: 'user', text: 'dig here' }),
    step('w', say('dug ')),
    step('w', say('deep')),
    step('w', call('t1')),
    step('w', update('t1', { status: 'completed' })),
    step('w', think('done?')),
    spawn('w', 'completed'),
  ])

  assert.deepEqual(log.entries(), [
    { kind: 'user', text: 'delegate' },
    {
      kind: 'subagent',
      subagent: { subagentSessionId: 'w', name: 'Worker', task: 'dig', state: 'completed', steps: 3 },
    },
  ])
  assert.deepEqual(log.entries('w'), [
    { kind: 'user', text: 'dig here' },
    say('dug deep'),
    call('t1'),
    update('t1', { status: 'completed' }),
    think('done?'),
  ])
  assert.equal(log.stepsOf('w'), 3)
  // The header counts what the section draws: one block per step.
  const blocks = foldEvents(log.entries('w') ?? []).filter((message) => message.kind !== 'user')
  assert.equal(blocks.length, log.stepsOf('w'))
  // Each step that added an entry rewrote the header: three steps, three rewrites.
  const headerRewrites = writes.filter(
    (write) => write.log === SESSION_LOG && write.position === 1 && !write.appended && write.event.kind === 'subagent',
  )
  assert.deepEqual(
    headerRewrites.map((write) => (write.event.kind === 'subagent' ? write.event.subagent.steps : null)),
    [1, 2, 3, 3],
    'one per new step, then the state change',
  )
})

test('a subagent spawned by a subagent is announced in the log of the one that spawned it', () => {
  const log = new TranscriptLog()
  appendAll(log, [spawn('outer'), step('outer', spawn('inner')), step('outer', step('inner', say('hi')))])
  assert.deepEqual(
    log.entries()?.map((event) => event.kind),
    ['subagent'],
  )
  assert.deepEqual(log.entries('outer'), [
    { kind: 'subagent', subagent: { subagentSessionId: 'inner', name: 'Worker', task: 'dig', steps: 1 } },
  ])
  assert.deepEqual(log.entries('inner'), [say('hi')])
  assert.equal(log.stepsOf('outer'), 0, "the inner subagent's header is not a step of the outer one")
})

test('a step for a subagent never announced still lands in its log, and a late header carries the count', () => {
  const log = new TranscriptLog()
  appendAll(log, [step('w', say('early')), spawn('w', 'completed')])
  assert.deepEqual(log.entries('w'), [say('early')])
  assert.deepEqual(log.entries(), [
    {
      kind: 'subagent',
      subagent: { subagentSessionId: 'w', name: 'Worker', task: 'dig', state: 'completed', steps: 1 },
    },
  ])
})

test('a log built over recorded entries goes on compacting where they left off', () => {
  const recorded: ChatEvent[] = [
    { kind: 'modes', available: [], current: 'default' },
    spawn('w'),
    call('t1'),
    update('t1', { status: 'in_progress' }),
  ]
  const log = new TranscriptLog(recorded, new Map([['w', [say('one'), call('t2')]]]))
  appendAll(log, [
    { kind: 'modes', available: [], current: 'default' },
    update('t1', { status: 'completed' }),
    step('w', say('two')),
  ])
  assert.equal(log.entries(), recorded, 'appends into the array it was given')
  assert.deepEqual(log.entries(), [
    { kind: 'modes', available: [], current: 'default' },
    { kind: 'subagent', subagent: { subagentSessionId: 'w', name: 'Worker', task: 'dig', steps: 3 } },
    call('t1'),
    update('t1', { status: 'completed' }),
  ])
  assert.deepEqual(log.entries('w'), [say('one'), call('t2'), say('two')])
})

test('compactTranscript rewrites a recorded log and says where each old event went', () => {
  const recorded: ChatEvent[] = [
    { kind: 'user', text: 'go' },
    say('a'),
    say('b'),
    spawn('w'),
    step('w', say('dug')),
    { kind: 'config_options', options: [] },
    { kind: 'config_options', options: [] },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  const { log, placed } = compactTranscript(recorded)
  assert.deepEqual(log.entries(), [
    { kind: 'user', text: 'go' },
    say('ab'),
    { kind: 'subagent', subagent: { subagentSessionId: 'w', name: 'Worker', task: 'dig', steps: 1 } },
    { kind: 'config_options', options: [] },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ])
  assert.deepEqual(log.subagentLogs(), new Map([['w', [say('dug')]]]))
  assert.deepEqual(placed, [
    { log: '', position: 0 },
    { log: '', position: 1 },
    { log: '', position: 1 },
    { log: '', position: 2 },
    { log: 'w', position: 0 },
    { log: '', position: 3 },
    null,
    { log: '', position: 4 },
  ])
})
