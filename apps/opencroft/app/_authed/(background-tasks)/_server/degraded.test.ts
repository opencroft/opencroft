// Code can be running before its migration is: migrations apply only when a
// process starts, and a hot reload puts new code into a process that started
// before them. So the paths read on every hot path — the running keys each
// chat list's activity poll reads, the background set built from them, the
// audit list, the poller — must degrade to "nothing known" rather than break
// what they are part of. Simulated the direct way: the table is dropped.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, mock, test } from 'node:test'

import { db } from '@opencroft/db'
import { sql } from 'drizzle-orm'

import { runStep } from '@/server/scheduler/background-task-poller'
import type { RunnerTransport } from './background-task-runner'
import { backgroundWorkSessionKeys } from './background-work'
import type { HostTaskEngine } from './engine'
import { BackgroundTasks, backgroundTasks, createState } from './service'
import { backgroundTaskList } from './task-list'

const dataDir = mkdtempSync(path.join(tmpdir(), 'bg-task-degraded-'))
const errors = mock.method(console, 'error', () => {})
const logs = mock.method(console, 'log', () => {})

before(async () => {
  process.env.OPENCROFT_DATA_DIR = dataDir
  await db.execute(sql`DROP TABLE "BackgroundTask"`)
})

after(() => {
  errors.mock.restore()
  logs.mock.restore()
  rmSync(dataDir, { recursive: true, force: true })
})

function logged(prefix: string): unknown[][] {
  return errors.mock.calls.map((call) => call.arguments).filter((args) => String(args[0]).startsWith(prefix))
}

const engine: HostTaskEngine = {
  listSessions: () => [{ id: 'session-1', sessionKey: 'agent:builder:main' }],
  upsertAsyncTask: () => true,
  notify: async () => true,
}

function service(now: () => Date, transport?: RunnerTransport) {
  return new BackgroundTasks(createState(), {
    instanceId: () => 'degraded-instance',
    transport: async () => transport ?? (await import('./remote-transport')).remoteToolsTransport,
    engine: async () => engine,
    openSession: async () => null,
    now,
  })
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('the running keys read as none, and the failure is logged once however often they are asked', async () => {
  let now = new Date('2026-09-22T10:00:00.000Z')
  const svc = service(() => now)
  const before = logged('[background-tasks]').length
  for (let i = 0; i < 3; i++) {
    assert.deepEqual([...svc.runningSessionKeys()], [])
    await settle()
  }
  // Past the retry wait: asked again, failing again, still said once.
  now = new Date(now.getTime() + 2 * 60_000)
  assert.deepEqual([...svc.runningSessionKeys()], [])
  await settle()
  const said = logged('[background-tasks]').slice(before)
  assert.equal(said.length, 1)
  assert.match(String(said[0][0]), /could not load the running background tasks/)
  assert.match(String((said[0][1] as Error).message), /BackgroundTask/)
})

test('the background set still answers, from what the engine knows', async () => {
  const keys = backgroundWorkSessionKeys()
  await settle()
  assert.ok(keys instanceof Set)
  assert.ok(backgroundWorkSessionKeys() instanceof Set)
})

test('the audit list says it could not be read, instead of failing the page', async () => {
  const list = await backgroundTaskList(backgroundTasks)
  assert.deepEqual(list.tasks, [])
  assert.match(list.error ?? '', /BackgroundTask/)
})

test('a failing poller step is caught and logged once, and works-again is said when it does', async () => {
  const svc = service(() => new Date())
  const before = logged('[background-task-poller]').length
  await runStep('probe', () => svc.probe())
  await runStep('probe', () => svc.probe())
  await runStep('delivery', () => svc.deliverOwed())
  const said = logged('[background-task-poller]').slice(before)
  assert.deepEqual(
    said.map((args) => args[0]),
    ['[background-task-poller] probe failed', '[background-task-poller] delivery failed'],
  )
  await runStep('probe', async () => {})
  assert.ok(logs.mock.calls.some((call) => call.arguments[0] === '[background-task-poller] probe works again'))
})

test('a start is refused before anything runs, and a reopened session still opens', async () => {
  let launched = 0
  const transport: RunnerTransport = {
    resolve: async () => ({ ctx: { type: 'local' } }),
    secretsEnv: async () => undefined,
    writeFile: async () => {},
    exec: async () => {
      launched += 1
      return ''
    },
  }
  const svc = service(() => new Date(), transport)
  await assert.rejects(
    svc.startRunnerTask({
      owner: { agent: 'builder', sessionId: 'session-1' },
      name: 'remote_exec',
      mode: 'command',
      target: 'buildbox/terminal',
      command: 'make',
      timeoutMs: 60_000,
      summary: 'Build',
    }),
  )
  // Nothing was left running on the node without a record of it.
  assert.equal(launched, 0)
  await svc.syncSession('agent:builder:main', 'session-1')
})
