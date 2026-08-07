// Coverage for the async compact contract: requestCompactOnGraph must return
// immediately, must never send anything into a session with a turn running
// (queue behind it instead of interrupting it), and must coalesce a second
// request for a session that already has one pending or running.
//
// Needs a live PGlite data dir (agent-client-instance.ts's transitive imports
// touch the DB at module load), same as stream-compact.test.ts — run through
// the project runner from apps/opencroft.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentConnection } from 'agent-client/connection'
import { buildSpawnConfig } from 'agent-client/resolve'
import type { AgentSelection } from 'agent-client/types'

import { tabSessions } from '@/app/_authed/(agent)/_server/acp-impl'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { buildSessionKey, type NodeLike } from './send-message-helpers'
import { getCompactStatusOnGraph, requestCompactOnGraph } from './stream'

interface AcpStoreShape {
  connections: Map<string, unknown>
}

function acpStore(): AcpStoreShape {
  const store = (globalThis as typeof globalThis & { __acpStore?: AcpStoreShape }).__acpStore
  assert.ok(store, 'agent-client global store must exist after import')
  return store
}

interface TurnDeferred {
  resolve: (value: { stopReason: string }) => void
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('waitFor: condition never became true')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let counter = 0

// Creates a live mock-backed ACP session the same way stream-compact.test.ts's
// setupSession does (a mock connection seeded under the selection's spawn-
// config key, so createSession never spawns a real subprocess), then
// registers it into tabSessions directly -- the same bookkeeping
// ensureLocalSessionImpl would otherwise do via a node-registry lookup, which
// this sidesteps entirely since resolveSessionOnGraph (used inside
// requestCompactOnGraph) only needs the plain nodes/edges arrays below, not a
// real registered space. findTargetSessionImpl reads tabSessions directly, so
// this is enough for requestCompactOnGraph's own session lookup to work.
async function setupCompactableSession(): Promise<{
  sessionKey: string
  sessionId: string
  nodes: NodeLike[]
  edges: []
  promptCalls: string[]
  turns: TurnDeferred[]
  endTurn: (stopReason?: string) => void
}> {
  counter += 1
  const agentName = `COMPACT Compact Agent ${counter}`
  const jobName = 'compact-test-job'
  const agentNodeId = 'agent-1'
  const jobNodeId = 'job-1'
  const jobContext = 'job context the restore must bring back'

  const sessionKey = buildSessionKey(agentName, jobName)
  const nodes: NodeLike[] = [
    { id: agentNodeId, type: 'agent', data: { name: agentName } },
    { id: jobNodeId, type: 'agent-job', data: { name: jobName, context: jobContext } },
  ]

  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/compact-compact-test-${counter}`,
  }
  const turns: TurnDeferred[] = []
  const promptCalls: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `compact-session-${counter}` }),
    prompt: (params: { prompt: Array<{ text: string }> }) => {
      promptCalls.push(params.prompt[0]?.text ?? '')
      return new Promise((resolve) => {
        turns.push({ resolve })
      })
    },
    cancel: async () => {},
    setSessionConfigOption: async () => ({ configOptions: [] }),
    closeSession: async () => ({}),
  } as unknown as AgentConnection
  const key = JSON.stringify(buildSpawnConfig(selection))
  acpStore().connections.set(key, {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  const meta = await agentClient.createSession(selection)
  tabSessions.set(sessionKey, { id: meta.id, canFork: false, canSteer: false, everPrompted: true })

  return {
    sessionKey,
    sessionId: meta.id,
    nodes,
    edges: [],
    promptCalls,
    turns,
    endTurn: (stopReason = 'end_turn') => turns.shift()?.resolve({ stopReason }),
  }
}

test('compact against an idle session returns immediately and runs to completion', async () => {
  const h = await setupCompactableSession()

  const ack = await requestCompactOnGraph(h.nodes, h.edges, h.sessionKey)
  assert.deepEqual(ack, { sessionKey: h.sessionKey, accepted: true, coalesced: false, state: 'pending' })

  await waitFor(() => h.promptCalls.length > 0)
  assert.equal(h.promptCalls[0], '/compact', 'the session was idle, so /compact dispatches right away')
  assert.equal(getCompactStatusOnGraph(h.sessionKey).state, 'running')

  h.endTurn() // settles /compact's own turn
  await waitFor(() => h.promptCalls.length > 1) // the instruction restore auto-dispatches next
  h.endTurn() // settles the restore's turn

  await waitFor(() => getCompactStatusOnGraph(h.sessionKey).state === 'done')
  const status = getCompactStatusOnGraph(h.sessionKey)
  assert.equal(status.result?.instructionsRestored, true)
})

test('compact against a working session queues behind the turn without interrupting it', async () => {
  const h = await setupCompactableSession()

  await agentClient.prompt(h.sessionId, 'ongoing work')
  await waitFor(() => h.promptCalls.length > 0)
  assert.match(
    h.promptCalls[0] ?? '',
    /ongoing work$/,
    'delivered text carries the delivery-time stamp ahead of the message',
  )

  const ack = await requestCompactOnGraph(h.nodes, h.edges, h.sessionKey)
  assert.deepEqual(ack, { sessionKey: h.sessionKey, accepted: true, coalesced: false, state: 'pending' })
  // Still pending -- nothing was sent for the compaction while the turn runs,
  // which is what makes this "never interrupt" rather than merely "queue the
  // request and hope".
  assert.equal(getCompactStatusOnGraph(h.sessionKey).state, 'pending')
  assert.equal(h.promptCalls.length, 1, 'no /compact dispatched while the ongoing turn is still running')
  assert.equal(agentClient.hasActiveTurn(h.sessionId), true, 'the ongoing turn is untouched, not cancelled')

  h.endTurn() // the ongoing turn finishes on its own
  await waitFor(() => h.promptCalls.length > 1)
  assert.equal(h.promptCalls[1], '/compact', 'compaction dispatches only once the turn it queued behind ended')
  assert.equal(getCompactStatusOnGraph(h.sessionKey).state, 'running')

  h.endTurn() // /compact's turn
  await waitFor(() => h.promptCalls.length > 2) // restore
  h.endTurn() // restore's turn
  await waitFor(() => getCompactStatusOnGraph(h.sessionKey).state === 'done')
})

test('a second compact request while one is pending coalesces instead of double-firing', async () => {
  const h = await setupCompactableSession()

  await agentClient.prompt(h.sessionId, 'ongoing work')
  await waitFor(() => h.promptCalls.length > 0)

  const first = await requestCompactOnGraph(h.nodes, h.edges, h.sessionKey)
  const second = await requestCompactOnGraph(h.nodes, h.edges, h.sessionKey)
  assert.equal(first.coalesced, false)
  assert.equal(second.coalesced, true, 'a timed-out caller re-firing must learn it did not start a second compaction')

  h.endTurn() // ongoing work
  await waitFor(() => h.promptCalls.length > 1)
  h.endTurn() // /compact
  await waitFor(() => h.promptCalls.length > 2)
  h.endTurn() // restore
  await waitFor(() => getCompactStatusOnGraph(h.sessionKey).state === 'done')

  // Exactly one /compact dispatch across both requests, not two.
  assert.equal(h.promptCalls.filter((p) => p === '/compact').length, 1)
})
