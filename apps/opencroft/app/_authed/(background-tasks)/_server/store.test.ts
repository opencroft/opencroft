// The registry's rows against a real database: that a task comes back as the
// record it went in as, that an ending is written once, that one registry
// never reads another's rows, and that the owed / unsettled / removable
// questions select what they say they do.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import {
  finishTask,
  getTask,
  insertTask,
  markDelivered,
  type NewTaskRow,
  owedTasks,
  recentTasks,
  removableDirs,
  runningTasks,
  toRecord,
  unsettledTasksForKey,
  updateTask,
} from './store'

const T0 = new Date('2026-09-22T10:00:00.000Z')
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000)

function row(instanceId: string, overrides: Partial<NewTaskRow> = {}): NewTaskRow {
  return {
    taskId: randomUUID(),
    instanceId,
    agent: 'builder',
    sessionKey: 'group-chat.team.builder.main',
    sessionId: 'session-1',
    kind: 'tool',
    runner: 'background-task-runner',
    name: 'remote_exec',
    target: 'buildbox/terminal',
    summary: 'Build the release',
    state: 'running',
    startedAt: T0,
    timeoutMs: 3_600_000,
    ...overrides,
  }
}

test('a task comes back as the record it went in as, through every field', async () => {
  const instanceId = randomUUID()
  const task = row(instanceId, { timeoutMs: 40 * 24 * 3_600_000 })
  await insertTask(task)
  await updateTask(task.taskId, {
    nodeDir: `/tmp/opencroft-tasks/${task.taskId}`,
    pid: 4242,
    logPath: `/tmp/opencroft-tasks/${task.taskId}/log`,
  })
  const ended = await finishTask(
    task.taskId,
    { state: 'failed', exitCode: 2, reason: 'exit status 2', outputTail: 'error\n' },
    minutes(3),
  )
  assert.ok(ended)
  await markDelivered(task.taskId, minutes(4))
  const stored = await getTask(instanceId, task.taskId)
  assert.ok(stored)
  assert.deepEqual(toRecord(stored), {
    taskId: task.taskId,
    agent: 'builder',
    sessionKey: 'group-chat.team.builder.main',
    kind: 'tool',
    runner: 'background-task-runner',
    name: 'remote_exec',
    target: 'buildbox/terminal',
    summary: 'Build the release',
    state: 'failed',
    reason: 'exit status 2',
    startedAt: T0,
    finishedAt: minutes(3),
    // Past int32 milliseconds, which is why the column is a bigint.
    timeoutMs: 40 * 24 * 3_600_000,
    exitCode: 2,
    outputTail: 'error\n',
    logPath: `/tmp/opencroft-tasks/${task.taskId}/log`,
    deliveredAt: minutes(4),
  })
  assert.equal(stored.pid, 4242)
})

// What ran and how it runs are two answers now: a tool's task is in-process
// unless its tool opted into the runner, and everything that watches, stops or
// sweeps a task reads the second. Each pairing must come back as it went in.
test('how a task runs comes back apart from what ran', async () => {
  const instanceId = randomUUID()
  const pairs = [
    ['tool', 'background-task-runner'],
    ['tool', 'in-process'],
    ['app-action', 'in-process'],
    ['node-action', 'in-process'],
  ] as const
  const tasks = pairs.map(([kind, runner]) => row(instanceId, { kind, runner, target: '' }))
  for (const task of tasks) {
    await insertTask(task)
  }
  const back = await Promise.all(tasks.map(async (task) => getTask(instanceId, task.taskId)))
  assert.deepEqual(
    back.map((stored) => {
      assert.ok(stored)
      const record = toRecord(stored)
      return [record.kind, record.runner, record.target]
    }),
    pairs.map(([kind, runner]) => [kind, runner, '']),
  )
})

