// Coverage for the async compact contract: requestCompact must return
// immediately, must never send anything into a session with a turn running
// (queue behind it instead of interrupting it), and must coalesce a second
// request for a session that already has one pending or running.
//
// Needs a live PGlite data dir (agent-client-instance.ts's transitive imports
// touch the DB at module load), same as stream-compact.test.ts — run through
// the project runner from apps/opencroft.
import assert from 'node:assert/strict'
import test from 'node:test'

import { connectionKey } from 'agent-client/agent-client'
import type { AgentConnection } from 'agent-client/connection'
import type { AgentSelection } from 'agent-client/types'

import { tabSessions } from '@/app/_authed/(agent)/_server/acp-impl'
import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { getCompactStatus, registerStandingContextResolver, requestCompact, restoreAfterCompaction } from './stream'

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

// Waits for a condition and gives up loudly, rather than sleeping for a length
// of time and hoping. Examined during a sweep for tests bounded by a guess;
// this is the shape those were changed INTO.
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

// Session keys claimed by the standing-context resolver registered below —
// standing context resolves exclusively through registered resolvers, so a
// test session needs a resolver that recognises its key, exactly as a
// group-chat thread's keys are claimed by the resolver registered at server
// boot.
const CLAIMED_PREFIX = 'compact-test-session-'

registerStandingContextResolver(async (sessionKey) =>
  sessionKey.startsWith(CLAIMED_PREFIX)
    ? { jobContext: 'context the restore must bring back', instructions: [] }
    : null,
)

