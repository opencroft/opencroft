import assert from 'node:assert/strict'
import test from 'node:test'

import { claudeSelection, type LoggedRequest, turnOutcome, withFakeClaude } from './test-fixtures/with-fake-claude'

// A session lives in the bridge process that opened it. When that process's
// connection closes — an oversized line, a crash, a kill — the next process has
// never heard of the session, so the client has to resume it there before it
// sends anything. Over a real ACP connection, against a fake that keeps its
// transcripts on disk and exits when its connection closes, as the bridge does.

function pidOf(request: LoggedRequest | undefined): unknown {
  return (request as (LoggedRequest & { pid?: number }) | undefined)?.pid
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let waited = 0; waited < 5000; waited += 10) {
    if (check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition never held')
}

// Kills the process that opened the session and waits until it is gone.
async function killSessionProcess(requests: LoggedRequest[]): Promise<number> {
  const pid = pidOf(requests.find((request) => request.method === 'session/new'))
  assert.equal(typeof pid, 'number')
  process.kill(pid as number, 'SIGKILL')
  await waitFor(() => {
    try {
      process.kill(pid as number, 0)
      return false
    } catch {
      return true
    }
  })
  return pid as number
}

test('after the connection closes mid-turn, the next prompt resumes the session on a new process and runs', async () => {
  await withFakeClaude('prompt-drops-connection', async (h) => {
    const meta = await h.client.createSession(claudeSelection(h.cwd))
    await h.client.prompt(meta.id, 'drop the connection', { queue: 'push', origin: { kind: 'system' } })
    const dropped = await turnOutcome(h.events, meta.id)
    assert.equal(dropped.kind, 'error', 'the turn the connection took down ends as an error')

    const from = h.events.length
    await h.client.prompt(meta.id, 'hello again', { queue: 'push', origin: { kind: 'system' } })
    assert.equal((await turnOutcome(h.events, meta.id, from)).kind, 'turn_end')

    const requests = h.requests()
    const first = requests.find((request) => request.method === 'session/new')
    const again = requests.filter((request) => request.method === 'session/prompt').at(-1)
    assert.notEqual(pidOf(again), pidOf(first), 'the prompt went to a new process')
    const onNew = requests.filter((request) => pidOf(request) === pidOf(again)).map((request) => request.method)
    assert.deepEqual(
      onNew.filter((method) => method.startsWith('session/')).slice(0, 2),
      ['session/resume', 'session/prompt'],
      'resumed there before it was prompted',
    )
    assert.equal(again?.params.sessionId, meta.id)
  })
})

test('after the process exits between turns, the next prompt resumes the session on a new process and runs', async () => {
  await withFakeClaude('', async (h) => {
    const meta = await h.client.createSession(claudeSelection(h.cwd))
    await h.client.prompt(meta.id, 'first', { queue: 'push', origin: { kind: 'system' } })
    assert.equal((await turnOutcome(h.events, meta.id)).kind, 'turn_end')

    const pid = await killSessionProcess(h.requests())

    const from = h.events.length
    await h.client.prompt(meta.id, 'second', { queue: 'push', origin: { kind: 'system' } })
    assert.equal((await turnOutcome(h.events, meta.id, from)).kind, 'turn_end')
    const resumed = h.requests().filter((request) => request.method === 'session/resume')
    assert.equal(resumed.length, 1)
    assert.equal(resumed[0].params.sessionId, meta.id)
    assert.notEqual(pidOf(resumed[0]), pid)
  })
})

test('a Stop after the process is gone cancels nothing and starts no process', async () => {
  await withFakeClaude('', async (h) => {
    const meta = await h.client.createSession(claudeSelection(h.cwd))
    await killSessionProcess(h.requests())
    const before = h.requests().length
    await h.client.cancel(meta.id)
    assert.deepEqual(h.requests().slice(before), [], 'no process was started and nothing was resumed')
  })
})

test('forking a session whose process is gone resumes it on a new process first', async () => {
  await withFakeClaude('', async (h) => {
    const source = await h.client.createSession(claudeSelection(h.cwd))
    await h.client.prompt(source.id, 'first', { queue: 'push', origin: { kind: 'system' } })
    assert.equal((await turnOutcome(h.events, source.id)).kind, 'turn_end')
    const pid = await killSessionProcess(h.requests())

    const fork = await h.client.forkSession(source.id, 0)
    assert.ok(fork)
    const onNew = h
      .requests()
      .filter((request) => pidOf(request) !== pid && request.method.startsWith('session/'))
      .map((request) => [request.method, request.params.sessionId])
    assert.deepEqual(onNew.slice(0, 3), [
      ['session/resume', source.id],
      ['session/fork', source.id],
      ['session/resume', fork.id],
    ])
  })
})

test('calls that arrive together after the process is gone share one resume', async () => {
  await withFakeClaude('', async (h) => {
    const meta = await h.client.createSession(claudeSelection(h.cwd))
    await killSessionProcess(h.requests())
    await Promise.all([h.client.setMode(meta.id, 'plan'), h.client.setMode(meta.id, 'acceptEdits')])
    const resumed = h.requests().filter((request) => request.method === 'session/resume')
    assert.equal(resumed.length, 1)
    assert.equal(
      h.requests().filter((request) => request.method === 'session/set_mode').length,
      2,
      'both calls went through, on the resumed session',
    )
  })
})