test('an ending is written once: the second finds nothing running and changes nothing', async () => {
  const instanceId = randomUUID()
  const task = row(instanceId)
  await insertTask(task)
  assert.ok(await finishTask(task.taskId, { state: 'stopped', reason: 'cancelled' }, minutes(1)))
  assert.equal(await finishTask(task.taskId, { state: 'failed', reason: 'process vanished' }, minutes(2)), null)
  const stored = await getTask(instanceId, task.taskId)
  assert.deepEqual([stored?.state, stored?.reason, stored?.finishedAt], ['stopped', 'cancelled', minutes(1)])
})

test('one registry never reads another’s rows', async () => {
  const mine = randomUUID()
  const theirs = randomUUID()
  const task = row(theirs)
  await insertTask(task)
  assert.equal(await getTask(mine, task.taskId), null)
  assert.deepEqual(await runningTasks(mine), [])
  assert.deepEqual(
    (await runningTasks(theirs)).map((stored) => stored.taskId),
    [task.taskId],
  )
})

test('owed, unsettled and removable select exactly what they name', async () => {
  const instanceId = randomUUID()
  const key = 'group-chat.team.builder.main'
  const running = row(instanceId)
  const owed = row(instanceId)
  const told = row(instanceId)
  const tooOld = row(instanceId)
  const otherKey = row(instanceId, { sessionKey: 'agent:someone:else' })
  for (const task of [running, owed, told, tooOld, otherKey]) {
    await insertTask(task)
    await updateTask(task.taskId, { nodeDir: `/tmp/opencroft-tasks/${task.taskId}` })
  }
  await finishTask(owed.taskId, { state: 'completed', exitCode: 0 }, minutes(10))
  await finishTask(told.taskId, { state: 'completed', exitCode: 0 }, minutes(10))
  await markDelivered(told.taskId, minutes(11))
  await finishTask(tooOld.taskId, { state: 'failed', exitCode: 1 }, minutes(-8 * 24 * 60))
  await finishTask(otherKey.taskId, { state: 'completed', exitCode: 0 }, minutes(10))

  const ids = (rows: { taskId: string }[]) => rows.map((stored) => stored.taskId).sort()
  assert.deepEqual(ids(await owedTasks(instanceId, minutes(-7 * 24 * 60))), ids([owed, otherKey]))
  assert.deepEqual(ids(await unsettledTasksForKey(instanceId, key)), ids([running, owed, tooOld]))
  assert.deepEqual(
    ids(await removableDirs(instanceId, { deliveredBefore: minutes(12), endedBefore: minutes(-7 * 24 * 60) })),
    ids([told, tooOld]),
  )
})

// The audit page asks this "is anything still running?". A long-running task
// must be on the list however many tasks started after it and already ended:
// under one cap over both, ordered by start, fifty of those pushed it off and
// the page read "0 running" while it ran (measured on a scratch database).
test('recent lists every running task, however many newer ones have already ended', async () => {
  const instanceId = randomUUID()
  const longRunning = row(instanceId, { summary: 'Train overnight', startedAt: minutes(-300) })
  await insertTask(longRunning)
  for (let i = 0; i < 51; i++) {
    const done = row(instanceId, { startedAt: minutes(i) })
    await insertTask(done)
    await finishTask(done.taskId, { state: 'completed', exitCode: 0 }, minutes(i + 1))
  }
  const listed = await recentTasks(instanceId, minutes(-600), 50)
  assert.equal(listed.length, 51, 'the running one, plus the fifty most recently ended')
  assert.equal(listed[0]?.taskId, longRunning.taskId, 'running first')
  assert.equal(listed.filter((task) => task.state === 'running').length, 1)
  const ended = listed.slice(1).map((task) => task.finishedAt?.getTime() ?? 0)
  assert.deepEqual(
    ended,
    [...ended].sort((a, b) => b - a),
    'ended ones, most recently ended first',
  )
  assert.equal(ended[0], minutes(51).getTime(), 'the oldest ending is the one left out')
})