// Creates a live mock-backed ACP session (a mock connection seeded under the
// selection's spawn-config key, so createSession never spawns a real
// subprocess), then registers it into tabSessions directly.
// findTargetSessionImpl reads tabSessions directly, so this is enough for
// requestCompact's own session lookup to work.
async function setupCompactableSession(keyPrefix = CLAIMED_PREFIX): Promise<{
  sessionKey: string
  sessionId: string
  promptCalls: string[]
  turns: TurnDeferred[]
  endTurn: (stopReason?: string) => void
}> {
  counter += 1
  const sessionKey = `${keyPrefix}${counter}`

  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/compact-async-test-${counter}`,
    // As production sessions carry it (acp-impl passes the tab key): the
    // event-driven restore resolves a session's key through listSessions,
    // so its tests need the metadata real sessions have.
    sessionKey,
  }
  const turns: TurnDeferred[] = []
  const promptCalls: string[] = []
  const connection = {
    newSession: async () => ({ sessionId: `compact-async-session-${counter}` }),
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
  const key = connectionKey(selection)
  acpStore().connections.set(key, {
    connection,
    lastSessionId: null,
    loadSession: false,
    initialized: Promise.resolve(),
  })

  const meta = await agentClient.createSession(selection)
  tabSessions.set(sessionKey, {
    id: meta.id,
    canFork: false,
    canSteer: false,
    canAttachImages: false,
    everPrompted: true,
  })

  return {
    sessionKey,
    sessionId: meta.id,
    promptCalls,
    turns,
    endTurn: (stopReason = 'end_turn') => turns.shift()?.resolve({ stopReason }),
  }
}

test('compact against an idle session returns immediately and runs to completion', async () => {
  const h = await setupCompactableSession()

  const ack = await requestCompact(h.sessionKey)
  assert.deepEqual(ack, { sessionKey: h.sessionKey, accepted: true, coalesced: false, state: 'pending' })

  await waitFor(() => h.promptCalls.length > 0)
  assert.equal(h.promptCalls[0], '/compact', 'the session was idle, so /compact dispatches right away')
  assert.equal(getCompactStatus(h.sessionKey).state, 'running')

  h.endTurn() // settles /compact's own turn
  await waitFor(() => h.promptCalls.length > 1) // the instruction restore auto-dispatches next
  h.endTurn() // settles the restore's turn

  await waitFor(() => getCompactStatus(h.sessionKey).state === 'done')
  const status = getCompactStatus(h.sessionKey)
  assert.equal(status.result?.instructionsRestored, true)
})

// Asserted on the text actually dispatched rather than on the note constant,
// because the requirement is about ORDER as much as content: the restore is
// assembled by composeEnvelope, and only the assembled message can show that
// the instruction is what the agent reads last.
test('the restore closes with the re-orientation instruction, under the context it re-delivers', async () => {
  const h = await setupCompactableSession()

  await requestCompact(h.sessionKey)
  await waitFor(() => h.promptCalls.length > 0)
  h.endTurn() // settles /compact's own turn
  await waitFor(() => h.promptCalls.length > 1)
  const restore = h.promptCalls[1] ?? ''
  h.endTurn() // settles the restore's turn

  // The re-delivered context is still all there. The instruction is an
  // addition to the restore, never a replacement for what it exists to carry.
  assert.match(restore, /<opencroft-task>context the restore must bring back<\/opencroft-task>/)

  // The standing wording for this rule, quoted rather than paraphrased, so
  // the message and every agent's standing instructions state it identically. A
  // paraphrase here would read as a second rule arriving beside the first.
  const instructionAt = restore.indexOf('Work starts ONLY from an incoming dispatch message.')
  assert.ok(instructionAt > -1, 'the restore says in so many words that it is not a dispatch')

  // The licence to re-load has to survive alongside the instruction to stop.
  // Dropping it leaves the next real dispatch landing on an agent that has
  // forgotten how its environment works, which is the opposite failure.
  assert.match(restore, /re-loading anything they tell you to load/)
  assert.ok(
    restore.indexOf('<opencroft-task>') < instructionAt,
    'context first, then what to do with it — the other order describes a message that has not arrived yet',
  )
  assert.ok(
    restore.trimEnd().endsWith('The next task arrives as its own message.'),
    'and it must be the LAST thing read: an agent that stops at the context has been given no reason to stop',
  )
})

test('compact against a working session queues behind the turn without interrupting it', async () => {
  const h = await setupCompactableSession()

  await agentClient.prompt(h.sessionId, 'ongoing work', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  await waitFor(() => h.promptCalls.length > 0)
  assert.match(
    h.promptCalls[0] ?? '',
    /ongoing work$/,
    'delivered text carries the delivery-time stamp ahead of the message',
  )

  const ack = await requestCompact(h.sessionKey)
  assert.deepEqual(ack, { sessionKey: h.sessionKey, accepted: true, coalesced: false, state: 'pending' })
  // Still pending -- nothing was sent for the compaction while the turn runs,
  // which is what makes this "never interrupt" rather than merely "queue the
  // request and hope".
  assert.equal(getCompactStatus(h.sessionKey).state, 'pending')
  assert.equal(h.promptCalls.length, 1, 'no /compact dispatched while the ongoing turn is still running')
  assert.equal(agentClient.hasActiveTurn(h.sessionId), true, 'the ongoing turn is untouched, not cancelled')

  h.endTurn() // the ongoing turn finishes on its own
  await waitFor(() => h.promptCalls.length > 1)
  assert.equal(h.promptCalls[1], '/compact', 'compaction dispatches only once the turn it queued behind ended')
  assert.equal(getCompactStatus(h.sessionKey).state, 'running')

  h.endTurn() // /compact's turn
  await waitFor(() => h.promptCalls.length > 2) // restore
  h.endTurn() // restore's turn
  await waitFor(() => getCompactStatus(h.sessionKey).state === 'done')
})

test('a second compact request while one is pending coalesces instead of double-firing', async () => {
  const h = await setupCompactableSession()

  await agentClient.prompt(h.sessionId, 'ongoing work', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  await waitFor(() => h.promptCalls.length > 0)

  const first = await requestCompact(h.sessionKey)
  const second = await requestCompact(h.sessionKey)
  assert.equal(first.coalesced, false)
  assert.equal(second.coalesced, true, 'a timed-out caller re-firing must learn it did not start a second compaction')

  h.endTurn() // ongoing work
  await waitFor(() => h.promptCalls.length > 1)
  h.endTurn() // /compact
  await waitFor(() => h.promptCalls.length > 2)
  h.endTurn() // restore
  await waitFor(() => getCompactStatus(h.sessionKey).state === 'done')

  // Exactly one /compact dispatch across both requests, not two.
  assert.equal(h.promptCalls.filter((p) => p === '/compact').length, 1)
})

test('compact refuses a key no standing-context resolver claims', async () => {
  await assert.rejects(
    () => requestCompact('nobody-claims-this-key'),
    /No agent resolved/,
    'a key with no owner has no context to restore, so the request is refused up front',
  )
})

test('compact refuses a claimed key that was never actually created, and creates nothing', async () => {
  // Claimed by the resolver above, but nothing was ever dispatched to this
  // exact key: no tabSessions entry, no durable pointer. It must be refused,
  // not silently woken into a brand-new session for a key nobody ever sent to.
  const sessionKey = `${CLAIMED_PREFIX}never-created`

  await assert.rejects(
    () => requestCompact(sessionKey),
    /cannot be resumed/,
    'a never-created key must be refused, not silently woken into a new session',
  )

  assert.equal(
    agentClient.listSessions().some((s) => s.sessionKey === sessionKey),
    false,
    'the refusal must not have spawned a live session for this key',
  )
})

// ── the event-driven restore (harness-reported compactions) ────────────────

test('a harness-reported compaction completing restores standing context, driven by the event alone', async () => {
  const h = await setupCompactableSession()

  await restoreAfterCompaction(h.sessionId, { compactionId: 'auto-1', status: 'completed' })
  await waitFor(() => h.promptCalls.length > 0)
  const restore = h.promptCalls[0] ?? ''
  assert.match(
    restore,
    /<opencroft-task>context the restore must bring back<\/opencroft-task>/,
    'the context comes back without anybody having pressed Compact',
  )
  assert.match(restore, /Work starts ONLY from an incoming dispatch message\./)
  h.endTurn() // the restore's own turn
})

test('the event path restores nothing for a non-terminal transition or an unclaimed session', async () => {
  const h = await setupCompactableSession()
  await restoreAfterCompaction(h.sessionId, { compactionId: 'auto-2', status: 'in_progress' })
  await restoreAfterCompaction(h.sessionId, { compactionId: 'auto-2', status: 'failed', error: 'no' })
  assert.equal(h.promptCalls.length, 0, 'only a completed compaction dropped anything worth re-sending')

  const unclaimed = await setupCompactableSession('nobody-claims-')
  await restoreAfterCompaction(unclaimed.sessionId, { compactionId: 'auto-3', status: 'completed' })
  assert.equal(unclaimed.promptCalls.length, 0, 'a key no resolver owns has no standing context to restore')
})

test('the event path defers to a live compact job, which owns that restore', async () => {
  const h = await setupCompactableSession()

  await requestCompact(h.sessionKey)
  await waitFor(() => h.promptCalls.length > 0) // '/compact' dispatched, job running

  // The harness reports the compaction the job's /compact caused — mid-turn,
  // exactly when the real event arrives. The job is still running, so the
  // event path must stand back rather than double-restore.
  await restoreAfterCompaction(h.sessionId, { compactionId: 'job-1', status: 'completed' })
  assert.equal(h.promptCalls.length, 1, 'no second restore raced the job')

  h.endTurn() // /compact's turn
  await waitFor(() => h.promptCalls.length > 1) // the job's own restore
  h.endTurn() // restore's turn
  await waitFor(() => getCompactStatus(h.sessionKey).state === 'done')

  const restores = h.promptCalls.filter((p) => p.includes('<opencroft-task>'))
  assert.equal(restores.length, 1, 'exactly one restore reached the session')
})
