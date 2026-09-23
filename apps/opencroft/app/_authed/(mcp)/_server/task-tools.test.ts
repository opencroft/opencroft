// The tool side of background tasks: what a caller is told when one starts, how
// a task reads back, what a cancel reports, what a tool's answer becomes as a
// task's result, and how an action call is routed by its declaration. How the
// registry routes a tool call is background-calls.test.ts's, end to end.
//
// The service is a stand-in throughout, put in place through the module's own
// seam: the real one writes records and starts processes on nodes, and what is
// under test here is what the tools ask of it and what they make of its answers.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'

import type {
  BackgroundTaskOwner,
  BackgroundTaskRecord,
  BackgroundTaskService,
  CancelOutcome,
  StartInProcessTaskInput,
} from '@/app/_authed/(background-tasks)/_server/types'
import { handleToolCall, isApprovalGated, READ_ONLY_TOOLS } from './tools'

// Imported after the barrel, and lazily so the import sorter cannot hoist it:
// the family modules reach `./tools` through their shared helpers, and entering
// that cycle anywhere but the barrel meets a definition still in its temporal
// dead zone — the same reason app-address.test.ts imports remote-tools this way.
const {
  callAction,
  describeTask,
  describeTaskList,
  formatDuration,
  substituteBackgroundTaskService,
  taskResultOf,
  taskStartedText,
  timeoutMsFrom,
  toolTaskTarget,
} = await import('./task-tools')

afterEach(() => substituteBackgroundTaskService(undefined))

const T0 = new Date('2026-09-22T10:00:00.000Z')

function at(ms: number): Date {
  return new Date(T0.getTime() + ms)
}

function record(overrides: Partial<BackgroundTaskRecord> = {}): BackgroundTaskRecord {
  return {
    taskId: 'task-1',
    agent: null,
    kind: 'tool',
    runner: 'background-task-runner',
    name: 'remote_exec',
    target: 'node_abc/terminal',
    summary: 'Run the test suite',
    state: 'running',
    startedAt: T0,
    timeoutMs: 3_600_000,
    ...overrides,
  }
}

function unused(): never {
  throw new Error('this test did not expect the service to be asked that')
}

/** A service that records what it is asked and answers from `overrides`. */
function fakeService(overrides: Partial<BackgroundTaskService> = {}) {
  const inProcess: StartInProcessTaskInput[] = []
  const owners: BackgroundTaskOwner[] = []
  const service: BackgroundTaskService = {
    startRunnerTask: async () => unused(),
    startInProcessTask: async (input) => {
      inProcess.push(input)
      return record({
        taskId: 'task-9',
        kind: input.kind,
        runner: 'in-process',
        name: input.name,
        target: input.target,
        summary: input.summary,
      })
    },
    get: async () => unused(),
    listForOwner: async (owner) => {
      owners.push(owner)
      return []
    },
    listRunning: async () => unused(),
    cancel: async () => unused(),
    runningSessionKeys: () => unused(),
    ...overrides,
  }
  substituteBackgroundTaskService(service)
  return { inProcess, owners }
}

function text(result: Record<string, unknown>): string {
  return (result.content as { text: string }[])[0]?.text ?? ''
}

function invalidParams(pattern: RegExp) {
  return (err: { code?: number; message?: string }) => {
    assert.equal(err.code, -32602, `expected an invalid-params failure, got ${JSON.stringify(err)}`)
    assert.match(err.message ?? '', pattern)
    return true
  }
}

// ── timeoutMinutes ───────────────────────────────────────────────────

test('timeoutMinutes: an hour when absent, no limit at 0, the minutes given otherwise', () => {
  assert.equal(timeoutMsFrom(undefined), 3_600_000)
  assert.equal(timeoutMsFrom(0), null)
  assert.equal(timeoutMsFrom(90), 5_400_000)
  assert.equal(timeoutMsFrom(2.5), 150_000)
})

test('a timeoutMinutes that is not a finite number of minutes, 0 or more, is refused rather than defaulted', () => {
  for (const value of [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY, '10', null, true, {}]) {
    assert.throws(() => timeoutMsFrom(value), invalidParams(/timeoutMinutes must be a number/), String(value))
  }
})

