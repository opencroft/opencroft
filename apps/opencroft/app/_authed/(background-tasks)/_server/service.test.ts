// The service's decisions, against a real database: what a start records, how
// each kind of task ends, when a session is told and when it is not, and what
// survives a restart.
//
// The engine is a double that does what the real one does back: a notify that
// answers yes, no, or not yet — the last is what sleep mode does, and it is
// the case a second notification would slip through. Nodes are a transport
// answering the way background-task-runner.test.ts shows a real node does.
// Every test runs under its own registry id, so rows from one never reach
// another.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { userText } from '@/app/_authed/(agent)/_lib/build-blocks'
import { type RunnerTransport, TAIL_MAX_BYTES } from './background-task-runner'
import type { HostAsyncTaskInfo, HostTaskEngine } from './engine'
import { BackgroundTasks, createState, deadlineOf, SERVER_RESTARTED, type ServiceDeps } from './service'
import { insertTask } from './store'
import type { BackgroundTaskRecord } from './types'

const KEY = 'group-chat.team.builder.main'
const OWNER = { agent: 'builder', sessionId: 'session-1' }

interface Session {
  id: string
  sessionKey?: string
}

function fakeEngine(sessions: Session[] = [{ id: 'session-1', sessionKey: KEY }]) {
  const upserts: { sessionId: string; task: HostAsyncTaskInfo }[] = []
  const notified: { sessionId: string; text: string }[] = []
  // What each notify answers, in turn; yes once they run out.
  const answers: (() => Promise<boolean>)[] = []
  const engine: HostTaskEngine = {
    listSessions: () => sessions,
    upsertAsyncTask: (sessionId, task) => {
      upserts.push({ sessionId, task })
      return sessions.some((session) => session.id === sessionId)
    },
    notify: (sessionId, text) => {
      notified.push({ sessionId, text })
      return (answers.shift() ?? (async () => true))()
    },
  }
  return { engine, sessions, upserts, notified, answers }
}

const TASK_IN = /opencroft-tasks\/([0-9a-f-]{36})/
const REPORTED = /report '([0-9a-f-]{36})'/g

/** A node: a directory and a pid for every launch, and the reports it is told to give. */
function fakeNode() {
  const commands: string[] = []
  const written: string[] = []
  const reports = new Map<string, string>()
  const controls: { stopReport: (taskId: string) => string; failLaunch: Error | null } = {
    stopReport: (taskId) => `opencroft-task ${taskId} vanished - 0 `,
    failLaunch: null,
  }
  const transport: RunnerTransport = {
    resolve: async (_target, cwd) => ({ ctx: { type: 'local' }, cwd }),
    secretsEnv: async () => undefined,
    writeFile: async (_ctx, filePath) => {
      written.push(filePath)
    },
    exec: async (_ctx, command) => {
      commands.push(command)
      if (command.includes('mkdir -p')) {
        return `/tmp/opencroft-tasks/${TASK_IN.exec(command)?.[1]}\n`
      }
      if (command.includes('opencroft-task "$d"')) {
        if (controls.failLaunch) {
          throw controls.failLaunch
        }
        return '4242\n'
      }
      const reported = [...command.matchAll(REPORTED)].map((match) => match[1])
      if (command.includes('kill -s TERM')) {
        return `${controls.stopReport(reported[0])}\n`
      }
      return reported.map((taskId) => `opencroft-task ${taskId} ${reports.get(taskId) ?? 'running'}`).join('\n')
    },
  }
  return {
    commands,
    written,
    reports,
    controls,
    transport,
    probes: () => commands.filter((command) => command.includes('alive() {') && !command.includes('kill -s')),
    stops: () => commands.filter((command) => command.includes('kill -s TERM')),
    launches: () => commands.filter((command) => command.includes('opencroft-task "$d"')),
  }
}

function service(options: {
  engine: HostTaskEngine
  node?: RunnerTransport
  now?: () => Date
  instanceId?: string
  openSession?: ServiceDeps['openSession']
}) {
  const instanceId = options.instanceId ?? randomUUID()
  return new BackgroundTasks(createState(), {
    instanceId: () => instanceId,
    transport: async () => options.node ?? fakeNode().transport,
    engine: async () => options.engine,
    openSession: options.openSession ?? (async () => null),
    now: options.now,
  })
}

async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error('condition never held')
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function base64(text: string): string {
  return Buffer.from(text).toString('base64')
}

