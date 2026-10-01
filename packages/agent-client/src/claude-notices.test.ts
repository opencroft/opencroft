import assert from 'node:assert/strict'
import test from 'node:test'

import { foldEvents } from './fold'
import { claudeSelection, turnOutcome, withFakeClaude } from './test-fixtures/with-fake-claude'

// Session notices over a real ACP connection: the client has to advertise the
// capability for a bridge to send them at all, and the ACP SDK validates every
// inbound session/update against its own schema, so an SDK that does not know
// the `notice` kind would drop them before any of this package's code ran.

test('a bridge told the client presents notices sends them as notices, and each lands as its own event', async () => {
  await withFakeClaude('prompt-sends-notices', async (h) => {
    const meta = await h.client.createSession(claudeSelection(h.cwd))
    await h.client.prompt(meta.id, 'go', { queue: 'push', origin: { kind: 'system' } })
    assert.equal((await turnOutcome(h.events, meta.id)).kind, 'turn_end')

    const initialize = h.requests().find((request) => request.method === 'initialize')
    const capabilities = initialize?.params.clientCapabilities as { session?: Record<string, unknown> } | undefined
    assert.deepEqual(capabilities?.session?.notices, {}, 'the capability is advertised')

    const logged = h.client.getSessionEvents(meta.id) ?? []
    assert.deepEqual(
      logged.filter((event) => event.kind === 'notice'),
      [
        { kind: 'notice', notice: { severity: 'info', title: 'Task stopped by user', description: 'npm run dev.' } },
        {
          kind: 'notice',
          notice: { severity: 'warning', title: 'Model fallback', description: 'Switched to a smaller model.' },
        },
        { kind: 'notice', notice: { severity: 'error', title: 'Hook blocked the turn' } },
      ],
      'in the session log, which is what a reopened chat is drawn from',
    )
    assert.ok(!logged.some((event) => event.kind === 'agent_message'), 'none of them arrived as agent text')
    assert.deepEqual(
      foldEvents(logged)
        .filter((message) => message.kind === 'notice')
        .map((message) => message.kind === 'notice' && message.severity),
      ['info', 'warning', 'error'],
    )
  })
})