// ── the answer to a start ────────────────────────────────────────────

test('a caller with a session is told only that the result will come to it', () => {
  const started = taskStartedText(record({ taskId: 'abc' }), { agent: 'Agent Solo', sessionId: 's-1' })
  assert.equal(
    started,
    'Started background task abc — Run the test suite. Its result will arrive in this conversation when it ends.',
  )
  // Named here, either one is an invitation to spend a turn on a task that has
  // only just started — and that is running, or the start would have failed.
  assert.doesNotMatch(started, /task_status|task_cancel/)
})

test('a caller without a session is told plainly that nothing will arrive, and to poll by id', () => {
  const started = taskStartedText(record({ taskId: 'abc' }), { agent: 'Agent Solo' })
  assert.match(started, /^Started background task abc — Run the test suite\. /)
  assert.match(started, /No notification will arrive: this caller has no session\./)
  assert.match(started, /Poll task_status with taskId "abc"/)
  assert.doesNotMatch(started, /arrive in this conversation/)
})

test('a summary that already ends a sentence is not given a second full stop', () => {
  const owner = { agent: null, sessionId: 's-1' }
  assert.match(taskStartedText(record({ summary: 'Deploy to eu.' }), owner), /— Deploy to eu\. Its result/)
  assert.match(taskStartedText(record({ summary: 'Ship it!' }), owner), /— Ship it! Its result/)
})

test('durations read the way a person reads them', () => {
  assert.equal(formatDuration(45_900), '45s')
  assert.equal(formatDuration(725_000), '12m 5s')
  assert.equal(formatDuration(60_000), '1m')
  assert.equal(formatDuration(7_380_000), '2h 3m')
  assert.equal(formatDuration(3_600_000), '1h')
})

// ── task_status ──────────────────────────────────────────────────────

test('a running runner task: state, timing with its deadline, the log and how to read it, the end of its output', () => {
  const described = describeTask(record({ logPath: '/tmp/task-1.log', outputTail: 'line 1\nline 2\n' }), at(725_000))
  assert.equal(
    described,
    [
      'Task task-1: running',
      'remote_exec on node_abc/terminal — Run the test suite',
      'Timing: started 2026-09-22T10:00:00Z, running for 12m 5s; times out after 1h.',
      'Full log: remote_read target="node_abc/terminal" path="/tmp/task-1.log"',
      'Output (the end of it):',
      'line 1',
      'line 2',
    ].join('\n'),
  )
})

test('an ended task says how it ended — exit code or reason — how long it took, and no deadline', () => {
  const ended = { finishedAt: at(192_000) }
  const completed = describeTask(record({ ...ended, state: 'completed', exitCode: 0 }), at(900_000))
  assert.match(completed, /^Task task-1: completed, exit code 0$/m)
  assert.match(completed, /^Timing: started 2026-09-22T10:00:00Z, took 3m 12s\.$/m)
  assert.doesNotMatch(completed, /times out/)

  const failed = describeTask(record({ ...ended, state: 'failed', exitCode: 2, reason: 'npm ERR! missing script' }), T0)
  assert.match(failed, /^Task task-1: failed, exit code 2 — npm ERR! missing script$/m)

  const stopped = describeTask(record({ ...ended, state: 'stopped', reason: 'timed out after 1h' }), T0)
  assert.match(stopped, /^Task task-1: stopped — timed out after 1h$/m)
})

test('an in-process tool task that named nothing to run against: no target, and its result as the handler gave it', () => {
  const task = record({
    runner: 'in-process',
    name: 'index_graph',
    target: '',
    summary: 'index_graph',
    state: 'completed',
    finishedAt: at(4_000),
    outputTail: 'indexed 42 nodes\n',
  })
  assert.equal(
    describeTask(task, at(5_000)),
    [
      'Task task-1: completed',
      // Its summary was made from its name, so it is not said twice.
      'index_graph',
      'Timing: started 2026-09-22T10:00:00Z, took 4s.',
      'Result:',
      'indexed 42 nodes',
    ].join('\n'),
  )
})