function runnerTask(
  svc: BackgroundTasks,
  overrides: { owner?: typeof OWNER | { agent: string }; target?: string } = {},
) {
  return svc.startRunnerTask({
    owner: overrides.owner ?? OWNER,
    name: 'remote_exec',
    mode: 'command',
    target: overrides.target ?? 'buildbox/terminal',
    command: 'make release',
    timeoutMs: 3_600_000,
    summary: 'Build the release',
  })
}

/** A tool's own handler, run in-process: how a tool's task runs unless its tool opted into the runner. */
function toolTask(svc: BackgroundTasks, run: (signal: AbortSignal) => Promise<unknown>, timeoutMs = 3_600_000) {
  return svc.startInProcessTask({
    owner: OWNER,
    kind: 'tool',
    name: 'web_fetch',
    // The call named nothing to run against.
    target: '',
    summary: 'Fetch the release notes',
    timeoutMs,
    run,
  })
}

function inProcessTask(
  svc: BackgroundTasks,
  run: (signal: AbortSignal) => Promise<unknown>,
  owner: typeof OWNER | { agent: string } = OWNER,
) {
  return svc.startInProcessTask({
    owner,
    kind: 'app-action',
    name: 'deploy',
    target: 'ops.deployer',
    summary: 'Deploy to staging',
    timeoutMs: 60_000,
    run,
  })
}

async function told(svc: BackgroundTasks, taskId: string): Promise<BackgroundTaskRecord> {
  let record: BackgroundTaskRecord | null = null
  await until(async () => {
    record = await svc.get(taskId)
    return record?.deliveredAt !== undefined
  })
  return record as unknown as BackgroundTaskRecord
}

// ── in-process tasks ─────────────────────────────────────────────────────

test('an in-process task reads working while it runs, then completes with its result and is told once', async () => {
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine })
  let finish: (value: unknown) => void = () => {}
  const started = await inProcessTask(svc, () => new Promise((resolve) => (finish = resolve)))
  assert.equal(started.state, 'running')
  assert.equal(started.sessionKey, KEY)
  assert.deepEqual([...svc.runningSessionKeys()], [KEY])
  await until(() => fake.upserts.length === 1)
  assert.equal(fake.upserts[0].task.state, 'running')
  assert.equal(fake.upserts[0].task.canStop, true)

  finish({ url: 'https://staging.example.test' })
  const done = await told(svc, started.taskId)
  assert.equal(done.state, 'completed')
  assert.equal(done.outputTail, '{\n  "url": "https://staging.example.test"\n}')
  assert.deepEqual([...svc.runningSessionKeys()], [])
  // The final record went into the session before the notification did.
  assert.deepEqual(
    fake.upserts.map(({ sessionId, task }) => [sessionId, task.state, task.canStop]),
    [
      ['session-1', 'running', true],
      ['session-1', 'completed', false],
    ],
  )
  assert.equal(fake.notified.length, 1)
  assert.equal(fake.notified[0].sessionId, 'session-1')
  assert.equal(userText(fake.notified[0].text), null)
})

test('a handler that throws ends failed, with its message as the reason', async () => {
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine })
  const started = await inProcessTask(svc, async () => {
    throw new Error('the deploy target refused the upload')
  })
  const done = await told(svc, started.taskId)
  assert.equal(done.state, 'failed')
  assert.equal(done.reason, 'the deploy target refused the upload')
})

test('a timeout aborts the handler and stops the task, counted from when it started', async () => {
  let now = new Date('2026-09-22T10:00:00.000Z')
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine, now: () => now })
  let seen: AbortSignal | undefined
  const started = await inProcessTask(svc, (signal) => {
    seen = signal
    return new Promise(() => {})
  })
  now = new Date(now.getTime() + 59_000)
  await svc.enforceDeadlines()
  assert.equal((await svc.get(started.taskId))?.state, 'running')
  assert.equal(seen?.aborted, false)

  now = new Date(now.getTime() + 2_000)
  await svc.enforceDeadlines()
  assert.equal(seen?.aborted, true)
  assert.equal((seen?.reason as Error).message, 'timed out after 1 min')
  const done = await told(svc, started.taskId)
  assert.equal(done.state, 'stopped')
  assert.equal(done.reason, 'timed out after 1 min')
})

