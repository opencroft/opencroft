// What a reader is told when a send does not arrive, and how many times.
//
// The collapse state is per-process and has no reset, deliberately — nothing
// in production ever wants to forget an open window. So each test uses its own
// node id, which is what keys a window, and the tests are independent for the
// same reason two different wirings are.

import assert from 'node:assert/strict'
import test from 'node:test'

import { reportSendFailure, type SendFailure } from './send-failure-report'

const WINDOW_MS = 5 * 60_000

const REASON = 'This message has no sender: nothing fed the node that sent it.'

// A failure that is not a refusal. The whole point of this widening is that
// this one reaches a reader too, and it comes from a different layer entirely.
const UNREACHABLE = 'Thread not available from this node: a-chat:an-agent:a-thread'

function failureOn(nodeId: string, reason = REASON): SendFailure {
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

test('the first failure is reported in full, to the thread the message was aimed at', async () => {
  const { reports, deliver } = recorder()

  await reportSendFailure(failureOn('node-first'), deliver)

  assert.equal(reports.length, 1)
  assert.equal(reports[0]?.thread, 'a-chat:an-agent:a-thread')
  assert.match(reports[0]?.message ?? '', /was not delivered/)
  assert.ok(reports[0]?.message.includes(REASON), 'the reader is told why, in the words the failure used')
  assert.ok(reports[0]?.message.includes('node-first'), 'and which wiring to go and fix')
})

test('a failure that is not a refusal is reported the same way', async () => {
  // The widening itself. Before this, only the unattributable-sender refusal
  // reached a reader and everything else went to a log nobody reads — so a
  // thread that had become unreachable produced silence indistinguishable from
  // nobody having written.
  const { reports, deliver } = recorder()

  await reportSendFailure(failureOn('node-unreachable', UNREACHABLE), deliver)

  assert.equal(reports.length, 1)
  assert.ok(reports[0]?.message.includes(UNREACHABLE))
})

test('the report says the message is gone rather than late, and that its text is withheld', async () => {
  // Both halves matter to a reader deciding what to do: nothing retried it, so
  // waiting is not a strategy; and the absence of the text is a choice rather
  // than something that failed to load.
  const { reports, deliver } = recorder()

  await reportSendFailure(failureOn('node-withheld'), deliver)

  assert.match(reports[0]?.message ?? '', /gone rather than late/)
  assert.match(reports[0]?.message ?? '', /deliberately not repeated here/)
})

test('repeats inside the window are not reported as they happen', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportSendFailure(failureOn('node-repeats'), deliver)
  await reportSendFailure(failureOn('node-repeats'), deliver)
  await reportSendFailure(failureOn('node-repeats'), deliver)

  assert.equal(reports.length, 1, 'one report so far, not three')
})

test('the window closes by reporting the count, so no occurrence is dropped', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportSendFailure(failureOn('node-counted'), deliver)
  await reportSendFailure(failureOn('node-counted'), deliver)
  await reportSendFailure(failureOn('node-counted'), deliver)

  t.mock.timers.tick(WINDOW_MS)
  await settle()

  assert.equal(reports.length, 2)
  assert.match(reports[1]?.message ?? '', /^2 further messages aimed at this thread were not delivered/)
  assert.ok(reports[1]?.message.includes(REASON), 'the digest still says why')
})

test('a single repeat is counted in the singular', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportSendFailure(failureOn('node-one-repeat'), deliver)
  await reportSendFailure(failureOn('node-one-repeat'), deliver)

  t.mock.timers.tick(WINDOW_MS)
  await settle()

  assert.match(reports[1]?.message ?? '', /^1 further message aimed at this thread was not delivered/)
})

test('a window that saw nothing else closes without saying anything', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportSendFailure(failureOn('node-quiet'), deliver)

  t.mock.timers.tick(WINDOW_MS)
  await settle()

  assert.equal(reports.length, 1, 'the first report, and no digest of nothing')
})

test('two reasons on one wiring are two reports, not one hidden behind the other', async (t) => {
  // Sharper now that every failure is reported: a wiring can be refusing some
  // sends and failing to reach its thread with others, and those are two
  // different things to go and fix.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportSendFailure(failureOn('node-two-reasons'), deliver)
  await reportSendFailure(failureOn('node-two-reasons', UNREACHABLE), deliver)

  assert.equal(reports.length, 2)
  assert.ok(reports[0]?.message.includes(REASON))
  assert.ok(reports[1]?.message.includes(UNREACHABLE))
})

test('once a window has closed, the condition returning is reported in full again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { reports, deliver } = recorder()

  await reportSendFailure(failureOn('node-returns'), deliver)
  t.mock.timers.tick(WINDOW_MS)
  await settle()

  await reportSendFailure(failureOn('node-returns'), deliver)

  assert.equal(reports.length, 2)
  assert.match(reports[1]?.message ?? '', /^A message aimed at this thread was not delivered/)
})

test('the digest travels through the most recent caller, not a closure five minutes old', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const first = recorder()
  const second = recorder()

  await reportSendFailure(failureOn('node-latest'), first.deliver)
  await reportSendFailure(failureOn('node-latest'), second.deliver)

  t.mock.timers.tick(WINDOW_MS)
  await settle()

  assert.equal(first.reports.length, 1, 'only the opening report went the old way')
  assert.equal(second.reports.length, 1, 'the digest went the new way')
})