test('an in-process task has no log to point at, and an empty result is said, not left blank', () => {
  const action = record({
    kind: 'app-action',
    runner: 'in-process',
    name: 'clone',
    target: 'dev.git',
    state: 'completed',
    finishedAt: at(1),
  })
  const described = describeTask(action, at(2))
  assert.match(described, /^clone on dev\.git — Run the test suite$/m)
  assert.doesNotMatch(described, /Full log|Output/)
  assert.match(described, /^No result\.$/m)
  assert.match(describeTask(record({ runner: 'in-process' }), T0), /^No result yet\.$/m)
  assert.match(describeTask(record(), T0), /^No output yet\.$/m, 'a runner task still says output')
})

test('a list: whose tasks, one line each in the order given, and where the detail is', () => {
  const listed = describeTaskList(
    [record({ taskId: 'b' }), record({ taskId: 'a', state: 'completed', exitCode: 0, finishedAt: at(62_000) })],
    { agent: 'Agent Solo', sessionId: 's-1' },
    at(300_000),
  )
  assert.deepEqual(listed.split('\n'), [
    'Background tasks started from this session, newest first:',
    'b — running — remote_exec on node_abc/terminal: Run the test suite (started 2026-09-22T10:00:00Z, running for 5m)',
    'a — completed, exit code 0 — remote_exec on node_abc/terminal: Run the test suite (started 2026-09-22T10:00:00Z, took 1m 2s)',
    'task_status with a taskId shows one task in full.',
  ])
})

test('a listed task that named nothing to run against has no " on "', () => {
  const listed = describeTaskList(
    [record({ taskId: 'c', runner: 'in-process', name: 'index_graph', target: '', summary: 'Index the graph' })],
    { agent: null, sessionId: 's-1' },
    at(1_000),
  )
  assert.match(listed, /^c — running — index_graph: Index the graph \(started /m)
})

test('an empty list says which caller it looked for', () => {
  assert.equal(
    describeTaskList([], { agent: 'Agent Solo', sessionId: 's-1' }, T0),
    'No background tasks were started from this session.',
  )
  assert.equal(
    describeTaskList([], { agent: 'Agent Solo' }, T0),
    'No background tasks were started by Agent Solo outside a session.',
  )
})

test('a long list is cut at twenty, and says how many it left out', () => {
  const many = Array.from({ length: 25 }, (_, i) => record({ taskId: `t${i}` }))
  const listed = describeTaskList(many, { agent: null, sessionId: 's-1' }, T0)
  assert.match(listed, /^t19 — /m)
  assert.doesNotMatch(listed, /^t20 — /m)
  assert.match(listed, /^… and 5 older, not shown\.$/m)
})

test('task_status with a taskId reads that task through the service', async () => {
  const asked: string[] = []
  fakeService({
    get: async (taskId) => {
      asked.push(taskId)
      return record({ taskId })
    },
  })
  const result = await handleToolCall('task_status', { taskId: 'task-7' }, { internal: true })
  assert.deepEqual(asked, ['task-7'])
  assert.match(text(result), /^Task task-7: running$/m)
})

test('task_status with an id that names no task is a bad argument, not an empty answer', async () => {
  fakeService({ get: async () => null })
  await assert.rejects(
    handleToolCall('task_status', { taskId: 'nope' }, { internal: true }),
    invalidParams(/No background task has id "nope"/),
  )
})

test('task_status without a taskId lists the calling session’s tasks', async () => {
  const { owners } = fakeService()
  await handleToolCall('task_status', {}, { internal: true, callerAgent: 'Agent Solo', callerSessionId: 's-9' })
  assert.deepEqual(owners, [{ agent: 'Agent Solo', sessionId: 's-9' }])
})

test('without a session it lists the agent’s own; with neither it refuses instead of listing everyone’s', async () => {
  const { owners } = fakeService()
  const listed = await handleToolCall('task_status', {}, { internal: true, callerAgent: 'Agent Solo' })
  assert.deepEqual(owners, [{ agent: 'Agent Solo' }], 'no session key at all, not an undefined one')
  assert.match(text(listed), /by Agent Solo outside a session/)

  await assert.rejects(
    handleToolCall('task_status', {}, { internal: true }),
    invalidParams(/neither a session nor an agent identity/),
  )
  assert.equal(owners.length, 1, 'the anonymous caller never reached the service')
})

// ── task_cancel ──────────────────────────────────────────────────────

test('each cancel outcome is reported as what it was', async () => {
  const replies: Partial<Record<CancelOutcome, string>> = {}
  for (const outcome of ['stopped', 'requested', 'not-running'] as const) {
    fakeService({ cancel: async () => outcome })
    replies[outcome] = text(await handleToolCall('task_cancel', { taskId: 'task-3' }, { internal: true }))
  }
  assert.equal(replies.stopped, 'Stopped background task task-3.')
  assert.match(replies.requested ?? '', /^Asked background task task-3 to stop\. It runs inside this server/)
  assert.match(replies.requested ?? '', /does not honour the request runs on until it ends by itself/)
  assert.match(replies['not-running'] ?? '', /^Background task task-3 had already ended; nothing was stopped\./)
})

test('cancelling an id that names no task is a bad argument', async () => {
  fakeService({ cancel: async () => 'unknown-task' })
  await assert.rejects(
    handleToolCall('task_cancel', { taskId: 'nope' }, { internal: true }),
    invalidParams(/No background task has id "nope"/),
  )
})

test('task_cancel is gated like the other tools that change something; task_status is a declared read', () => {
  assert.equal(isApprovalGated('task_cancel'), true)
  assert.equal(READ_ONLY_TOOLS.has('task_cancel'), false)
  assert.equal(READ_ONLY_TOOLS.has('task_status'), true)
})

// ── a tool's answer, as a task's ────────────────────────────────────

test('a tool task’s result is the text its call answered with, verbatim, and only that', () => {
  assert.equal(taskResultOf({ content: [{ type: 'text', text: '  two spaces kept  ' }] }), '  two spaces kept  ')
  assert.equal(
    taskResultOf({
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        { type: 'text', text: 'second' },
      ],
    }),
    'first\nsecond',
  )
  assert.equal(taskResultOf({ content: [] }), '')
})

