import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_PRESENCE } from 'agent-client/presence'
import type { AsyncTaskInfo, ChatEvent } from 'agent-client/types'

import { buildBlocks } from '@/app/_authed/(agent)/_lib/build-blocks'
import { fold } from './use-acp-session'

function turn(userText: string, replyText: string): ChatEvent[] {
  return [
    { kind: 'user', text: userText },
    { kind: 'agent_message', text: replyText },
  ]
}

test('message ids are baseIndex + event position', () => {
  const events = [...turn('q0', 'a0'), ...turn('q1', 'a1')]
  const { messages } = fold(events, 100)
  assert.deepEqual(
    messages.map((m) => m.id),
    [100, 101, 102, 103],
  )
})

test('a message keeps the same id when the same events are re-folded with a lower baseIndex after a prepend', () => {
  // Simulates loadMoreHistory: the tail arrives first (baseIndex 10, say),
  // then an older page of 2 raw events gets prepended and baseIndex drops by
  // 2 — every event already in the tail must keep its original id.
  const tailEvents = turn('q1', 'a1')
  const tailFold = fold(tailEvents, 10)
  const tailIds = tailFold.messages.map((m) => m.id)

  const olderEvents = turn('q0', 'a0')
  const combined = [...olderEvents, ...tailEvents]
  const combinedFold = fold(combined, 10 - olderEvents.length)

  // The two messages that were already visible (q1/a1) must have identical
  // ids before and after the prepend — this is what a stable React key
  // depends on; if it changed, React would treat them as new nodes and
  // rewrite/reuse DOM across the whole visible range instead of just
  // inserting the new older content above.
  const combinedTailIds = combinedFold.messages.slice(-tailIds.length).map((m) => m.id)
  assert.deepEqual(combinedTailIds, tailIds)
})

test('thinking is waiting minus delegation: dots drop while a subagent runs, waiting stays', () => {
  const spawned: ChatEvent[] = [
    { kind: 'user', text: 'delegate this' },
    { kind: 'agent_message', text: 'spawning a worker' },
    { kind: 'subagent', subagent: { subagentSessionId: 'child-1', name: 'Worker', task: 'dig' } },
  ]
  const during = fold(spawned, 0)
  assert.equal(during.waiting, true, 'the turn is still open — Stop applies')
  assert.equal(during.thinking, false, 'but nothing is being generated: no dots')

  const closed = fold(
    [
      ...spawned,
      { kind: 'subagent', subagent: { subagentSessionId: 'child-1', name: 'Worker', task: 'dig', state: 'completed' } },
    ],
    0,
  )
  assert.equal(closed.thinking, true, 'the delegation over, the open turn is the agent thinking again')

  const ended = fold([...spawned, { kind: 'turn_end', stopReason: 'end_turn' }], 0)
  assert.equal(ended.waiting, false)
  assert.equal(ended.thinking, false)
})

test('a subagent spawned by a subagent folds into its parent’s block, and holds the turn while it runs', () => {
  // The engine's nesting (see ChatEvent's subagent_event): the grandchild is
  // announced inside the child's step, and its own steps come wrapped twice.
  const helper = { subagentSessionId: 'helper', name: 'Helper', task: 'check one half' }
  const events: ChatEvent[] = [
    { kind: 'user', text: 'delegate this' },
    { kind: 'subagent', subagent: { subagentSessionId: 'worker', name: 'Worker', task: 'split the job' } },
    { kind: 'subagent_event', subagentSessionId: 'worker', event: { kind: 'agent_message', text: 'splitting' } },
    { kind: 'subagent_event', subagentSessionId: 'worker', event: { kind: 'subagent', subagent: helper } },
    {
      kind: 'subagent_event',
      subagentSessionId: 'worker',
      event: { kind: 'subagent_event', subagentSessionId: 'helper', event: { kind: 'agent_message', text: 'half ' } },
    },
    {
      kind: 'subagent_event',
      subagentSessionId: 'worker',
      event: { kind: 'subagent_event', subagentSessionId: 'helper', event: { kind: 'agent_message', text: 'checked' } },
    },
  ]
  const running = fold(events, 0)
  assert.deepEqual(running.messages[1]?.parts, [
    {
      type: 'subagent',
      subagentSessionId: 'worker',
      name: 'Worker',
      task: 'split the job',
      state: undefined,
      parts: [
        { type: 'text', text: 'splitting' },
        {
          type: 'subagent',
          subagentSessionId: 'helper',
          name: 'Helper',
          task: 'check one half',
          state: undefined,
          parts: [{ type: 'text', text: 'half checked' }],
        },
      ],
    },
  ])
  assert.equal(running.thinking, false, 'delegated work, not the agent generating')

  const closed = fold(
    [
      ...events,
      {
        kind: 'subagent_event',
        subagentSessionId: 'worker',
        event: { kind: 'subagent', subagent: { ...helper, state: 'completed' } },
      },
      {
        kind: 'subagent',
        subagent: { subagentSessionId: 'worker', name: 'Worker', task: 'split the job', state: 'completed' },
      },
    ],
    0,
  )
  const worker = closed.messages[1]?.parts[0]
  assert.ok(worker?.type === 'subagent')
  assert.equal(worker.state, 'completed')
  assert.equal(worker.parts[1]?.type === 'subagent' ? worker.parts[1].state : null, 'completed')
  assert.equal(closed.thinking, true, 'the delegation over, the open turn is the agent thinking again')
})

