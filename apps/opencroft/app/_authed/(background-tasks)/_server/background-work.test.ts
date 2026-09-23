// The `background` set as every status derivation reads it: the engine's keys
// and the registry's running keys, each once. Built from the real client and
// the real registry — only the engine's answer is fixed, because a session
// with harness-reported work would take a harness to produce.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, mock, test } from 'node:test'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { backgroundWorkSessionKeys } from './background-work'
import { backgroundTasks } from './service'
import { insertTask } from './store'
import { backgroundTaskList } from './task-list'

const dataDir = mkdtempSync(path.join(tmpdir(), 'bg-task-background-work-'))
process.env.OPENCROFT_DATA_DIR = dataDir

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

async function running(instanceId: string, sessionKey: string): Promise<void> {
  await insertTask({
    taskId: randomUUID(),
    instanceId,
    agent: 'builder',
    sessionKey,
    sessionId: null,
    kind: 'tool',
    runner: 'background-task-runner',
    name: 'remote_exec',
    target: 'buildbox/terminal',
    summary: 'Train overnight',
    state: 'running',
    startedAt: new Date(),
    timeoutMs: null,
    nodeDir: `/tmp/opencroft-tasks/${randomUUID()}`,
  })
}

test('the background set is the engine’s keys and the registry’s running keys, each once', async () => {
  mock.method(agentClient, 'backgroundWorkSessionKeys', () => ['agent:a:harness-task', 'agent:b:both'])
  // The registry's id is made on first use; ask it something to have one.
  await backgroundTasks.listRecent()
  const instanceId = readFileSync(path.join(dataDir, 'background-tasks-instance'), 'utf8').trim()
  await running(instanceId, 'agent:b:both')
  await running(instanceId, 'agent:c:unloaded-session')
  // Another registry's task is not this instance's work.
  await running(randomUUID(), 'agent:d:elsewhere')

  const deadline = Date.now() + 5_000
  while (!backgroundWorkSessionKeys().has('agent:c:unloaded-session') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.deepEqual([...backgroundWorkSessionKeys()].sort(), [
    'agent:a:harness-task',
    'agent:b:both',
    'agent:c:unloaded-session',
  ])
})

test('the audit list shows the running tasks, with where and how they run and for whom', async () => {
  const list = await backgroundTaskList()
  assert.equal(list.error, null)
  assert.deepEqual(
    list.tasks.map((task) => [task.session, task.state, task.runner, task.target, task.agent, task.finishedAt]).sort(),
    [
      ['agent:b:both', 'running', 'background-task-runner', 'buildbox/terminal', 'builder', null],
      ['agent:c:unloaded-session', 'running', 'background-task-runner', 'buildbox/terminal', 'builder', null],
    ],
  )
})
