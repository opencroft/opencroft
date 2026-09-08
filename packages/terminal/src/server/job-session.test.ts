// A job session is watchable output, not a shell. Everything below is one of the properties that
// distinction is supposed to buy, exercised against real child processes rather than a fake — the
// echo property in particular is the measured fact the whole design rests on, and reading the
// spawn options would not establish it.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import type { TerminalContext } from '../types'
import { MAX_JOB_LIFETIME_MS, startJobSession } from './job-session'
import { sessionManager } from './manager'
import { type SessionHandle, SessionManager, type SocketPeer } from './session-manager'
import { pipedProcessHandle } from './stream-handle'

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

test('a job that fails to start ends like one that finished, and says why', async () => {
  // The whole point: a spawn failure is an `'error'` event, and a ChildProcess with no listener
  // for it raises an unhandled exception rather than swallowing it. `node:test` attributes that
  // to whichever test is running, so this reddens against a handle that does not listen — the
  // implementation it replaces IS the mutation, and no separate one is needed.
  //
  // It is also the event the caller cannot handle for itself: `startJobSession` returns a key,
  // not the child, so a watcher would otherwise attach to a session that was never created and
  // be told only that it does not exist, while the reason went nowhere a person can read.
  const child = spawn('definitely-not-a-real-command-for-this-test')
  const handle = pipedProcessHandle(child)
  const watched = collect(handle)
  await watched.done

  assert.match(watched.text(), /ENOENT/, 'the reason reaches the watcher')
  assert.match(watched.text(), /definitely-not-a-real-command-for-this-test/, 'and names what failed')
  assert.equal(handle.isAlive(), false, 'and the job is over, so the manager can reclaim its slot')
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

test('the key handed back is unguessable, and not derived from anything the caller supplied', async () => {
  // Knowing a session key is the whole authorisation to attach to a session, so a key computed
  // from the command, a node id, or a service name would put the job's output within reach of
  // anyone who could compute the same thing.
  const opts = { command: 'sh', args: ['-c', 'exit 0'] }
  const first = await startJobSession({ type: 'local' }, opts)
  const second = await startJobSession({ type: 'local' }, opts)

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

/**
 * A handle whose process has already exited — what a finished deploy leaves behind.
 *
 * A constructed state, not one the real handle produces: `pipedProcessHandle` fires its exit
 * callbacks on close, and `create` registers one that kills the session, so a real dead job is
 * removed rather than left registered. This double's `onExit` is a no-op, which is the only
 * reason a dead-but-registered session exists here at all. It is the right shape for testing the
 * reclaim policy and the wrong shape for reasoning about what production leaves lying around.
 */
function deadHandle(): SessionHandle {
  return { ...fakeHandle(), isAlive: () => false }
}

/**
 * A handle that remembers whether anything ended it.
 *
 * The dispositions below are all about what happens to the COMMAND, so they are checked at the
 * command. `manager.get(id)` returning a session says the registry still holds it, which is a
 * weaker statement than "nothing killed the process" and would still pass if a future `kill` path
 * stopped deregistering.
 */
function tracedHandle(): SessionHandle & { killed: () => boolean } {
  let killed = false
  return {
    ...fakeHandle(),
    kill() {
      killed = true
    },
    killed: () => killed,
  }
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

// ── a client reaching a live job: three doors, one rule ──
//
// The rule is that a client may take over the watch and may never end the command. Each door gets
// its own test because the first version of this held at one of the three and read as an invariant.

test('a second connection to a running job takes over the watch, and never ends the command', () => {
  // `prepareConnect` replaces a live same-key session so a reconnecting tab wins over a socket that
  // has not noticed it is gone -- correct for a shell, which the client can simply open again.
  // Applied to a job that would kill a deploy mid-flight to hand a second watcher an empty session.
  // Refusing instead was the first fix and it locked the person out of watching their own deploy;
  // taking over keeps the command AND lets them back in.
  const manager = new SessionManager()
  try {
    const stale = peer()
    const handle = tracedHandle()
    const job = manager.create(stale, handle, { sessionKey: 'job:abc', kind: 'job' })

    const newcomer = peer()
    const decision = manager.prepareConnect(newcomer, 'job:abc', 80, 24)

    assert.equal(decision.kind, 'reattached', 'the newcomer watches rather than being turned away')
    assert.equal(decision.kind === 'reattached' ? decision.session.id : null, job.id)
    assert.equal(handle.killed(), false, 'and nothing was ended to hand the watch over')
    assert.equal(job.attachedPeer, newcomer, 'the watch moved')
  } finally {
    manager.dispose()
  }
})

test('an explicit attach reaches a live job under the same rule, not around it', () => {
  // This is the door that made refusing at `connect` a speed bump rather than an invariant: a
  // client turned away there arrived here with the same key and got in, because `attach` has no
  // kind check and needs none. It was already right; what was missing is that the two agree.
  const manager = new SessionManager()
  try {
    const stale = peer()
    const handle = tracedHandle()
    const job = manager.create(stale, handle, { sessionKey: 'job:attach', kind: 'job' })

    const newcomer = peer()
    const result = manager.attach(newcomer, { sessionKey: 'job:attach', cols: 80, rows: 24 })

    assert.equal(result.ok, true, 'the newcomer is admitted')
    assert.equal(handle.killed(), false, 'without touching the command')
    assert.equal(job.attachedPeer, newcomer, 'and it is the newcomer watching now')
  } finally {
    manager.dispose()
  }
})

test('a watcher disconnecting from a job detaches it, and does not end the deploy', () => {
  // The third door, and the one that stayed open behind the other two: `disconnect` used to kill
  // whatever the peer was attached to. On a job that is the deploy, ended by its watcher saying
  // goodbye -- the exact outcome the connect branch exists to prevent, reached another way.
  const manager = new SessionManager()
  try {
    const watcher = peer()
    const handle = tracedHandle()
    const job = manager.create(watcher, handle, { sessionKey: 'job:bye', kind: 'job' })

    manager.handleDisconnect(watcher)

    assert.ok(manager.get(job.id), 'the deploy is still there')
    assert.equal(handle.killed(), false, 'and still running')
    assert.equal(job.attachedPeer, null, 'nobody is watching it')
    const back = manager.attach(peer(), { sessionKey: 'job:bye', cols: 80, rows: 24 })
    assert.equal(back.ok, true, 'which is what detaching rather than killing is for')
  } finally {
    manager.dispose()
  }
})

test('a person disconnecting from their terminal still ends it — the branch is scoped to jobs', () => {
  // The control for the test above. Without it, "the job survived a disconnect" would also pass on
  // a manager that had simply stopped killing anything.
  const manager = new SessionManager()
  try {
    const owner = peer()
    const handle = tracedHandle()
    const shell = manager.create(owner, handle, { sessionKey: 'terminal-bye' })

    manager.handleDisconnect(owner)

    assert.equal(manager.get(shell.id), undefined, 'the person closed their terminal and meant it')
    assert.equal(handle.killed(), true, 'and the shell behind it is gone')
  } finally {
    manager.dispose()
  }
})

test('a job nobody is watching is attachable — that is how a deploy gets watched at all', () => {
  const manager = new SessionManager()
  try {
    const job = manager.create(null, fakeHandle(), { sessionKey: 'job:def', kind: 'job' })

    const decision = manager.prepareConnect(peer(), 'job:def', 80, 24)

    assert.equal(decision.kind, 'reattached')
    assert.equal(decision.kind === 'reattached' ? decision.session.id : null, job.id)
  } finally {
    manager.dispose()
  }
})

test('a live interactive session with the same key is still replaced, not refused', () => {
  // The guard is scoped to jobs on purpose. Refusing here instead would strand a tab behind a
  // socket the server still believes in, with no way for the client to get its shell back.
  const manager = new SessionManager()
  try {
    const stale = peer()
    const first = manager.create(stale, fakeHandle(), { sessionKey: 'terminal-one' })

    const decision = manager.prepareConnect(peer(), 'terminal-one', 80, 24)

    assert.equal(decision.kind, 'create', 'the newcomer gets to spawn')
    assert.equal(manager.get(first.id), undefined, 'and the session it replaced is gone')
  } finally {
    manager.dispose()
  }
})

// ── the bound ──

test('a job that reaches its time limit is stopped, and the watcher is told why', async (t) => {
  // Mocked clock rather than a real wait: the assertion is about what happens AT the bound, and
  // the bound is half an hour. Enabled before the job starts, because the timer is armed inside
  // startJobSession and a real one would never fire inside a test run.
  t.mock.timers.enable({ apis: ['setTimeout'] })

  const job = await startJobSession({ type: 'local' } as TerminalContext, {
    command: 'sh',
    args: ['-c', 'sleep 30'],
  })
  const session = sessionManager.get(job.sessionId)
  assert.ok(session, 'the job is registered')

  let text = ''
  session.handle.onData((chunk) => {
    text += chunk
  })

  // Registered before the tick: the command's death is a real process event, so waiting for it is
  // the only way to assert the kill happened rather than that it was requested.
  const stopped = new Promise<void>((resolve) => session.handle.onExit(() => resolve()))

  t.mock.timers.tick(MAX_JOB_LIFETIME_MS)

  assert.match(text, /reached its time limit/, 'the reason is in the stream, not only in a log')
  assert.match(text, /30 minutes/, 'and it says what the limit was')

  await stopped
  assert.equal(session.handle.isAlive(), false, 'and the command was actually stopped')
})