test('a multi-chunk assistant reply keeps the id of its FIRST chunk, not its last', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    { kind: 'agent_message', text: 'chunk one ' },
    { kind: 'agent_message', text: 'chunk two ' },
    { kind: 'agent_message', text: 'chunk three' },
  ]
  const { messages } = fold(events, 0)
  assert.equal(messages.length, 2)
  assert.equal(messages[1].id, 1) // the first agent_message chunk's position
  assert.equal(messages[1].role, 'assistant')
  const [part] = messages[1].parts
  assert.equal(part.type, 'text')
  assert.equal(part.type === 'text' ? part.text : '', 'chunk one chunk two chunk three')
})

test('a tool_call keeps the id of the raw event that opened it, unaffected by later tool_update chunks', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    { kind: 'tool_call', toolCallId: 't1', title: 'Read', status: 'pending', input: {} },
    { kind: 'tool_update', toolCallId: 't1', status: 'completed', output: 'done' },
  ]
  const { messages } = fold(events, 50)
  assert.equal(messages[1].id, 51)
})

test('a session nobody has set a cadence for reads in realtime', () => {
  // What every session did before a reading cadence existed. A new setting
  // must not change the behaviour of one that has not asked for it, and the
  // control has to show the same answer the engine is acting on.
  assert.deepEqual(fold(turn('q', 'a'), 0).presence, DEFAULT_PRESENCE)
})

test('the last presence snapshot wins, like the queue', () => {
  // Snapshots rather than deltas, so a client that reconnects mid-stream folds
  // the last one it sees and knows what it is looking at without asking.
  const events: ChatEvent[] = [
    { kind: 'presence', presence: { kind: 'hourly' } },
    { kind: 'user', text: 'q' },
    { kind: 'presence', presence: { kind: 'custom', intervalMs: 15 * 60_000 } },
  ]
  assert.deepEqual(fold(events, 0).presence, { kind: 'custom', intervalMs: 15 * 60_000 })
})

test('the last usage snapshot wins, cost and rate limits with it', () => {
  // The ring reads one usage object; a reading that carries neither
  // decoration replaces only what it reported (the engine merges before it
  // emits, so what arrives here is already the merged snapshot).
  const events: ChatEvent[] = [
    {
      kind: 'usage',
      used: 12_000,
      size: 200_000,
      cost: { amount: 0.42, currency: 'USD' },
      rateLimits: [{ status: 'allowed', window: 'five_hour', utilization: 34 }],
    },
    { kind: 'usage', used: 13_000, size: 200_000 },
  ]
  const { usage } = fold(events, 0)
  assert.deepEqual(usage, { used: 13_000, size: 200_000 })
})

test('a typed session failure renders as its own message, not a dead turn', () => {
  // The bridge settles an exhausted turn as end_turn with the verdict in
  // _meta; the fold turns that verdict into the visible outcome of the turn.
  // No `kind`: neither bridge sends one, so the verdict arrives with the
  // label parseSessionFailure derived (agent-client's usage-meta.test.ts).
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    {
      kind: 'turn_end',
      stopReason: 'end_turn',
      failure: {
        id: 't:error',
        label: 'quota_exhausted',
        title: 'The Claude account has no available quota.',
        category: 'limit',
        severity: 'error',
      },
    },
  ]
  const { messages } = fold(events, 10)
  const failureMessage = messages.at(-1)
  assert.ok(failureMessage)
  assert.equal(failureMessage.role, 'assistant')
  const [part] = failureMessage.parts
  assert.equal(part.type, 'text')
  assert.equal(part.type === 'text' ? part.text : '', '⛔ The Claude account has no available quota.')
})

test('a typed session failure with details carries them', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    {
      kind: 'turn_end',
      stopReason: 'end_turn',
      failure: {
        id: 't:error',
        label: 'auth_required',
        title: 'Sign in to continue using Claude.',
        details: 'Please run /login',
        category: 'access',
        severity: 'error',
        actions: ['login'],
      },
    },
  ]
  const { messages } = fold(events, 0)
  const [part] = messages.at(-1)?.parts ?? []
  assert.equal(part.type === 'text' ? part.text : '', '⛔ Sign in to continue using Claude. — Please run /login')
})

test('a plain turn end adds no failure message', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'q' },
    { kind: 'agent_message', text: 'a' },
    { kind: 'turn_end', stopReason: 'end_turn' },
  ]
  const { messages } = fold(events, 0)
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant'],
  )
})

