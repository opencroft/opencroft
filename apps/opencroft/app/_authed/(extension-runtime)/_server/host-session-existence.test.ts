// Exercises the real database (embedded PGlite by default) -- see
// @opencroft/db's test-env for how this stays off the shared dev/production
// database regardless of the ambient environment.
//
// Coverage for the shared existence guard every send-message action that
// targets an EXISTING session runs through first (listTurns, compact,
// compactStatus, unload, delete): a session key whose agent/job pair is wired
// into the node's space (so it reads as "reachable") but that was never
// actually registered in the durable session list must be refused with the
// same not-found shape everywhere, rather than reaching whatever each action
// happens to do downstream for a key that never existed.
import '@opencroft/db/test-env'

import assert from 'node:assert/strict'
import test from 'node:test'

import { readSessions, upsertSession } from '@/app/_authed/(agent)/_server/agent-sessions-store'
import { getSpacesRegistry } from '@/app/_authed/(space)/_server/store'
import { createHost } from './host'
import { buildSessionKey } from './send-message-helpers'

const REFUSAL = /Session not reachable from this node/

let counter = 0

// A space with one send-message node and one wired agent/job pair -- enough
// for `reachablePairs` to treat any `agent:<agentName>:<jobName>[:key]`
// session key as reachable, whether or not a session actually exists under
// it. Each test gets its own space so the fixtures never interfere.
async function setupReachableSpace(): Promise<{
  nodeId: string
  agentName: string
  jobName: string
  agentNodeId: string
  jobNodeId: string
}> {
  counter += 1
  const slug = `host-existence-guard-${counter}-${crypto.randomUUID()}`
  const agentName = `Existence Guard Agent ${counter}`
  const jobName = `existence-guard-job-${counter}`
  const agentNodeId = `agent-${counter}`
  const jobNodeId = `job-${counter}`
  const sendMessageNodeId = `send-message-${counter}`

  const registry = getSpacesRegistry()
  await registry.ensureLoaded()
  await registry.create(slug, slug, {
    nodes: [
      { id: sendMessageNodeId, type: 'send-message', position: { x: 0, y: 0 }, data: {} },
      { id: agentNodeId, type: 'agent', position: { x: 0, y: 0 }, data: { name: agentName } },
      { id: jobNodeId, type: 'agent-job', position: { x: 0, y: 0 }, data: { name: jobName, context: '' } },
    ],
    edges: [{ id: `edge-${counter}`, source: jobNodeId, target: agentNodeId }],
  })

  return { nodeId: sendMessageNodeId, agentName, jobName, agentNodeId, jobNodeId }
}

test('listTurns refuses a reachable-pair sessionKey that was never actually created', async () => {
  const space = await setupReachableSpace()
  const host = createHost('existence-guard-ext')
  const ghostKey = buildSessionKey(space.agentName, space.jobName, 'never-created')

  await assert.rejects(() => host.sendMessage.listTurns(space.nodeId, { sessionKey: ghostKey }), REFUSAL)
})

test('compact refuses a reachable-pair sessionKey that was never actually created, and registers nothing', async () => {
  const space = await setupReachableSpace()
  const host = createHost('existence-guard-ext')
  const ghostKey = buildSessionKey(space.agentName, space.jobName, 'never-created')

  await assert.rejects(() => host.sendMessage.compact(space.nodeId, { sessionKey: ghostKey }), REFUSAL)
  const after = await readSessions()
  assert.equal(
    after.some((entry) => entry.key === ghostKey),
    false,
    'the refusal must not have registered a session for the ghost key',
  )
})

test('compactStatus refuses a reachable-pair sessionKey that was never actually created', async () => {
  const space = await setupReachableSpace()
  const host = createHost('existence-guard-ext')
  const ghostKey = buildSessionKey(space.agentName, space.jobName, 'never-created')

  await assert.rejects(() => host.sendMessage.compactStatus(space.nodeId, { sessionKey: ghostKey }), REFUSAL)
})

test('unload refuses a reachable-pair sessionKey that was never actually created', async () => {
  const space = await setupReachableSpace()
  const host = createHost('existence-guard-ext')
  const ghostKey = buildSessionKey(space.agentName, space.jobName, 'never-created')

  await assert.rejects(() => host.sendMessage.unload(space.nodeId, { sessionKey: ghostKey }), REFUSAL)
})

test('delete still refuses a reachable-pair sessionKey that was never actually created, now via the shared guard', async () => {
  const space = await setupReachableSpace()
  const host = createHost('existence-guard-ext')
  const ghostKey = buildSessionKey(space.agentName, space.jobName, 'never-created')

  await assert.rejects(() => host.sendMessage.delete(space.nodeId, { sessionKey: ghostKey }), REFUSAL)
})

test('a session actually registered under a reachable pair is not refused by the guard', async () => {
  const space = await setupReachableSpace()
  const host = createHost('existence-guard-ext')
  const realKey = buildSessionKey(space.agentName, space.jobName, 'real')
  await upsertSession({
    key: realKey,
    agentNodeId: space.agentNodeId,
    agentName: space.agentName,
    jobNodeId: space.jobNodeId,
    jobName: space.jobName,
    createdAt: Date.now(),
  })

  // listTurns: a real key with no live process reports an offline, empty
  // page -- not a refusal. The guard only screens out keys absent from the
  // registry, so a real one passes straight through.
  const turns = await host.sendMessage.listTurns(space.nodeId, { sessionKey: realKey })
  assert.deepEqual(turns, { turns: [], hasMore: false, nextBeforeIndex: null, sessionStatus: 'offline' })

  // compactStatus: nothing was ever requested for it, but it exists.
  assert.deepEqual(await host.sendMessage.compactStatus(space.nodeId, { sessionKey: realKey }), {
    sessionKey: realKey,
    state: 'never-requested',
  })

  // unload: the guard lets it through; the pre-existing status gate still
  // refuses it since it has no live process to unload -- a different
  // refusal from the guard's, distinguishable by its own message.
  await assert.rejects(
    () => host.sendMessage.unload(space.nodeId, { sessionKey: realKey }),
    /Session is offline, not idle/,
  )

  // delete: the normal default path for a real offline session still
  // succeeds.
  const deleted = await host.sendMessage.delete(space.nodeId, { sessionKey: realKey })
  assert.deepEqual(deleted, { sessionKey: realKey, deleted: true })
  assert.equal(
    (await readSessions()).some((entry) => entry.key === realKey),
    false,
  )
})
