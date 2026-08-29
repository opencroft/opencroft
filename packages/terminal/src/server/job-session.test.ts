// A job session is watchable output, not a shell. Everything below is one of the properties that
// distinction is supposed to buy, exercised against real child processes rather than a fake — the
// echo property in particular is the measured fact the whole design rests on, and reading the
// spawn options would not establish it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { pipedProcessHandle, startJobSession } from './job-session'
import { type SessionHandle, SessionManager, type SocketPeer } from './session-manager'

function collect(handle: SessionHandle): { text: () => string; done: Promise<void> } {
  let text = ''
  handle.onData((data) => {
    text += data
  })
  return {
    text: () => text,
    done: new Promise<void>((resolve) => handle.onExit(() => resolve())),
  }
}

test('a job does not echo what is written to its stdin — the reason it is not a pty', async () => {
  // Stand-in for `docker compose -f - up`: a process handed a document on stdin that prints only
  // a short result. A pty would hand the document straight back to every watcher; the document is
  // where resolved secret values live, so this is the property the design depends on.
  const child = spawn('sh', ['-c', 'cat > /dev/null; echo started'])
  const handle = pipedProcessHandle(child)
  const watched = collect(handle)
  child.stdin?.end('password: not-a-real-secret\n')
  await watched.done
  assert.ok(!watched.text().includes('not-a-real-secret'), 'the input must not come back out')
  assert.equal(watched.text(), 'started\r\n')
})

test('output is line-ended for a terminal rather than for a pipe', async () => {
  // A pipe emits bare \n; xterm needs \r\n or every line starts where the previous one ended.
  const child = spawn('sh', ['-c', 'printf "one\\ntwo\\n"'])
  const watched = collect(pipedProcessHandle(child))
  await watched.done
  assert.equal(watched.text(), 'one\r\ntwo\r\n')
})

test('both streams are watched, not just stdout', async () => {
  const child = spawn('sh', ['-c', 'echo out; echo err >&2'])
  const watched = collect(pipedProcessHandle(child))
  await watched.done
  assert.ok(watched.text().includes('out'))
  assert.ok(watched.text().includes('err'), 'a build says most of what matters on stderr')
})

test('an attached watcher cannot type into the job', async () => {
  // `manager.write` routes a client's keystrokes to its session's handle. For a job that must go
  // nowhere: watching a build is not permission to drive it.
  const child = spawn('sh', ['-c', 'cat; echo done'])
  const handle = pipedProcessHandle(child)
  const watched = collect(handle)
  handle.write('injected-by-a-watcher\n')
  child.stdin?.end()
  await watched.done
  assert.ok(!watched.text().includes('injected-by-a-watcher'), 'the write reached nothing')
  assert.equal(watched.text(), 'done\r\n')
})

test('the key handed back is unguessable, and not derived from anything the caller supplied', () => {
  // Knowing a session key is the whole authorisation to attach to a session, so a key computed
  // from the command, a node id, or a service name would put the job's output within reach of
  // anyone who could compute the same thing.
  const opts = { command: 'sh', args: ['-c', 'exit 0'] }
  const first = startJobSession(opts)
  const second = startJobSession(opts)

  assert.notEqual(first.sessionKey, second.sessionKey, 'identical inputs must not give the same key')
  for (const value of [opts.command, ...opts.args]) {
    assert.ok(!first.sessionKey.includes(value), `the key must not contain "${value}"`)
  }
  assert.match(first.sessionKey, /^job:[0-9a-f]{32}$/, 'and it carries enough randomness to be unguessable')
})

// ── capacity: a job must never cost somebody the terminal they have open ──

function fakeHandle(): SessionHandle {
  return {
    onData() {},
    onExit() {},
    write() {},
    resize() {},
    kill() {},
    isAlive: () => true,
  }
}

/** A handle whose process has already exited — what a finished deploy leaves behind. */
function deadHandle(): SessionHandle {
  return { ...fakeHandle(), isAlive: () => false }
}

const peer = (): SocketPeer => ({ send() {} })

