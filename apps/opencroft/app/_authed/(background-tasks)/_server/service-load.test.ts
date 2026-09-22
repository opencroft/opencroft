// The service is imported by modules that load early and in no fixed order —
// the startup poller, the extension host, the chat's activity poll — so it
// must load in a process where NOTHING else has loaded yet. The remote tools
// cannot: their import graph comes back round to the tool registry, which reads
// their exports while it loads, and a process that reaches them first dies on
// an uninitialised binding. So the service reaches them only by import(), and
// through a module that loads the registry first.
//
// This file is that fresh process. Ahead of the service come node builtins and
// the database's test redirect, a leaf that loads nothing of the app.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'

import { backgroundTasks } from './service'

// The service keeps its instance id on the data volume; give it a scratch one.
const dataDir = mkdtempSync(path.join(tmpdir(), 'bg-task-service-load-'))
process.env.OPENCROFT_DATA_DIR = dataDir

after(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

test('the service loads first, in a process that has loaded nothing else', () => {
  assert.equal(typeof backgroundTasks.startNodeTask, 'function')
  assert.deepEqual([...backgroundTasks.runningSessionKeys()], [])
})

test('and its transport — the remote tools — comes up from that same fresh start', async () => {
  // A target that names nothing: getting as far as the remote tools' own
  // "not found" — their JSON-RPC error, not an Error — means the lazy chain
  // loaded and resolution ran. A load-order failure would surface here as a
  // ReferenceError instead.
  await assert.rejects(
    backgroundTasks.startNodeTask({
      owner: { agent: null },
      name: 'remote_exec',
      target: 'no-such-node/terminal',
      command: 'true',
      timeoutMs: 60_000,
      summary: 'reach the remote tools',
    }),
    { code: -32602, message: 'Node not found: no-such-node' },
  )
  // A start that failed is recorded as failed, and as already told: the
  // caller heard it from the throw.
  const [task] = await backgroundTasks.listRecent()
  assert.equal(task.state, 'failed')
  assert.equal(task.reason, 'it did not start: Node not found: no-such-node')
  assert.ok(task.deliveredAt)
})