function taskEvent(over: Partial<AsyncTaskInfo> = {}): ChatEvent {
  return {
    kind: 'async_task',
    task: {
      asyncTaskId: 'bg-1',
      name: 'Watch the deploy',
      taskType: 'bash',
      description: 'tail the deploy log',
      state: 'running',
      canStop: true,
      showInTranscript: true,
      ...over,
    },
  }
}

test('a background task folds to one transcript part, patched in place at its first event', () => {
  // Every async_task event carries the entity's full state (the same
  // contract as `subagent`), so one event per transition must not stack one
  // block per transition — the later event patches the part the first
  // anchored, and the block stays in the transcript where it began.
  const events: ChatEvent[] = [
    { kind: 'user', text: 'watch it' },
    { kind: 'agent_message', text: 'starting a watcher' },
    taskEvent(),
    { kind: 'agent_message', text: 'watching' },
    taskEvent({ state: 'completed', summary: 'deploy went clean', canStop: false }),
  ]
  const folded = fold(events, 0)
  const parts = folded.messages.flatMap((m) => m.parts.filter((p) => p.type === 'async-task'))
  assert.equal(parts.length, 1)
  const [part] = parts
  assert.equal(part.type === 'async-task' ? part.state : null, 'completed')
  assert.equal(part.type === 'async-task' ? part.summary : null, 'deploy went clean')
  assert.equal(part.type === 'async-task' ? part.canStop : null, false)
  // The out-of-band list keeps working beside the part — the strip and the
  // stop-session warning read it, and the part does not replace it.
  assert.deepEqual(
    folded.asyncTasks.map((task) => task.state),
    ['completed'],
  )
})

test('a running task is delegation, not thinking — same as a live subagent', () => {
  const during = fold([{ kind: 'user', text: 'watch it' }, taskEvent()], 0)
  assert.equal(during.waiting, true, 'the turn is still open — Stop applies')
  assert.equal(during.thinking, false, 'but nothing is being generated: no dots')
})

test('a task the harness advises against drawing still gets its block', () => {
  // The shape that made this rule: a Claude Code Bash run in the background
  // arrives as a "shell" task with showInTranscript false on EVERY event, and
  // gating on the flag left the session's only background work invisible.
  // The flag rides on the part as information; the block is drawn regardless,
  // and the out-of-band list keeps carrying the task as before.
  const folded = fold([{ kind: 'user', text: 'q' }, taskEvent({ taskType: 'shell', showInTranscript: false })], 0)
  const parts = folded.messages.flatMap((m) => m.parts.filter((p) => p.type === 'async-task'))
  assert.equal(parts.length, 1)
  assert.equal(parts[0].type === 'async-task' ? parts[0].showInTranscript : null, false)
  assert.equal(folded.asyncTasks.length, 1)
})

const PLAN_EVENTS: ChatEvent[] = [
  { kind: 'plan', entries: [{ content: 'read the code', status: 'in_progress', priority: 'high' }] },
  { kind: 'agent_message', text: 'starting' },
  {
    kind: 'plan',
    entries: [
      { content: 'read the code', status: 'completed', priority: 'high' },
      { content: 'fix the fold', status: 'in_progress', priority: 'high' },
    ],
  },
]

test('the plan is session state: the latest list wins and the transcript carries no part for it', () => {
  // Every plan event carries the FULL entry list; the header's plan control
  // reads it, so the transcript holds only what the agent said around it.
  const folded = fold(PLAN_EVENTS, 0)
  assert.deepEqual(folded.plan, [
    { content: 'read the code', status: 'completed', priority: 'high' },
    { content: 'fix the fold', status: 'in_progress', priority: 'high' },
  ])
  assert.deepEqual(
    folded.messages.map((m) => m.parts.map((p) => p.type)),
    [['text']],
  )
})

test('an empty plan clears it, and the next plan replaces it', () => {
  const cleared: ChatEvent[] = [...PLAN_EVENTS, { kind: 'plan', entries: [] }]
  assert.deepEqual(fold(cleared, 0).plan, [])
  const replanned: ChatEvent[] = [
    ...cleared,
    { kind: 'plan', entries: [{ content: 'fresh plan', status: 'in_progress', priority: 'high' }] },
  ]
  assert.deepEqual(fold(replanned, 0).plan, [{ content: 'fresh plan', status: 'in_progress', priority: 'high' }])
})

test('a notice draws as a notice item in its turn, between the text around it rather than merged into it', () => {
  const events: ChatEvent[] = [
    { kind: 'user', text: 'go' },
    { kind: 'agent_message', text: 'Working' },
    { kind: 'notice', notice: { severity: 'error', title: 'Hook blocked the turn', description: 'Policy says no.' } },
    { kind: 'agent_message', text: 'Stopped.' },
  ]
  const details = buildBlocks(fold(events, 0).messages).find((block) => block.kind === 'details')
  assert.ok(details && details.kind === 'details')
  assert.deepEqual(details.items, [
    { kind: 'assistant-text', text: 'Working' },
    { kind: 'notice', severity: 'error', title: 'Hook blocked the turn', description: 'Policy says no.' },
    { kind: 'assistant-text', text: 'Stopped.' },
  ])
})