test('a burst of jobs never touches the terminals somebody left open', () => {
  const manager = new SessionManager({ maxSessions: 2, maxJobSessions: 2 })
  try {
    // Two interactive sessions, both detached — under one shared budget these are precisely the
    // sessions eviction reaches for first, which is the state this separation exists to prevent.
    const peerOne = peer()
    const peerTwo = peer()
    const first = manager.create(peerOne, fakeHandle(), { sessionKey: 'terminal-one' })
    const second = manager.create(peerTwo, fakeHandle(), { sessionKey: 'terminal-two' })
    manager.handleSocketClose(peerOne)
    manager.handleSocketClose(peerTwo)

    const jobs = []
    for (let i = 0; i < 2; i++) {
      assert.equal(manager.prepareJob().ok, true, 'jobs fill their own pool')
      jobs.push(manager.create(null, fakeHandle(), { sessionKey: `job-${i}`, kind: 'job' }))
    }
    const third = manager.prepareJob()

    assert.equal(third.ok, false, 'a pool of running jobs refuses rather than killing one of them')
    assert.ok(
      jobs.every((job) => manager.get(job.id)),
      'both running jobs are still running',
    )
    assert.ok(manager.get(first.id), 'and neither terminal was ever a candidate')
    assert.ok(manager.get(second.id))
  } finally {
    manager.dispose()
  }
})

test('a running job is not evicted to make room for another', () => {
  // A job is created detached, because it starts before anyone is watching. That must not put it
  // in the set eviction draws from: reclaiming a job means killing a deploy that is still going.
  const manager = new SessionManager({ maxJobSessions: 1 })
  try {
    const running = manager.create(null, fakeHandle(), { sessionKey: 'job-running', kind: 'job' })
    const refused = manager.prepareJob()

    assert.equal(refused.ok, false, 'the pool refuses')
    assert.ok(manager.get(running.id), 'and the deploy already in flight is untouched')
  } finally {
    manager.dispose()
  }
})

test('a job whose process has exited IS reclaimable — the cap is a cap, not a wall', () => {
  const manager = new SessionManager({ maxJobSessions: 1 })
  try {
    const finished = manager.create(null, deadHandle(), { sessionKey: 'job-finished', kind: 'job' })
    assert.equal(manager.prepareJob().ok, true, 'a finished job is stale output, and gives way')
    assert.equal(manager.get(finished.id), undefined, 'it was reclaimed')
  } finally {
    manager.dispose()
  }
})

test('a running job survives the detached TTL', async () => {
  // The TTL is about output nobody came back for, not about the process. A deploy nobody is
  // watching is not abandoned — it is working. The control is what makes this a real check:
  // an abandoned interactive session in the same manager must be swept, proving a sweep ran.
  const manager = new SessionManager({ detachedTtlMs: 1, sweepIntervalMs: 5 })
  try {
    const abandonedPeer = peer()
    const abandoned = manager.create(abandonedPeer, fakeHandle(), { sessionKey: 'terminal' })
    manager.handleSocketClose(abandonedPeer)
    const job = manager.create(null, fakeHandle(), { sessionKey: 'job-running', kind: 'job' })

    const deadline = Date.now() + 2000
    while (manager.get(abandoned.id) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    assert.equal(manager.get(abandoned.id), undefined, 'a sweep ran and reclaimed the abandoned shell')
    assert.ok(manager.get(job.id), 'and left the running job alone')
  } finally {
    manager.dispose()
  }
})

test('a job pool with nothing evictable refuses instead of reaching into the interactive one', () => {
  const manager = new SessionManager({ maxSessions: 5, maxJobSessions: 1 })
  try {
    const terminalPeer = peer()
    const terminal = manager.create(terminalPeer, fakeHandle(), { sessionKey: 'terminal' })

    assert.equal(manager.prepareJob().ok, true)
    const job = manager.create(null, fakeHandle(), { sessionKey: 'job-one', kind: 'job' })
    // Someone is watching this job, so it is not detached and not evictable. The pool is full
    // with nothing to reclaim — the one case where a shared budget would have taken the terminal.
    manager.attach(peer(), { sessionKey: 'job-one', cols: 80, rows: 24 })

    const refused = manager.prepareJob()
    assert.equal(refused.ok, false, 'the second job is refused')
    assert.ok(manager.get(terminal.id), 'and the interactive session was never a candidate')
    assert.ok(manager.get(job.id), 'nor was the job being watched')
  } finally {
    manager.dispose()
  }
})

test('an interactive session is never counted against the job budget', () => {
  const manager = new SessionManager({ maxSessions: 1, maxJobSessions: 1 })
  try {
    manager.create(peer(), fakeHandle(), { sessionKey: 'terminal' })
    assert.equal(manager.prepareJob().ok, true, 'the job budget is untouched by the terminal')
  } finally {
    manager.dispose()
  }
})
