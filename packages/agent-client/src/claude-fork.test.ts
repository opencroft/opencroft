import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createAgentClient } from './agent-client'
import { HARNESS_ADAPTERS } from './harness-adapters'
import type { AgentSelection, ChatEvent } from './types'

// The Claude bridge's fork, driven end to end over a real ACP connection
// against a fake that keeps claude-agent-acp's contract as read from its
// source (test-fixtures/fake-claude-agent.mjs). Over the wire rather than
// through a mock connection because the defect lives in the wire: a plain
// throw in the bridge reaches this side as -32603 "Internal error", with the
// cause in `data`, and only the ACP SDK's own encoding reproduces that.

const FAKE_AGENT = fileURLToPath(new URL('./test-fixtures/fake-claude-agent.mjs', import.meta.url))
const KEY = 'zai-test-DO-NOT-LEAK-0123456789abcdef'

interface LoggedRequest {
  method: string
  params: Record<string, unknown>
}

function claudeSelection(cwd: string): AgentSelection {
  return {
    providerId: 'zai',
    adapterId: 'claude',
    model: 'glm-5.3-flash[1m]',
    apiKey: KEY,
    cwd,
  }
}

async function withFakeClaude(
  mode: string,
  run: (h: {
    client: ReturnType<typeof createAgentClient>
    cwd: string
    requests: () => LoggedRequest[]
    events: Array<{ sessionId: string; event: ChatEvent }>
    printed: string[]
  }) => Promise<void>,
): Promise<void> {
  const adapter = HARNESS_ADAPTERS.find((entry) => entry.id === 'claude')
  assert.ok(adapter)
  const saved = { command: adapter.command, args: adapter.args }
  const dir = mkdtempSync(join(tmpdir(), 'claude-fork-'))
  const logFile = join(dir, 'requests.jsonl')
  const cwd = join(dir, 'work')
  mkdirSync(cwd)
  const savedEnv = { log: process.env.FAKE_AGENT_LOG, mode: process.env.FAKE_AGENT_MODE }
  process.env.FAKE_AGENT_LOG = logFile
  process.env.FAKE_AGENT_MODE = mode
  adapter.command = process.execPath
  adapter.args = [FAKE_AGENT]
  const printed: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    printed.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(' '))
  }
  const events: Array<{ sessionId: string; event: ChatEvent }> = []
  const client = createAgentClient({
    onEvent: (sessionId, event) => events.push({ sessionId, event }),
    loadMcpServers: async () => [],
  })
  try {
    await run({
      client,
      cwd,
      requests: () =>
        existsSync(logFile)
          ? readFileSync(logFile, 'utf8')
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as LoggedRequest)
          : [],
      events,
      printed,
    })
  } finally {
    await client.reset()
    console.error = originalError
    adapter.command = saved.command
    adapter.args = saved.args
    if (savedEnv.log === undefined) delete process.env.FAKE_AGENT_LOG
    else process.env.FAKE_AGENT_LOG = savedEnv.log
    if (savedEnv.mode === undefined) delete process.env.FAKE_AGENT_MODE
    else process.env.FAKE_AGENT_MODE = savedEnv.mode
    rmSync(dir, { recursive: true, force: true })
  }
}

// The first turn_end or error a session emits from `from` on: how a turn ends.
async function turnOutcome(
  events: Array<{ sessionId: string; event: ChatEvent }>,
  sessionId: string,
  from = 0,
): Promise<ChatEvent> {
  for (let waited = 0; waited < 5000; waited += 10) {
    const hit = events
      .slice(from)
      .find(
        (entry) => entry.sessionId === sessionId && (entry.event.kind === 'turn_end' || entry.event.kind === 'error'),
      )
    if (hit) {
      return hit.event
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`session ${sessionId} never ended its turn`)
}

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