test('an answer flagged isError fails the task with its text as the reason', () => {
  assert.throws(
    () => taskResultOf({ content: [{ type: 'text', text: 'the index is locked' }], isError: true }),
    (err: Error) => err instanceof Error && err.message === 'the index is locked',
  )
  assert.throws(() => taskResultOf({ content: [], isError: true }), /reported an error without a message/)
})

test('what a tool task runs against: a terminal target, a node, an app by its address — or nothing', () => {
  assert.equal(toolTaskTarget({ target: 'node_1/terminal', nodeId: 'node_2' }), 'node_1/terminal')
  assert.equal(toolTaskTarget({ nodeId: 'node_2' }), 'node_2')
  assert.equal(toolTaskTarget({ app: 'dev.git' }), 'dev.git')
  assert.equal(
    toolTaskTarget({ app: '0b6c1f38-8f0e-4c55-9d7b-0a4c9c1d2e3f' }),
    '',
    'a uuid is not what a task is listed under',
  )
  assert.equal(toolTaskTarget({ target: '  ', query: 'x' }), '')
  assert.equal(toolTaskTarget({}), '')
})

// ── routing an action by its declaration ─────────────────────────────

const TASK = { kind: 'node-action' as const, name: 'deploy', target: 'node_1', summary: 'Deploy on node_1' }

function recordingRun() {
  const runs: { params: Record<string, unknown>; signal?: AbortSignal }[] = []
  const run = async (params: Record<string, unknown>, signal?: AbortSignal) => {
    runs.push({ params, signal })
    return 'dispatched'
  }
  return { runs, run }
}