test('a cancel is a request to a handler, and one that ignores it cannot undo the stop', async () => {
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine })
  let seen: AbortSignal | undefined
  let release: () => void = () => {}
  const started = await inProcessTask(svc, (signal) => {
    seen = signal
    return new Promise((resolve) => (release = () => resolve('finished anyway')))
  })
  assert.equal(await svc.cancel(started.taskId), 'requested')
  assert.equal(seen?.aborted, true)
  release()
  const done = await told(svc, started.taskId)
  assert.equal(done.state, 'stopped')
  assert.equal(done.reason, 'cancelled')
  assert.equal(done.outputTail, undefined)
  assert.equal(await svc.cancel(started.taskId), 'not-running')
  assert.equal(await svc.cancel(randomUUID()), 'unknown-task')
  assert.equal(await svc.requestStop(started.taskId), false)
})

test('the startup sweep fails what a previous process left running, and tells its session', async () => {
  const instanceId = randomUUID()
  const orphan = randomUUID()
  await insertTask({
    taskId: orphan,
    instanceId,
    agent: 'builder',
    sessionKey: KEY,
    sessionId: 'a-session-id-from-before-the-restart',
    kind: 'node-action',
    runner: 'in-process',
    name: 'backup',
    target: 'node_backup',
    summary: 'Back up the volumes',
    state: 'running',
    startedAt: new Date(),
    timeoutMs: null,
  })
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine, instanceId })
  const mine = await inProcessTask(svc, () => new Promise(() => {}))
  await svc.sweepOrphans()

  const swept = await told(svc, orphan)
  assert.equal(swept.state, 'failed')
  assert.equal(swept.reason, SERVER_RESTARTED)
  assert.ok(fake.notified.some(({ text }) => text.includes(`Background task ${orphan} has ended: failed.`)))
  assert.equal((await svc.get(mine.taskId))?.state, 'running')
})

// ── in-process tool tasks ────────────────────────────────────────────────
//
// A tool's task is in-process unless its tool opted into the runner, so a
// `tool` kind no longer means a command on a node. Each of these is a place
// the service once read the kind to decide that, and each asserts the
// in-process answer: nothing asked of any node, a deadline that aborts, a
// cancel that is a request, a restart that fails it.

test('an in-process tool task is never probed nor failed as a stalled launch, and its deadline aborts it', async () => {
  let now = new Date('2026-09-22T10:00:00.000Z')
  const node = fakeNode()
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine, node: node.transport, now: () => now })
  let seen: AbortSignal | undefined
  const started = await toolTask(
    svc,
    (signal) => {
      seen = signal
      return new Promise(() => {})
    },
    10 * 60_000,
  )
  assert.deepEqual([started.kind, started.runner], ['tool', 'in-process'])
  assert.equal((await svc.get(started.taskId))?.runner, 'in-process')

  // Past the launch grace, which a runner task still without a directory
  // would not outlive — and short of the deadline.
  now = new Date(now.getTime() + 6 * 60_000)
  await svc.probe()
  await svc.enforceDeadlines()
  assert.equal((await svc.get(started.taskId))?.state, 'running')
  assert.equal(seen?.aborted, false)

  now = new Date(now.getTime() + 5 * 60_000)
  await svc.enforceDeadlines()
  assert.equal(seen?.aborted, true)
  assert.equal((seen?.reason as Error).message, 'timed out after 10 min')
  const done = await told(svc, started.taskId)
  assert.deepEqual([done.state, done.reason], ['stopped', 'timed out after 10 min'])
  // Nothing, at any point, went to a node.
  assert.deepEqual(node.commands, [])
})

test('a cancel of an in-process tool task is a request to its handler, and reaches no node', async () => {
  const node = fakeNode()
  const svc = service({ engine: fakeEngine().engine, node: node.transport })
  let seen: AbortSignal | undefined
  const started = await toolTask(svc, (signal) => {
    seen = signal
    return new Promise(() => {})
  })
  assert.equal(await svc.cancel(started.taskId), 'requested')
  assert.equal(seen?.aborted, true)
  const done = await told(svc, started.taskId)
  assert.deepEqual([done.state, done.reason], ['stopped', 'cancelled'])
  assert.deepEqual(node.commands, [])
})

