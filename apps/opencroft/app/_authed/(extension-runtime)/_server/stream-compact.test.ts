// Regression coverage for the compact action's restore step, which must
// report the RESTORE turn's real outcome, even when a message queued
// during /compact auto-drains into its own turn immediately after /compact
// settles. See awaitDispatchedTurn's header comment in stream.ts for the
// mechanism this proves, and performCompact for why the restore is always
// dispatched with `front: true` — that ordering guarantee is what makes
// this helper's turn-counting correct; these tests exercise it exactly as
// it is actually used, not as a general-purpose queue-position tracker.
//
// Needs a live PGlite data dir (agent-client-instance.ts's transitive
// imports touch the DB at module load) — run with:
//   mkdir -p data/pglite && node_modules/.bin/tsx --test 'app/(extension-runtime)/_server/stream-compact.test.ts'
import assert from 'node:assert/strict'
import test from 'node:test'

import { connectionKey } from 'agent-client/agent-client'
import type { AgentConnection } from 'agent-client/connection'
import type { AgentSelection } from 'agent-client/types'

import { agentClient } from '@/app/_authed/(agent)/_server/agent-client-instance'
import { awaitDispatchedTurn } from './stream'

interface AcpStoreShape {
  connections: Map<string, unknown>
  sessions: Map<string, unknown>
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

// Same seam agent-client.test.ts uses: a mock connection registered under the
// selection's spawn-config key, so createSession never spawns a subprocess.
// `turns` is exposed so a caller can wait for an auto-drained delivery's mock
// call to actually register — activeTurns increments synchronously the
// moment a delivery starts (see deliverPrompt in agent-client.ts), but the
// mock connection.prompt() below it is only reached after awaiting
// connectionForSession, an async gap a caller may need to wait out before
// the NEXT endTurn has anything to resolve.
async function setupSession() {
  counter += 1
  const selection: AgentSelection = {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: `/tmp/stream-compact-test-${counter}`,
  }
  const turns: TurnDeferred[] = []
  const connection = {
    newSession: async () => ({ sessionId: `test-session-${counter}` }),
    prompt: () =>
      new Promise((resolve) => {
        turns.push({ resolve })
      }),
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
  return {
    sessionId: meta.id,
    turns,
    endTurn: (stopReason = 'end_turn') => turns.shift()?.resolve({ stopReason }),
  }
}

test('awaitDispatchedTurn resolves on the RESTORE turn, not a message that auto-drained ahead of it', async () => {
  const h = await setupSession()

  // The precondition this guards: something else is queued while our tracked
  // turn ('/compact', here just 'tracked turn') is running, so it auto-starts
  // the instant that turn settles — before performCompact ever gets to
  // dispatch the restore.
  await agentClient.prompt(h.sessionId, 'tracked turn', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  })
  await agentClient.prompt(h.sessionId, 'auto-drained ping', {
    queue: 'wait',
    origin: { kind: 'message', sender: 'Reader' },
  }) // queues behind the tracked turn

  // front: true, matching performCompact's actual restore dispatch —
  // this is what guarantees the restore becomes the very next thing delivered
  // once the currently active turn ends, ahead of the ping still queued.
  const waitForRestore = awaitDispatchedTurn(h.sessionId, () =>
    agentClient.prompt(h.sessionId, 'restore', { front: true, queue: 'wait', origin: { kind: 'system' } }),
  )

  h.endTurn() // ends the tracked turn; settleTurn auto-drains the restore (front) next
  await waitFor(() => h.turns.length > 0)
  assert.equal(agentClient.hasActiveTurn(h.sessionId), true, 'the restore (pushed to the front) auto-started next')

  h.endTurn() // ends the restore's own turn
  const outcome = await waitForRestore
  assert.equal(outcome, 'finished', 'must resolve on the restore turn, not the tracked turn it waited out')

  // The ping only auto-drains now — proves the restore really did jump ahead
  // of it rather than the two having been conflated.
  await waitFor(() => h.turns.length > 0)
  assert.equal(agentClient.hasActiveTurn(h.sessionId), true, 'the ping is only now starting, after the restore')
  h.endTurn()
  await waitFor(() => agentClient.hasActiveTurn(h.sessionId) === false)
})

test('a cancelled dispatched turn is reported interrupted, not finished', async () => {
  const h = await setupSession()
  const waitForTurn = awaitDispatchedTurn(h.sessionId, () =>
    agentClient.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } }),
  )
  await waitFor(() => h.turns.length > 0)
  h.endTurn('cancelled')
  assert.equal(await waitForTurn, 'interrupted')
})

test('an ordinary finished turn on an otherwise idle session resolves finished', async () => {
  const h = await setupSession()
  const waitForTurn = awaitDispatchedTurn(h.sessionId, () =>
    agentClient.prompt(h.sessionId, 'hello', { queue: 'wait', origin: { kind: 'message', sender: 'Reader' } }),
  )
  await waitFor(() => h.turns.length > 0)
  h.endTurn()
  assert.equal(await waitForTurn, 'finished')
})
