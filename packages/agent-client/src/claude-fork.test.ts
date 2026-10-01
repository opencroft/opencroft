import assert from 'node:assert/strict'
import test from 'node:test'

import { claudeSelection as selection, turnOutcome, withFakeClaude } from './test-fixtures/with-fake-claude'
import type { ChatEvent } from './types'

// The Claude bridge's fork, driven end to end over a real ACP connection.
// Over the wire rather than through a mock connection because the defect
// lives in the wire: a plain throw in the bridge reaches this side as -32603
// "Internal error", with the cause in `data`, and only the ACP SDK's own
// encoding reproduces that.

const KEY = 'zai-test-DO-NOT-LEAK-0123456789abcdef'

const claudeSelection = (cwd: string) => selection(cwd, KEY)

test('an edit on the Claude bridge opens its fork before sending the edited turn, on the model the reader chose', async () => {
  await withFakeClaude('', async (h) => {
    const source = await h.client.createSession(claudeSelection(h.cwd))
    // The reader switched the chat to another model than the one the agent
    // node pins, which is what a resume on the bridge does not keep.
    await h.client.setConfigOption(source.id, 'model', 'claude-sonnet-5')
    await h.client.prompt(source.id, 'first', { queue: 'push', origin: { kind: 'system' } })
    assert.equal((await turnOutcome(h.events, source.id)).kind, 'turn_end')

    const before = h.requests().length
    const fork = await h.client.forkSession(source.id, 0)
    assert.ok(fork)
    const mark = h.events.length
    await h.client.prompt(fork.id, 'edited', { queue: 'wait', origin: { kind: 'system' } })
    const outcome = await turnOutcome(h.events, fork.id, mark)
    assert.equal(outcome.kind, 'turn_end', `the edited turn failed: ${JSON.stringify(outcome)}`)

    const after = h.requests().slice(before)
    assert.deepEqual(
      after.map((request) => request.method),
      ['session/fork', 'session/resume', 'session/set_config_option', 'session/prompt'],
    )
    const [, resumed, set, prompted] = after
    assert.equal(resumed.params.sessionId, fork.id, 'the fork itself is what gets opened')
    assert.equal(set.params.sessionId, fork.id)
    assert.deepEqual([set.params.configId, set.params.value], ['model', 'claude-sonnet-5'])
    assert.equal(prompted.params.sessionId, fork.id)

    // And the chat is told so. The fork's own event log is what a reader's
    // badge is drawn from, so its last word on the model has to be the one the
    // fork runs, not the one the resume opened it on.
    const snapshots = h.client.getSessionEvents(fork.id)?.filter((event) => event.kind === 'config_options') ?? []
    const last = snapshots.at(-1)
    assert.ok(last, 'the fork has a config snapshot')
    assert.equal(
      last.options.find((option) => option.id === 'model')?.currentValue,
      'claude-sonnet-5',
      `the last model the fork reported: ${JSON.stringify(snapshots.map((event) => event.options.find((option) => option.id === 'model')?.currentValue))}`,
    )
  })
})

test("an agent's refusal names its cause in the chat and in full in the server log, with the key redacted", async () => {
  await withFakeClaude('prompt-leaks-key', async (h) => {
    const meta = await h.client.createSession(claudeSelection(h.cwd))
    await h.client.prompt(meta.id, 'hello', { queue: 'push', origin: { kind: 'system' } })
    const outcome = await turnOutcome(h.events, meta.id)
    assert.equal(outcome.kind, 'error')
    assert.equal(
      (outcome as Extract<ChatEvent, { kind: 'error' }>).message,
      'Internal error (provider refused Authorization: Bearer [redacted])',
    )
    const logged = h.printed.find((line) => line.includes('session/prompt'))
    assert.ok(logged, `the refusal is logged: ${JSON.stringify(h.printed)}`)
    assert.match(logged, /code -32603/)
    assert.match(logged, /"details":"provider refused Authorization: Bearer \[redacted\]"/)
    assert.ok(logged.includes(meta.id), 'the log names the session')
    assert.ok(!JSON.stringify(h.events).includes(KEY), 'no event carries the key')
    assert.ok(!h.printed.join('\n').includes(KEY), 'nothing printed carries the key')
  })
})

test('a fork the Claude bridge cannot open refuses the edit and leaves no session behind', async () => {
  await withFakeClaude('fork-unresumable', async (h) => {
    const source = await h.client.createSession(claudeSelection(h.cwd))
    await h.client.prompt(source.id, 'first', { queue: 'push', origin: { kind: 'system' } })
    assert.equal((await turnOutcome(h.events, source.id)).kind, 'turn_end')

    await assert.rejects(
      h.client.forkSession(source.id, 0),
      /^Error: The fork was made but could not be opened: Internal error \(transcript unreadable\)$/,
    )
    assert.deepEqual(
      h.client.listSessions().map((session) => session.id),
      [source.id],
      'only the source is left',
    )
    assert.ok(
      !h.requests().some((request) => request.method === 'session/prompt' && request.params.sessionId !== source.id),
    )
    assert.ok(
      h.printed.some((line) => line.includes('session/resume failed') && line.includes('transcript unreadable')),
    )
  })
})
