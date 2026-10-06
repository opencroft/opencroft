// What becomes of a job after its command ends, and of a live job nobody is watching.
//
// Time is the manager's injected clock. A sweep reads that clock once when it starts and then runs
// synchronously, so "a sweep has run since" is observed by the clock being read again — the
// tests wait on that rather than on a sleep.
import assert from 'node:assert/strict'
import test from 'node:test'

import { JOB_ENDED_REASON, SessionManager, type SessionManagerOptions, type SocketPeer } from './session-manager'
import { makeStreamHandle, type StreamHandle } from './stream-handle'

interface Sent {
  peer: SocketPeer
  type: string
  payload: Record<string, unknown>
}

function harness(opts: SessionManagerOptions = {}) {
  let time = 0
  let clockReads = 0
  const sent: Sent[] = []
  const manager = new SessionManager({
    sweepIntervalMs: 2,
    log: () => {},
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
    /** What `peer` was sent, as `type` or `type:data`. */
    sentTo(peer: SocketPeer): string[] {
      return sent
        .filter((entry) => entry.peer === peer)
        .map((entry) =>
          entry.type === 'data' ? `data:${entry.payload.data}` : `${entry.type}:${entry.payload.reason ?? ''}`,
        )
    },
    /** Resolves once a sweep has started (and, being synchronous, finished) after this call. */
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

/** A stream handle whose kill ends it, as a real transport's does once the process is gone. */
function jobHandle(): StreamHandle {
  const handle: StreamHandle = makeStreamHandle(() => handle.finish())
  return handle
}

const peer = (): SocketPeer => ({ send() {} })

test('a watcher sees the output and then the end, and is let go of', () => {
  const h = harness()
  try {
    const handle = jobHandle()
    const job = h.manager.create(null, handle, { sessionKey: 'job:end', kind: 'job' })
    const watcher = peer()
    h.manager.attach(watcher, { sessionKey: 'job:end', cols: 80, rows: 24 })

    handle.emit('built\n')
    handle.finish()

    assert.deepEqual(h.sentTo(watcher), ['data:built\r\n', `disconnected:${JOB_ENDED_REASON}`])
    assert.equal(h.manager.getSessionForPeer(watcher), undefined, 'the watcher is no longer bound')
    assert.equal(h.manager.get(job.id), job, 'the record is kept')
    assert.notEqual(job.endedAt, null)
  } finally {
    h.manager.dispose()
  }
})

test('attaching after the end replays the output and then the end, and binds nothing', () => {
  const h = harness()
  try {
    const handle = jobHandle()
    h.setTime(10)
    const job = h.manager.create(null, handle, { sessionKey: 'job:late', kind: 'job' })
    handle.emit('line one\nline two\n')
    h.setTime(20)
    handle.finish()

    h.setTime(30)
    const late = peer()
    const result = h.manager.attach(late, { sessionKey: 'job:late', cols: 80, rows: 24 })

    assert.equal(result.ok && result.ended, true)
    assert.deepEqual(h.sentTo(late), ['data:line one\r\nline two\r\n', `disconnected:${JOB_ENDED_REASON}`])
    assert.equal(h.manager.getSessionForPeer(late), undefined, 'not bound')
    assert.equal(job.detachedAt, 20, 'and the TTL still counts from the end')
  } finally {
    h.manager.dispose()
  }
})

test("a connect carrying an ended job's key is answered the same way, and nothing is spawned", () => {
  const h = harness()
  try {
    const handle = jobHandle()
    h.manager.create(null, handle, { sessionKey: 'job:connect', kind: 'job' })
    handle.emit('output\n')
    handle.finish()
    const sizeBefore = h.manager.size()

    const newcomer = peer()
    const decision = h.manager.prepareConnect(newcomer, 'job:connect', 80, 24)

    assert.equal(decision.kind, 'ended', 'the caller is told not to spawn')
    assert.deepEqual(h.sentTo(newcomer), ['data:output\r\n', `disconnected:${JOB_ENDED_REASON}`])
    assert.equal(h.manager.size(), sizeBefore, 'no session was added or replaced')
  } finally {
    h.manager.dispose()
  }
})

test('an ended job survives the dead-process sweep, and the TTL from its end reclaims it', async () => {
  const h = harness({ detachedTtlMs: 100 })
  try {
    const handle = jobHandle()
    const job = h.manager.create(null, handle, { sessionKey: 'job:ttl', kind: 'job' })
    h.setTime(1000)
    handle.finish()

    h.setTime(1050)
    await h.nextSweep()
    assert.equal(h.manager.get(job.id), job, 'kept: 50 ms after its end, though 1050 ms after its start')

    h.setTime(1101)
    await h.nextSweep()
    assert.equal(h.manager.get(job.id), undefined, 'reclaimed once the TTL from the end has passed')
  } finally {
    h.manager.dispose()
  }
})

test('ended jobs do not use up the capacity for running ones', () => {
  const h = harness({ maxJobSessions: 1 })
  try {
    const handle = jobHandle()
    const ended = h.manager.create(null, handle, { sessionKey: 'job:done', kind: 'job' })
    handle.finish()

    assert.equal(h.manager.prepareJob().ok, true)
    assert.equal(h.manager.get(ended.id), ended, 'and the record was not evicted to make room')
  } finally {
    h.manager.dispose()
  }
})

test('past the retention cap the oldest ended job is dropped', () => {
  const h = harness({ maxEndedJobSessions: 2 })
  try {
    const jobs = [1, 2, 3].map((n) => {
      const handle = jobHandle()
      const job = h.manager.create(null, handle, { sessionKey: `job:${n}`, kind: 'job' })
      h.setTime(n)
      handle.finish()
      return job
    })

    assert.equal(h.manager.get(jobs[0].id), undefined, 'the oldest is gone')
    assert.equal(h.manager.get(jobs[1].id), jobs[1])
    assert.equal(h.manager.get(jobs[2].id), jobs[2])
  } finally {
    h.manager.dispose()
  }
})

test('a job whose command ended before it was registered is recorded as ended', () => {
  const h = harness()
  try {
    const handle = jobHandle()
    handle.emit('fast\n')
    handle.finish()

    const job = h.manager.create(null, handle, { sessionKey: 'job:fast', kind: 'job' })

    assert.notEqual(job.endedAt, null)
    const late = peer()
    h.manager.attach(late, { sessionKey: 'job:fast', cols: 80, rows: 24 })
    assert.deepEqual(h.sentTo(late), ['data:fast\r\n', `disconnected:${JOB_ENDED_REASON}`])
  } finally {
    h.manager.dispose()
  }
})

test('an interactive session whose process exits is still removed at once', () => {
  // The control for the tests above: keeping the record is scoped to jobs.
  const h = harness()
  try {
    const handle = jobHandle()
    const owner = peer()
    const shell = h.manager.create(owner, handle, { sessionKey: 'terminal' })

    handle.finish()

    assert.equal(h.manager.get(shell.id), undefined)
  } finally {
    h.manager.dispose()
  }
})

// ── a live job nobody is watching ──

test('a job unwatched for longer than its bound is stopped, and its output kept', async () => {
  const h = harness()
  try {
    const handle = jobHandle()
    const job = h.manager.create(null, handle, { sessionKey: 'job:logs', kind: 'job', stopWhenUnwatchedMs: 100 })
    handle.emit('last lines\n')

    h.setTime(50)
    await h.nextSweep()
    assert.equal(handle.isAlive(), true, 'still inside its bound')

    h.setTime(101)
    await h.nextSweep()
    assert.equal(handle.isAlive(), false, 'stopped')
    assert.equal(h.manager.get(job.id), job, 'and kept as an ended job')
    assert.equal(job.scrollback.toString(), 'last lines\r\n')
  } finally {
    h.manager.dispose()
  }
})

test('a watched job is not stopped for being unwatched', async () => {
  const h = harness()
  try {
    const handle = jobHandle()
    h.manager.create(null, handle, { sessionKey: 'job:watched', kind: 'job', stopWhenUnwatchedMs: 100 })
    h.manager.attach(peer(), { sessionKey: 'job:watched', cols: 80, rows: 24 })

    h.setTime(10_000)
    await h.nextSweep()

    assert.equal(handle.isAlive(), true)
  } finally {
    h.manager.dispose()
  }
})

test('the bound starts again when the last watcher leaves', async () => {
  const h = harness()
  try {
    const handle = jobHandle()
    h.manager.create(null, handle, { sessionKey: 'job:left', kind: 'job', stopWhenUnwatchedMs: 100 })
    const watcher = peer()
    h.manager.attach(watcher, { sessionKey: 'job:left', cols: 80, rows: 24 })
    h.setTime(500)
    h.manager.handleSocketClose(watcher)

    h.setTime(550)
    await h.nextSweep()
    assert.equal(handle.isAlive(), true, 'counted from the watcher leaving, not from the start')

    h.setTime(601)
    await h.nextSweep()
    assert.equal(handle.isAlive(), false)
  } finally {
    h.manager.dispose()
  }
})

test('without the option an unwatched job runs on', async () => {
  // A deploy is the job this default is for: its work matters whether or not anyone watches.
  const h = harness()
  try {
    const handle = jobHandle()
    h.manager.create(null, handle, { sessionKey: 'job:deploy', kind: 'job' })

    h.setTime(10_000_000)
    await h.nextSweep()

    assert.equal(handle.isAlive(), true)
  } finally {
    h.manager.dispose()
  }
})

// ── a view its owner lets go of ──

/** Open a view the way a tab does: the server starts it, the tab's terminal attaches to it. */
function openView(h: ReturnType<typeof harness>, key: string): { handle: StreamHandle; watcher: SocketPeer } {
  const slot = h.manager.prepareJob()
  assert.equal(slot.ok, true, slot.ok ? '' : slot.message)
  const handle = jobHandle()
  h.manager.create(null, handle, { sessionKey: key, kind: 'job', stopWhenUnwatchedMs: 60_000 })
  const watcher = peer()
  h.manager.attach(watcher, { sessionKey: key, cols: 80, rows: 24 })
  return { handle, watcher }
}

test('stopping a view ends its command at once and frees its slot', () => {
  const h = harness({ maxJobSessions: 1 })
  try {
    const { handle, watcher } = openView(h, 'job:view')
    h.manager.handleSocketClose(watcher)

    assert.equal(h.manager.stopViewJob('job:view'), 'stopped')

    assert.equal(handle.isAlive(), false)
    assert.equal(h.manager.size(), 0, 'nothing is kept: nobody is left to read it')
    assert.equal(h.manager.prepareJob().ok, true, 'the slot is free without waiting for the bound')
  } finally {
    h.manager.dispose()
  }
})

test('a tab switched away and back more than ten times never reaches the job cap', () => {
  const h = harness()
  try {
    for (let visit = 0; visit < 25; visit++) {
      const { watcher } = openView(h, `job:visit-${visit}`)
      // Leaving the tab: its terminal unmounts, then the tab lets go of its view.
      h.manager.handleSocketClose(watcher)
      h.manager.stopViewJob(`job:visit-${visit}`)
    }
    assert.equal(h.manager.size(), 0)
  } finally {
    h.manager.dispose()
  }
})

test('without letting go, the same switching fills the cap: the failure the test above guards', () => {
  const h = harness()
  try {
    for (let visit = 0; visit < 10; visit++) {
      const { watcher } = openView(h, `job:visit-${visit}`)
      h.manager.handleSocketClose(watcher)
    }
    const refused = h.manager.prepareJob()
    assert.equal(refused.ok, false)
    assert.match(refused.ok ? '' : refused.message, /Session limit reached \(10 active\)/)
  } finally {
    h.manager.dispose()
  }
})

test('a view that already ended or was reclaimed is gone, not an error', () => {
  const h = harness()
  try {
    const { handle } = openView(h, 'job:ended')
    handle.finish()

    assert.equal(h.manager.stopViewJob('job:ended'), 'stopped', 'the ended record is dropped too')
    assert.equal(h.manager.stopViewJob('job:ended'), 'gone')
    assert.equal(h.manager.stopViewJob('job:never'), 'gone')
  } finally {
    h.manager.dispose()
  }
})

test('a job started without the option is refused and runs on', () => {
  // A deploy: a viewer leaving is not a decision about it.
  const h = harness()
  try {
    const handle = jobHandle()
    const job = h.manager.create(null, handle, { sessionKey: 'job:deploy', kind: 'job' })

    assert.equal(h.manager.stopViewJob('job:deploy'), 'refused')

    assert.equal(handle.isAlive(), true)
    assert.equal(h.manager.get(job.id), job)
  } finally {
    h.manager.dispose()
  }
})

test('an interactive session is refused', () => {
  const h = harness()
  try {
    const handle = jobHandle()
    const shell = h.manager.create(peer(), handle, { sessionKey: 'terminal' })

    assert.equal(h.manager.stopViewJob('terminal'), 'refused')

    assert.equal(handle.isAlive(), true)
    assert.equal(h.manager.get(shell.id), shell)
  } finally {
    h.manager.dispose()
  }
})