test('an async action becomes an in-process task at once, and the task runs the dispatch', async () => {
  const { inProcess } = fakeService()
  const { runs, run } = recordingRun()
  const caller = { agent: 'Agent Solo', sessionId: 's-1' }
  const outcome = await callAction({ execution: 'async', params: { region: 'eu' }, caller, task: TASK, run })

  assert.ok('started' in outcome, 'the call answers with the task, not a result')
  assert.match(outcome.started, /^Started background task task-9 — /)
  assert.equal(inProcess.length, 1)
  const [start] = inProcess
  assert.deepEqual(start.owner, { agent: 'Agent Solo', sessionId: 's-1' })
  assert.deepEqual(
    { kind: start.kind, name: start.name, target: start.target, summary: start.summary },
    { kind: 'node-action', name: 'deploy', target: 'node_1', summary: 'Deploy on node_1' },
  )
  assert.equal(start.timeoutMs, 3_600_000)
  assert.equal(runs.length, 0, 'nothing is dispatched until the service runs the task')

  const controller = new AbortController()
  assert.equal(await start.run(controller.signal), 'dispatched')
  assert.deepEqual(runs, [{ params: { region: 'eu' }, signal: controller.signal }])
})

test('an async action’s params are its own: a `background` it was sent is not the host’s to take', async () => {
  const { inProcess } = fakeService()
  const { runs, run } = recordingRun()
  await callAction({
    execution: 'async',
    params: { background: false, timeoutMinutes: 1 },
    caller: { agent: null },
    task: TASK,
    run,
  })
  assert.equal(inProcess[0]?.timeoutMs, 3_600_000, 'the schema offered no timeout, so none was read')
  await inProcess[0]?.run(new AbortController().signal)
  assert.deepEqual(runs[0]?.params, { background: false, timeoutMinutes: 1 })
})

test('an awaitable action without background runs in place, and the handler never sees the two host params', async () => {
  const { inProcess } = fakeService()
  const { runs, run } = recordingRun()
  for (const params of [{ region: 'eu' }, { region: 'eu', background: false, timeoutMinutes: 5 }]) {
    const outcome = await callAction({ execution: 'awaitable', params, caller: { agent: null }, task: TASK, run })
    assert.deepEqual(outcome, { result: 'dispatched' })
  }
  assert.equal(inProcess.length, 0)
  assert.deepEqual(
    runs.map((r) => r.params),
    [{ region: 'eu' }, { region: 'eu' }],
  )
})

test('an awaitable action with background: true is a task with the caller’s timeout, run without the two', async () => {
  const { inProcess } = fakeService()
  const { runs, run } = recordingRun()
  const params = { region: 'eu', background: true, timeoutMinutes: 5 }
  const outcome = await callAction({ execution: 'awaitable', params, caller: { agent: null }, task: TASK, run })
  assert.ok('started' in outcome)
  assert.equal(inProcess[0]?.timeoutMs, 300_000)
  await inProcess[0]?.run(new AbortController().signal)
  assert.deepEqual(runs[0]?.params, { region: 'eu' })

  await callAction({
    execution: 'awaitable',
    params: { background: true, timeoutMinutes: 0 },
    caller: { agent: null },
    task: TASK,
    run,
  })
  assert.equal(inProcess[1]?.timeoutMs, null, '0 is no limit')
})

test('an awaitable action with a malformed timeout is refused before anything starts or runs', async () => {
  const { inProcess } = fakeService()
  const { runs, run } = recordingRun()
  await assert.rejects(
    callAction({
      execution: 'awaitable',
      params: { background: true, timeoutMinutes: -5 },
      caller: { agent: null },
      task: TASK,
      run,
    }),
    invalidParams(/timeoutMinutes/),
  )
  assert.equal(inProcess.length, 0)
  assert.equal(runs.length, 0)
})

test('a sync action, or one nobody declared, runs in place with its params untouched', async () => {
  const { inProcess } = fakeService()
  const { runs, run } = recordingRun()
  for (const execution of ['sync', undefined] as const) {
    const params = { background: true, timeoutMinutes: 5 }
    const outcome = await callAction({ execution, params, caller: { agent: null }, task: TASK, run })
    assert.deepEqual(outcome, { result: 'dispatched' })
  }
  assert.equal(inProcess.length, 0)
  assert.deepEqual(
    runs.map((r) => r.params),
    [
      { background: true, timeoutMinutes: 5 },
      { background: true, timeoutMinutes: 5 },
    ],
  )
})
