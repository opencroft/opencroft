// The output filter sits inside the stream handle, ahead of the line-ending conversion, the
// buffer for output that arrives before anyone subscribes, and the end of the stream. Each test
// pins one of those placements, and the last ones pin that a filter which throws lets nothing
// through.
import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_JOB_LIFETIME_MS, startJobSession } from './job-session'
import { sessionManager } from './manager'
import { FILTER_FAILED_NOTICE, makeStreamHandle, type OutputFilter } from './stream-handle'

/** Holds everything back until a line ends, and uppercases what it releases — visibly filtered. */
function lineFilter(): OutputFilter & { pushed: string[] } {
  let held = ''
  const pushed: string[] = []
  return {
    pushed,
    push(text) {
      pushed.push(text)
      held += text
      const cut = held.lastIndexOf('\n') + 1
      const out = held.slice(0, cut)
      held = held.slice(cut)
      return out.toUpperCase()
    },
    flush() {
      const out = held
      held = ''
      return out.toUpperCase()
    },
  }
}

function watch(handle: ReturnType<typeof makeStreamHandle>): { events: string[] } {
  const events: string[] = []
  handle.onData((data) => events.push(`data:${data}`))
  handle.onExit(() => events.push('exit'))
  return { events }
}

test('the filter sees raw output, before lines are ended for a terminal', () => {
  const filter = lineFilter()
  const handle = makeStreamHandle(() => {}, filter)
  const { events } = watch(handle)

  handle.emit('one\ntw')
  handle.emit('o\n')

  assert.deepEqual(filter.pushed, ['one\ntw', 'o\n'], 'the filter got bare \\n, as the transport sent it')
  assert.deepEqual(events, ['data:ONE\r\n', 'data:TWO\r\n'])
})

test('output that arrives before anyone subscribes is kept already filtered', () => {
  const handle = makeStreamHandle(() => {}, lineFilter())
  handle.emit('early\n')

  const { events } = watch(handle)

  assert.deepEqual(events, ['data:EARLY\r\n'])
})

test('what the filter still holds is flushed when the stream ends, before the end is reported', () => {
  const handle = makeStreamHandle(() => {}, lineFilter())
  const { events } = watch(handle)

  handle.emit('no line end')
  handle.finish()
  handle.finish()

  assert.deepEqual(events, ['data:NO LINE END', 'exit'])
})

test('a filter that throws on push stops the job and shows none of the raw text', () => {
  let killed = false
  const handle = makeStreamHandle(
    () => {
      killed = true
    },
    {
      push() {
        throw new Error('cannot read values')
      },
      flush: () => '',
    },
  )
  const { events } = watch(handle)

  handle.emit('secret-value\n')
  handle.emit('more\n')

  assert.equal(killed, true, 'the command was stopped')
  assert.deepEqual(events, [`data:${FILTER_FAILED_NOTICE.replace(/\n/g, '\r\n')}`, 'exit'])
  assert.equal(handle.isAlive(), false)
})

test('a filter that throws on flush shows none of what it held, and the end is reported once', () => {
  const handle = makeStreamHandle(() => {}, {
    push: () => '',
    flush() {
      throw new Error('cannot read values')
    },
  })
  const { events } = watch(handle)

  handle.emit('held-secret')
  handle.finish()

  assert.deepEqual(events, [`data:${FILTER_FAILED_NOTICE.replace(/\n/g, '\r\n')}`, 'exit'])
})

test('a local job runs its output through the filter it was started with', async () => {
  const job = await startJobSession(
    { type: 'local' },
    { command: 'sh', args: ['-c', 'echo token=example-value'], filter: lineFilter() },
  )
  const session = sessionManager.get(job.sessionId)
  assert.ok(session)
  await new Promise<void>((resolve) => session.handle.onExit(() => resolve()))

  const replay = session.scrollback.toString()
  assert.equal(replay, 'TOKEN=EXAMPLE-VALUE\r\n', 'only the filtered text was kept')
})

test('the time-limit notice goes through the filter, after anything it was holding', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const filter = lineFilter()
  const job = await startJobSession(
    { type: 'local' },
    { command: 'sh', args: ['-c', 'printf partial; exec sleep 30'], filter },
  )
  const session = sessionManager.get(job.sessionId)
  assert.ok(session)
  const stopped = new Promise<void>((resolve) => session.handle.onExit(() => resolve()))

  // setImmediate is not mocked, so this waits for the real process without a timer.
  while (!filter.pushed.includes('partial')) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  t.mock.timers.tick(MAX_JOB_LIFETIME_MS)
  await stopped

  assert.match(session.scrollback.toString(), /^PARTIAL\r\nSTOPPED AFTER 30 MINUTES/)
})