test('the startup sweep fails an in-process tool task a previous process left, and leaves a runner task be', async () => {
  const instanceId = randomUUID()
  const before = {
    instanceId,
    agent: 'builder',
    sessionKey: KEY,
    sessionId: 'a-session-id-from-before-the-restart',
    kind: 'tool',
    state: 'running',
    startedAt: new Date(),
    timeoutMs: null,
  }
  const inProcess = randomUUID()
  const onNode = randomUUID()
  await insertTask({
    ...before,
    taskId: inProcess,
    runner: 'in-process',
    name: 'web_fetch',
    target: '',
    summary: 'Fetch the release notes',
  })
  await insertTask({
    ...before,
    taskId: onNode,
    runner: 'background-task-runner',
    name: 'remote_exec',
    target: 'buildbox/terminal',
    summary: 'Train overnight',
    nodeDir: `/tmp/opencroft-tasks/${onNode}`,
  })
  const svc = service({ engine: fakeEngine().engine, instanceId })
  await svc.sweepOrphans()

  const swept = await told(svc, inProcess)
  assert.deepEqual([swept.state, swept.reason], ['failed', SERVER_RESTARTED])
  // Its process is on its node, which a restart here did not touch.
  assert.equal((await svc.get(onNode))?.state, 'running')
})

test('a string result is kept as written, anything else as JSON, and either is bounded', async () => {
  const svc = service({ engine: fakeEngine().engine })
  const text = 'Release 4.2\n- faster builds\n- "quoted", and a \\ kept\n'
  const asText = await toolTask(svc, async () => text)
  assert.equal((await told(svc, asText.taskId)).outputTail, text)

  // The head is kept, as it is for any result.
  const long = await toolTask(svc, async () => `${'x'.repeat(TAIL_MAX_BYTES)}${'q'.repeat(100)}`)
  assert.equal(
    (await told(svc, long.taskId)).outputTail,
    `${'x'.repeat(TAIL_MAX_BYTES)}\n… (truncated — the whole result is ${TAIL_MAX_BYTES + 100} bytes)`,
  )

  // The same words in something that is not a string are its JSON.
  const asJson = await toolTask(svc, async () => [text])
  assert.equal((await told(svc, asJson.taskId)).outputTail, JSON.stringify([text], null, 2))
})

// ── runner tasks ─────────────────────────────────────────────────────────

test('a deadline is counted from the stored start, so a restart neither resets nor forgets it', async () => {
  const instanceId = randomUUID()
  const t0 = new Date('2026-09-22T10:00:00.000Z')
  let now = t0
  const node = fakeNode()
  const fake = fakeEngine()
  const before = service({ engine: fake.engine, node: node.transport, instanceId, now: () => now })
  const started = await runnerTask(before)
  assert.equal(deadlineOf(started), t0.getTime() + 3_600_000)

  // The restart: a new process's memory, the same registry.
  const after = service({ engine: fake.engine, node: node.transport, instanceId, now: () => now })
  await until(() => after.runningSessionKeys().has(KEY))
  now = new Date(t0.getTime() + 59 * 60_000)
  await after.enforceDeadlines()
  assert.equal(node.stops().length, 0)

  now = new Date(t0.getTime() + 61 * 60_000)
  await after.enforceDeadlines()
  assert.equal(node.stops().length, 1)
  const done = await told(after, started.taskId)
  assert.equal(done.state, 'stopped')
  assert.equal(done.reason, 'timed out after 60 min')
  assert.equal(after.runningSessionKeys().has(KEY), false)
  assert.equal(deadlineOf({ startedAt: t0, timeoutMs: null }), null)
})

test('one probe per target, and each report ends its task the way it should', async () => {
  const node = fakeNode()
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine, node: node.transport })
  const [ok, broken, killed, stillGoing] = [
    await runnerTask(svc),
    await runnerTask(svc),
    await runnerTask(svc),
    await runnerTask(svc),
  ]
  const wiped = await runnerTask(svc, { target: 'other/terminal' })
  node.reports.set(ok.taskId, `exited 0 9 ${base64('built ok\n')}`)
  node.reports.set(broken.taskId, `exited 2 6 ${base64('error\n')}`)
  node.reports.set(killed.taskId, 'vanished - 0 ')
  node.reports.set(wiped.taskId, 'gone')

  await svc.probe()
  assert.equal(node.probes().length, 2)
  const outcome = async (taskId: string) => {
    const record = await told(svc, taskId)
    return [record.state, record.exitCode, record.reason, record.outputTail]
  }
  assert.deepEqual(await outcome(ok.taskId), ['completed', 0, undefined, 'built ok\n'])
  assert.deepEqual(await outcome(broken.taskId), ['failed', 2, undefined, 'error\n'])
  assert.deepEqual(await outcome(killed.taskId), ['failed', undefined, 'process vanished', undefined])
  assert.deepEqual(await outcome(wiped.taskId), [
    'failed',
    undefined,
    'its directory is gone from the node (the node was rebuilt, or its temp directory cleared)',
    undefined,
  ])
  assert.equal((await svc.get(stillGoing.taskId))?.state, 'running')
  assert.deepEqual([...svc.runningSessionKeys()], [KEY])
})

