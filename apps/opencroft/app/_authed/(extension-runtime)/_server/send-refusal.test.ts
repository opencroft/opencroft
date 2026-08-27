// What a reader is told when a send is refused, and how many times.
//
// The collapse state is per-process and has no reset, deliberately — nothing
// in production ever wants to forget an open window. So each test uses its own
// node id, which is what keys a window, and the tests are independent for the
// same reason two different wirings are.

import assert from 'node:assert/strict'
import test from 'node:test'

import { type Refusal, reportRefusal } from './send-refusal'

const WINDOW_MS = 5 * 60_000

const REASON = 'This message has no sender: nothing fed the node that sent it.'

function refusalOn(nodeId: string, reason = REASON): Refusal {
  return { nodeId, reason, threadRef: 'a-chat:an-agent:a-thread' }
}

/** Every report handed over, in the order it was delivered. */
function recorder() {
  const reports: Array<{ thread: string; message: string }> = []
  return {
    reports,
    deliver: async (thread: string, message: string) => {
      reports.push({ thread, message })
    },
  }
}

// Lets the digest's un-awaited delivery settle. `tick` runs the timer callback
// synchronously, but the report inside it is a promise nobody holds.
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('the first refusal is reported in full, to the thread the message was aimed at', async () => {
  const { reports, deliver } = recorder()

  await reportRefusal(refusalOn('node-first'), deliver)

  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.thread, 'a-chat:an-agent:a-thread')
  assert.match(reports[0]?.message ?? '', /nothing was delivered/)
  assert.ok(reports[0]?.message.includes(REASON), 'the reader is told why, in the words the guard used')
  assert.ok(reports[0]?.message.includes('node-first'), 'and which wiring to go and fix')
})

test('the report says the refused text is withheld, rather than leaving its absence unexplained', async () => {
  const { reports, deliver } = recorder()

  await reportRefusal(refusalOn('node-withheld'), deliver)

  assert.match(reports[0]?.message ?? '', /deliberately not repeated here/)
})

test('repeats inside the window are not reported as they happen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportRefusal(refusalOn('node-repeats'), deliver)
  await reportRefusal(refusalOn('node-repeats'), deliver)
  await reportRefusal(refusalOn('node-repeats'), deliver)

  assert.equal(reports.length, 1, 'one report so far, not three')
})

test('the window closes by reporting the count, so no occurrence is dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportRefusal(refusalOn('node-counted'), deliver)
  await reportRefusal(refusalOn('node-counted'), deliver)
  await reportRefusal(refusalOn('node-counted'), deliver)

  t.mock.timers.tick(WINDOW_MS)
  await settle()

  assert.equal(reports.length, 2)
  assert.match(reports[1]?.message ?? '', /^2 further messages were aimed at this thread refused/)
  assert.ok(reports[1]?.message.includes(REASON), 'the digest still says why')
})

test('a single repeat is counted in the singular', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportRefusal(refusalOn('node-one-repeat'), deliver)
  await reportRefusal(refusalOn('node-one-repeat'), deliver)

  t.mock.timers.tick(WINDOW_MS)
  await settle()

  assert.match(reports[1]?.message ?? '', /^1 further message was aimed at this thread refused/)
})

test('a window that saw nothing else closes without saying anything', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportRefusal(refusalOn('node-quiet'), deliver)

  t.mock.timers.tick(WINDOW_MS)
  await settle()

  assert.equal(reports.length, 1, 'the first report, and no digest of nothing')
})

test('two reasons on one wiring are two reports, not one hidden behind the other', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()
  const other = 'This message has no sender: agent node-two-reasons has no username.'

  await reportRefusal(refusalOn('node-two-reasons'), deliver)
  await reportRefusal(refusalOn('node-two-reasons', other), deliver)

  assert.equal(reports.length, 2)
  assert.ok(reports[0]?.message.includes(REASON))
  assert.ok(reports[1]?.message.includes(other))
})

test('once a window has closed, the condition returning is reported in full again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportRefusal(refusalOn('node-returns'), deliver)
  t.mock.timers.tick(WINDOW_MS)
  await settle()

  await reportRefusal(refusalOn('node-returns'), deliver)

  assert.equal(reports.length, 2)
  assert.match(reports[1]?.message ?? '', /^A message aimed at this thread was refused/)
})

test('the digest travels through the most recent caller, not a closure five minutes old', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = recorder()
  const second = recorder()

  await reportRefusal(refusalOn('node-latest'), first.deliver)
  await reportRefusal(refusalOn('node-latest'), second.deliver)

  t.mock.timers.tick(WINDOW_MS)
  await settle()

  assert.equal(first.reports.length, 1, 'only the opening report went the old way')
  assert.equal(second.reports.length, 1, 'the digest went the new way')
})
