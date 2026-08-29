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

const peer = (): SocketPeer => ({ send() {} })

test('a burst of jobs evicts only jobs, never the terminals somebody left open', () => {
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
    for (let i = 0; i < 5; i++) {
      assert.equal(manager.prepareJob().ok, true, 'each job finds room in its own pool')
      jobs.push(manager.create(null, fakeHandle(), { sessionKey: `job-${i}`, kind: 'job' }))
    }

    assert.ok(manager.get(first.id), 'the first terminal survived five deploys')
    assert.ok(manager.get(second.id), 'and so did the second')
    const survivingJobs = jobs.filter((job) => manager.get(job.id)).length
    assert.equal(survivingJobs, 2, 'the jobs evicted each other down to their own cap')
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