test('a runner task is recorded as one, and what runs is chosen by its mode, never by the tool’s name', async () => {
  const node = fakeNode()
  const svc = service({ engine: fakeEngine().engine, node: node.transport })
  const start = (name: string, mode: 'command' | 'script') =>
    svc.startRunnerTask({
      owner: OWNER,
      name,
      mode,
      target: 'buildbox/terminal',
      command: 'make release',
      args: ['--fast'],
      timeoutMs: null,
      summary: 'Build the release',
    })
  // Each named as the other mode's tool would be.
  const script = await start('remote_exec', 'script')
  const command = await start('remote_script', 'command')
  assert.deepEqual([script.kind, script.runner], ['tool', 'background-task-runner'])
  assert.equal((await svc.get(command.taskId))?.runner, 'background-task-runner')

  const [scriptLaunch, commandLaunch] = node.launches()
  assert.deepEqual(node.written, [`/tmp/opencroft-tasks/${script.taskId}/script.sh`])
  assert.ok(scriptLaunch.includes(`bash '/tmp/opencroft-tasks/${script.taskId}/script.sh' '--fast'`))
  assert.ok(commandLaunch.includes(`"$0" -c 'make release'`))
  assert.equal(commandLaunch.includes('--fast'), false)
})

test('a runner task that cannot start throws to its caller, and ends failed and already told', async () => {
  const node = fakeNode()
  node.controls.failLaunch = new Error('the task did not start')
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine, node: node.transport })
  await assert.rejects(runnerTask(svc), /the task did not start/)
  const [record] = await svc.listForOwner(OWNER)
  assert.equal(record.state, 'failed')
  assert.equal(record.reason, 'it did not start: the task did not start')
  assert.ok(record.deliveredAt)
  assert.equal(fake.notified.length, 0)
  assert.deepEqual([...svc.runningSessionKeys()], [])
})

test('a cancel stops the process group; a task that ended first keeps its own ending', async () => {
  const node = fakeNode()
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine, node: node.transport })
  const running = await runnerTask(svc)
  node.controls.stopReport = (taskId) => `opencroft-task ${taskId} vanished - 8 ${base64('partial\n')}`
  assert.equal(await svc.cancel(running.taskId), 'stopped')
  const stopped = await told(svc, running.taskId)
  assert.deepEqual([stopped.state, stopped.reason, stopped.outputTail], ['stopped', 'cancelled', 'partial\n'])

  const finished = await runnerTask(svc)
  node.controls.stopReport = (taskId) => `opencroft-task ${taskId} exited 0 0 `
  assert.equal(await svc.cancel(finished.taskId), 'not-running')
  assert.equal((await told(svc, finished.taskId)).state, 'completed')
  assert.equal(node.stops().length, 2)
})

// ── telling the session ──────────────────────────────────────────────────

test('delivery is recorded only when the session took it, and retried when it did not', async () => {
  const fake = fakeEngine()
  fake.answers.push(async () => false)
  const svc = service({ engine: fake.engine })
  const started = await inProcessTask(svc, async () => 'done')
  await until(() => fake.notified.length === 1)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal((await svc.get(started.taskId))?.deliveredAt, undefined)

  await svc.deliverOwed()
  assert.equal(fake.notified.length, 2)
  await told(svc, started.taskId)
  await svc.deliverOwed()
  assert.equal(fake.notified.length, 2)
})

test('a notification held pending is never sent a second time', async () => {
  const fake = fakeEngine()
  let wake: (taken: boolean) => void = () => {}
  fake.answers.push(() => new Promise((resolve) => (wake = resolve)))
  const svc = service({ engine: fake.engine })
  const started = await inProcessTask(svc, async () => 'done')
  await until(() => fake.notified.length === 1)
  await svc.deliverOwed()
  await svc.deliverOwed()
  assert.equal(fake.notified.length, 1)
  wake(true)
  await told(svc, started.taskId)
  assert.equal(fake.notified.length, 1)
})

