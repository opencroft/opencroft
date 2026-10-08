// A shared session: one shell under a key for every viewer, which nobody leaving ends.
//
// Time is the manager's injected clock; "a sweep has run since" is observed by the clock being
// read again, as in ended-jobs.test.ts.
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  type SessionHandle,
  SessionManager,
  type SessionManagerOptions,
  SHARED_RESTARTED_REASON,
  type SocketPeer,
} from './session-manager'

function harness(opts: SessionManagerOptions = {}) {
  let time = 0
  let clockReads = 0
  const sent: Array<{ peer: SocketPeer; type: string; payload: Record<string, unknown> }> = []
  const logs: string[] = []
  const manager = new SessionManager({
    sweepIntervalMs: 2,
    log: (line) => logs.push(line),
    ...opts,
    now: () => {
      clockReads++
      return time
    },
    sendToPeer: (peer, message) => sent.push({ peer, ...message }),
  })
  return {
    manager,
    setTime(value: number) {
      time = value
    },
    /** What `peer` was sent, as `data:<text>` or `<type>:<reason>`. */
    sentTo(peer: SocketPeer): string[] {
      return sent
        .filter((entry) => entry.peer === peer)
        .map((entry) =>
          entry.type === 'data' ? `data:${entry.payload.data}` : `${entry.type}:${entry.payload.reason ?? ''}`,
        )
    },
    /** The `kill` log lines for `key`, as `<reason>` or `<reason> (<context>)`. */
    killsOf(key: string): string[] {
      const prefix = new RegExp(`^kill id=\\S+ key=${key} reason=`)
      return logs.filter((line) => prefix.test(line)).map((line) => line.replace(prefix, ''))
    },
    payloadsTo(peer: SocketPeer, type: string): Record<string, unknown>[] {
      return sent.filter((entry) => entry.peer === peer && entry.type === type).map((entry) => entry.payload)
    },
    async nextSweep(): Promise<void> {
      const start = clockReads
      const deadline = Date.now() + 5000
      while (clockReads === start) {
        if (Date.now() > deadline) {
          throw new Error('no sweep ran within 5 s')
        }
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
    },
  }
}

/** A shell that records what is typed into it and whether it was ended, and emits on demand. */
function shellHandle() {
  const dataListeners: Array<(data: string) => void> = []
  const typed: string[] = []
  let killed = false
  const handle: SessionHandle = {
    onData: (fn) => dataListeners.push(fn),
    onExit() {},
    write: (data) => typed.push(data),
    resize() {},
    kill() {
      killed = true
    },
    isAlive: () => !killed,
  }
  return {
    handle,
    typed,
    killed: () => killed,
    emit: (data: string) => {
      for (const fn of dataListeners) {
        fn(data)
      }
    },
  }
}

const peer = (): SocketPeer => ({ send() {} })

test('a second viewer of a shared key joins the shell, and both see it and type into it', () => {
  const h = harness()
  try {
    const shell = shellHandle()
    const alice = peer()
    const session = h.manager.create(alice, shell.handle, { sessionKey: 'node-1', shared: true })
    shell.emit('before\n')

    const bob = peer()
    const decision = h.manager.prepareConnect(bob, 'node-1', 80, 24)
    shell.emit('after\n')
    h.manager.write(alice, 'a')
    h.manager.write(bob, 'b')

    assert.equal(decision.kind, 'reattached')
    assert.equal(decision.kind === 'reattached' ? decision.session.id : null, session.id)
    assert.equal(shell.killed(), false, 'nobody was replaced')
    assert.deepEqual(h.sentTo(alice), ['data:before\n', 'data:after\n'])
    assert.deepEqual(
      h.sentTo(bob),
      ['data:before\n', 'data:after\n'],
      'the newcomer gets the scrollback, then live output',
    )
    assert.deepEqual(shell.typed, ['a', 'b'])
  } finally {
    h.manager.dispose()
  }
})

test('a second viewer of an unshared key still takes the shell over: the control for the test above', () => {
  const h = harness()
  try {
    const shell = shellHandle()
    const alice = peer()
    h.manager.create(alice, shell.handle, { sessionKey: 'tab-key' })

    const decision = h.manager.prepareConnect(peer(), 'tab-key', 80, 24)

    assert.equal(decision.kind, 'create')
    assert.equal(shell.killed(), true)
  } finally {
    h.manager.dispose()
  }
})

test('two viewers opening a shared key at once end up in one shell', () => {
  // Both were told to create before either had registered: the spawn between the decision and the
  // registration is asynchronous.
  const h = harness()
  try {
    const first = shellHandle()
    const second = shellHandle()
    const alice = peer()
    const bob = peer()
    assert.equal(h.manager.prepareConnect(alice, 'node-1', 80, 24).kind, 'create')
    assert.equal(h.manager.prepareConnect(bob, 'node-1', 80, 24).kind, 'create')

    const a = h.manager.create(alice, first.handle, { sessionKey: 'node-1', shared: true })
    const b = h.manager.create(bob, second.handle, { sessionKey: 'node-1', shared: true })

    assert.equal(b.id, a.id, 'the later one joined the earlier')
    assert.equal(second.killed(), true, 'and its own spawn was let go')
    assert.equal(first.killed(), false)
    assert.deepEqual([...a.viewers], [alice, bob])
  } finally {
    h.manager.dispose()
  }
})

test('viewers leaving never end a shared shell, and neither does the idle timeout', async () => {
  const h = harness({ detachedTtlMs: 100 })
  try {
    const shell = shellHandle()
    const alice = peer()
    const bob = peer()
    const session = h.manager.create(alice, shell.handle, { sessionKey: 'node-1', shared: true })
    h.manager.prepareConnect(bob, 'node-1', 80, 24)

    h.manager.handleSocketClose(alice)
    shell.emit('still here\n')
    assert.deepEqual(h.sentTo(bob), ['data:still here\n'], 'the one left keeps watching')
    assert.equal(session.detachedAt, null)

    h.manager.handleSocketClose(bob)
    assert.equal(session.detachedAt, 0, 'detached once the last viewer is gone')
    h.setTime(1000)
    await h.nextSweep()

    assert.equal(h.manager.get(session.id), session, 'kept long past the idle timeout')
    assert.equal(shell.killed(), false)
  } finally {
    h.manager.dispose()
  }
})

test('a shared shell nobody watches is never evicted to make room for another', () => {
  const h = harness({ maxSharedSessions: 1 })
  try {
    const viewer = peer()
    const shell = shellHandle()
    h.manager.create(viewer, shell.handle, { sessionKey: 'node-1', shared: true })
    h.manager.handleSocketClose(viewer)

    const decision = h.manager.prepareConnect(peer(), 'node-2', 80, 24, true)

    assert.equal(decision.kind, 'refused')
    assert.match(decision.kind === 'refused' ? decision.message : '', /^Shared session limit reached \(1 open\)/)
    assert.equal(shell.killed(), false)
  } finally {
    h.manager.dispose()
  }
})

test('a full shared pool still admits a shell per tab', () => {
  const h = harness({ maxSessions: 1, maxSharedSessions: 1 })
  try {
    h.manager.create(peer(), shellHandle().handle, { sessionKey: 'node-1', shared: true })

    assert.equal(h.manager.prepareConnect(peer(), 'node-2', 80, 24, true).kind, 'refused', 'the shared pool is full')
    assert.equal(h.manager.prepareConnect(peer(), 'tab-key', 80, 24).kind, 'create')
  } finally {
    h.manager.dispose()
  }
})

test('a full pool of shells per tab still admits a shared shell', () => {
  const h = harness({ maxSessions: 1, maxSharedSessions: 1 })
  try {
    h.manager.create(peer(), shellHandle().handle, { sessionKey: 'tab-key' })

    assert.equal(h.manager.prepareConnect(peer(), 'other-tab-key', 80, 24).kind, 'refused', 'the per-tab pool is full')
    assert.equal(h.manager.prepareConnect(peer(), 'node-1', 80, 24, true).kind, 'create')
  } finally {
    h.manager.dispose()
  }
})

test('ending a shared shell by its key ends it and tells every viewer why', () => {
  const h = harness()
  try {
    const shell = shellHandle()
    const alice = peer()
    const bob = peer()
    const session = h.manager.create(alice, shell.handle, { sessionKey: 'node-1', shared: true })
    h.manager.prepareConnect(bob, 'node-1', 80, 24)

    assert.equal(h.manager.endShared('node-1', 'Terminal closed'), true)

    assert.equal(h.manager.get(session.id), undefined)
    assert.equal(shell.killed(), true)
    assert.deepEqual(h.sentTo(alice), ['disconnected:Terminal closed'])
    assert.deepEqual(h.sentTo(bob), ['disconnected:Terminal closed'])
  } finally {
    h.manager.dispose()
  }
})

test('ending by key leaves an unshared shell under that key alone', () => {
  const h = harness()
  try {
    const shell = shellHandle()
    const session = h.manager.create(peer(), shell.handle, { sessionKey: 'node-1' })

    assert.equal(h.manager.endShared('node-1', 'Terminal closed'), false)
    assert.equal(h.manager.endShared('no-such-key', 'Terminal closed'), false)

    assert.equal(h.manager.get(session.id), session)
    assert.equal(shell.killed(), false)
  } finally {
    h.manager.dispose()
  }
})

test('a viewer leaving a shared shell with disconnect only stops watching it', () => {
  const h = harness()
  try {
    const shell = shellHandle()
    const alice = peer()
    const bob = peer()
    const session = h.manager.create(alice, shell.handle, { sessionKey: 'node-1', shared: true })
    h.manager.prepareConnect(bob, 'node-1', 80, 24)

    h.manager.handleDisconnect(alice)

    assert.equal(shell.killed(), false)
    assert.deepEqual([...session.viewers], [bob])
    assert.deepEqual(h.sentTo(bob), [])
  } finally {
    h.manager.dispose()
  }
})

/** Two viewers of `node-1`'s shared shell, and a way to open a replacement after a restart. */
function twoViewers(h: ReturnType<typeof harness>) {
  const first = shellHandle()
  const alice = peer()
  const bob = peer()
  const session = h.manager.create(alice, first.handle, { sessionKey: 'node-1', shared: true })
  h.manager.prepareConnect(bob, 'node-1', 80, 24, true)
  /** Every viewer rejoins, as the client does on `rejoin`: the first opens a shell, the rest join it. */
  const rejoin = () => {
    const next = shellHandle()
    assert.equal(h.manager.prepareConnect(alice, 'node-1', 80, 24, true).kind, 'create')
    h.manager.create(alice, next.handle, { sessionKey: 'node-1', shared: true })
    assert.equal(h.manager.prepareConnect(bob, 'node-1', 80, 24, true).kind, 'reattached')
    return next
  }
  return { first, alice, bob, session, rejoin }
}

test('a restart ends the shared shell and tells every viewer, the sender too, to join its replacement', () => {
  const h = harness()
  try {
    const { first, alice, bob, session } = twoViewers(h)

    assert.equal(h.manager.restartShared(alice, 'press-1'), 'restarted')

    assert.equal(h.manager.get(session.id), undefined)
    assert.equal(first.killed(), true)
    for (const viewer of [alice, bob]) {
      assert.deepEqual(h.payloadsTo(viewer, 'disconnected'), [{ reason: SHARED_RESTARTED_REASON, rejoin: true }])
    }
    assert.deepEqual(h.killsOf('node-1'), ['explicit (restart)'])
  } finally {
    h.manager.dispose()
  }
})

test('one press delivered by every viewer restarts the shared shell once', () => {
  const h = harness()
  try {
    const { alice, bob, rejoin } = twoViewers(h)

    h.manager.restartShared(alice, 'press-1')
    const replacement = rejoin()
    const late = h.manager.restartShared(bob, 'press-1')

    assert.equal(late, 'already-applied')
    assert.equal(replacement.killed(), false, 'the replacement survives the second delivery')
    assert.deepEqual(h.killsOf('node-1'), ['explicit (restart)'])
  } finally {
    h.manager.dispose()
  }
})

test('a press delivered long after its restart leaves the live shell alone', () => {
  // A tab that slept through the press: its socket joined the replacement, then its copy of the
  // press arrived. Two later presses have been applied in between.
  const h = harness()
  try {
    const { alice, bob, rejoin } = twoViewers(h)
    h.manager.restartShared(alice, 'press-1')
    rejoin()
    h.manager.restartShared(alice, 'press-2')
    rejoin()
    h.manager.restartShared(alice, 'press-3')
    const live = rejoin()

    assert.equal(h.manager.restartShared(bob, 'press-1'), 'already-applied')
    assert.equal(h.manager.restartShared(bob, 'press-2'), 'already-applied')

    assert.equal(live.killed(), false)
    assert.equal(h.killsOf('node-1').length, 3, 'one kill per press')
  } finally {
    h.manager.dispose()
  }
})

test('a restart from a socket not watching a shared shell does nothing', () => {
  const h = harness()
  try {
    const shell = shellHandle()
    const owner = peer()
    h.manager.create(owner, shell.handle, { sessionKey: 'tab-key' })

    assert.equal(h.manager.restartShared(owner, 'press-1'), 'ignored', 'an unshared shell')
    assert.equal(h.manager.restartShared(peer(), 'press-1'), 'ignored', 'no shell at all')
    assert.equal(shell.killed(), false)
  } finally {
    h.manager.dispose()
  }
})

test('ending a shared key forgets its presses, so a new shell under the key can be restarted', () => {
  const h = harness()
  try {
    const { alice } = twoViewers(h)
    h.manager.restartShared(alice, 'press-1')
    h.manager.endShared('node-1', 'Terminal closed')

    const shell = shellHandle()
    const viewer = peer()
    h.manager.create(viewer, shell.handle, { sessionKey: 'node-1', shared: true })

    assert.equal(h.manager.restartShared(viewer, 'press-1'), 'restarted')
    assert.equal(shell.killed(), true)
  } finally {
    h.manager.dispose()
  }
})