test('a task with no session is delivered to nobody, and owes nothing', async () => {
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine })
  const started = await inProcessTask(svc, async () => 'done', { agent: 'builder' })
  assert.equal(started.sessionKey, undefined)
  await told(svc, started.taskId)
  assert.equal(fake.notified.length, 0)
  assert.equal(fake.upserts.length, 0)
})

test('a session not in memory is opened for its delivery, and a key nothing claims is not asked every tick', async () => {
  let now = new Date('2026-09-22T10:00:00.000Z')
  const fake = fakeEngine([])
  const opened: string[] = []
  let claimed = false
  const svc = service({
    engine: fake.engine,
    now: () => now,
    openSession: async (sessionKey) => {
      opened.push(sessionKey)
      if (!claimed) {
        return null
      }
      fake.sessions.push({ id: 'session-2', sessionKey })
      return { sessionId: 'session-2' }
    },
  })
  // The caller's session is known when the task starts…
  fake.sessions.push({ id: 'session-1', sessionKey: KEY })
  const started = await inProcessTask(svc, () => new Promise((resolve) => setTimeout(() => resolve('done'), 20)))
  // …and gone by the time it ends.
  fake.sessions.length = 0
  await until(async () => (await svc.get(started.taskId))?.state === 'completed')
  await until(() => opened.length === 1)
  await svc.deliverOwed()
  assert.equal(opened.length, 1)
  assert.equal(fake.notified.length, 0)

  now = new Date(now.getTime() + 6 * 60_000)
  claimed = true
  await svc.deliverOwed()
  assert.deepEqual(opened, [KEY, KEY])
  await told(svc, started.taskId)
  assert.deepEqual(
    fake.notified.map(({ sessionId }) => sessionId),
    ['session-2'],
  )
})

test('a reopened session is restated the tasks it may show wrongly: the running and the untold', async () => {
  const fake = fakeEngine()
  fake.answers.push(async () => false)
  const node = fakeNode()
  const svc = service({ engine: fake.engine, node: node.transport })
  const untold = await inProcessTask(svc, async () => 'done')
  await until(() => fake.notified.length === 1)
  const running = await runnerTask(svc)
  const toldTask = await inProcessTask(svc, async () => 'done')
  await told(svc, toldTask.taskId)

  const before = fake.upserts.length
  await svc.syncSession(KEY, 'session-9')
  const restated = fake.upserts.slice(before)
  assert.deepEqual(
    restated.map(({ sessionId, task }) => [sessionId, task.asyncTaskId, task.state]),
    [
      ['session-9', untold.taskId, 'completed'],
      ['session-9', running.taskId, 'running'],
    ],
  )
})

test('the running keys include tasks a previous process started', async () => {
  const instanceId = randomUUID()
  await insertTask({
    taskId: randomUUID(),
    instanceId,
    agent: 'builder',
    sessionKey: 'agent:carried:over',
    sessionId: null,
    kind: 'tool',
    runner: 'background-task-runner',
    name: 'remote_exec',
    target: 'buildbox/terminal',
    summary: 'Train overnight',
    state: 'running',
    startedAt: new Date(),
    timeoutMs: null,
    nodeDir: '/tmp/opencroft-tasks/x',
  })
  const svc = service({ engine: fakeEngine().engine, instanceId })
  await until(() => svc.runningSessionKeys().has('agent:carried:over'))
  // Another registry's rows are not this one's.
  const other = service({ engine: fakeEngine().engine })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(other.runningSessionKeys().has('agent:carried:over'), false)
})

test('an owner lists its session’s tasks newest first; a sessionless agent lists its own', async () => {
  let now = new Date('2026-09-22T10:00:00.000Z')
  const fake = fakeEngine()
  const svc = service({ engine: fake.engine, now: () => now })
  const first = await inProcessTask(svc, () => new Promise(() => {}))
  now = new Date(now.getTime() + 1_000)
  const second = await inProcessTask(svc, () => new Promise(() => {}))
  const loose = await inProcessTask(svc, () => new Promise(() => {}), { agent: 'builder' })
  assert.deepEqual(
    (await svc.listForOwner(OWNER)).map((record) => record.taskId),
    [second.taskId, first.taskId],
  )
  assert.deepEqual(
    (await svc.listForOwner({ agent: 'builder' })).map((record) => record.taskId),
    [loose.taskId],
  )
  assert.deepEqual((await svc.listForOwner({ agent: 'someone-else' })).length, 0)
})
