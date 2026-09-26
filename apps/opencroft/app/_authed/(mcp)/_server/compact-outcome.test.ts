// group_chat_compact's wait and its answer, on a fake job: how the wait ends
// (settled, timed out, aborted) and what the task result says for each way a
// compaction can end — including the known `done` + `compacted: false` case.
import assert from 'node:assert/strict'
import test from 'node:test'

import type { ThreadCompactAck, ThreadCompactStatus } from '@/app/_authed/(group-chats)/_server/model'
import { COMPACT_WAIT_MS, type CompactWait, compactOutcome, waitForCompact } from './compact-outcome'

const THREAD = 'my-chat.my-agent.scratch'
const ACK: ThreadCompactAck = { thread: THREAD, accepted: true, coalesced: false, state: 'pending' }

function done(result: Partial<NonNullable<ThreadCompactStatus['result']>>): ThreadCompactStatus {
  return {
    thread: THREAD,
    state: 'done',
    requestedAt: 1_000,
    startedAt: 2_000,
    finishedAt: 3_000,
    result: {
      thread: THREAD,
      contextUsageBefore: { usedTokens: 180_000, contextLimit: 200_000 },
      contextUsageAfter: { usedTokens: 40_000, contextLimit: 200_000 },
      compacted: true,
      instructionsRestored: true,
      ...result,
    },
  }
}

const RUNNING: ThreadCompactStatus = { thread: THREAD, state: 'running', requestedAt: 1_000, startedAt: 2_000 }
const PENDING: ThreadCompactStatus = { thread: THREAD, state: 'pending', requestedAt: 1_000 }

/** A job the test ends by hand, with a status it can move along meanwhile. */
function fakeJob(initial: ThreadCompactStatus) {
  let current = initial
  let settle: (status: ThreadCompactStatus) => void = () => {}
  const settled = new Promise<ThreadCompactStatus>((resolve) => {
    settle = resolve
  })
  return {
    watch: { status: () => current, settled },
    move: (status: ThreadCompactStatus) => {
      current = status
    },
    end: (status: ThreadCompactStatus) => {
      current = status
      settle(status)
    },
  }
}

function outcomeOf(wait: CompactWait, ack = ACK) {
  return compactOutcome(ack, wait, { timeoutMs: COMPACT_WAIT_MS })
}

// ── the wait ─────────────────────────────────────────────────────────

test('the wait ends with the job, carrying its final status', async () => {
  const job = fakeJob(PENDING)
  const waiting = waitForCompact(job.watch, { timeoutMs: 60_000 })
  job.end(done({}))
  const wait = await waiting
  assert.equal(wait.ended, 'settled')
  assert.equal(wait.status.state, 'done')
})

test('the wait gives up at its timeout and reports the last state it saw', async () => {
  const job = fakeJob(PENDING)
  job.move(RUNNING)
  const wait = await waitForCompact(job.watch, { timeoutMs: 20 })
  assert.equal(wait.ended, 'timeout')
  assert.deepEqual(wait.status, RUNNING)
})

test('the signal stops the wait, before it starts and while it runs', async () => {
  const before = new AbortController()
  before.abort()
  assert.equal(
    (await waitForCompact(fakeJob(PENDING).watch, { timeoutMs: 60_000, signal: before.signal })).ended,
    'aborted',
  )

  const during = new AbortController()
  const waiting = waitForCompact(fakeJob(RUNNING).watch, { timeoutMs: 60_000, signal: during.signal })
  during.abort()
  const wait = await waiting
  assert.equal(wait.ended, 'aborted')
  assert.equal(wait.status.state, 'running')
})

test('the wait fits the observed 2–8 minutes with a margin, under the task’s own 60-minute limit', () => {
  assert.ok(COMPACT_WAIT_MS > 8 * 60_000)
  assert.ok(COMPACT_WAIT_MS < 60 * 60_000)
})

// ── the answer ───────────────────────────────────────────────────────

test('a compaction that shrank the context says so, with both readings and the restore', () => {
  const outcome = outcomeOf({ ended: 'settled', status: done({}) })
  assert.equal(outcome.failed, false)
  const [headline] = outcome.text.split('\n')
  assert.match(headline ?? '', /^Compacted thread "my-chat\.my-agent\.scratch"/)
  assert.match(headline ?? '', /180,000 of 200,000 tokens → 40,000 of 200,000 tokens/)
  assert.match(headline ?? '', /re-delivered and read/)
})

test('the result carries the status fields as JSON: compacted, instructionsRestored, usage, error', () => {
  const status = done({})
  const outcome = outcomeOf({ ended: 'settled', status })
  const json = JSON.parse(outcome.text.slice(outcome.text.indexOf('\n\n') + 2))
  assert.deepEqual(json, status)
})

test('done with compacted: false is stated plainly as NOT compacted, with a retry', () => {
  const status = done({
    compacted: false,
    instructionsRestored: false,
    contextUsageAfter: { usedTokens: 181_000, contextLimit: 200_000 },
  })
  const outcome = outcomeOf({ ended: 'settled', status })
  const [headline] = outcome.text.split('\n')
  assert.match(headline ?? '', /^Thread "my-chat\.my-agent\.scratch" was NOT compacted/)
  assert.match(headline ?? '', /Call group_chat_compact again to retry/)
  assert.doesNotMatch(headline ?? '', /^Compacted/)
})

test('done with compacted: null is not read as success', () => {
  const outcome = outcomeOf({ ended: 'settled', status: done({ compacted: null, contextUsageAfter: null }) })
  const [headline] = outcome.text.split('\n')
  assert.match(headline ?? '', /^Could not tell whether/)
  assert.match(headline ?? '', /→ unknown/)
  assert.match(headline ?? '', /Do not read this as success/)
})

test('a compaction whose restore did not finish says the standing context was not confirmed', () => {
  const outcome = outcomeOf({ ended: 'settled', status: done({ instructionsRestored: false }) })
  assert.match(outcome.text.split('\n')[0] ?? '', /NOT confirmed as re-delivered/)
})

test('a failed job fails the task with its error', () => {
  const status: ThreadCompactStatus = { ...RUNNING, state: 'error', finishedAt: 3_000, error: 'the harness went away' }
  const outcome = outcomeOf({ ended: 'settled', status })
  assert.equal(outcome.failed, true)
  assert.match(outcome.text, /^Compaction of thread "my-chat\.my-agent\.scratch" failed: the harness went away\./)
})

test('a timeout fails the task, claims nothing, and names the last state and the status tool', () => {
  const running = outcomeOf({ ended: 'timeout', status: RUNNING })
  assert.equal(running.failed, true)
  assert.match(running.text, /did not finish within 15 min; last known state: running since 1970-01-01T00:00:02Z/)
  assert.match(running.text, /The job was not stopped/)
  assert.match(running.text, /group_chat_compact_status/)
  assert.doesNotMatch(running.text, /^Compacted/)

  const pending = outcomeOf({ ended: 'timeout', status: PENDING })
  assert.match(pending.text, /pending — waiting for the thread's current turn to end/)
})

test('a cancelled wait says the compaction itself was not stopped', () => {
  const outcome = outcomeOf({ ended: 'aborted', status: RUNNING })
  assert.equal(outcome.failed, true)
  assert.match(outcome.text, /^Stopped waiting for the compaction/)
  assert.match(outcome.text, /The compaction itself was not stopped/)
})

test('a job that ended in the instant the wait gave up is reported as ended', () => {
  const outcome = outcomeOf({ ended: 'timeout', status: done({}) })
  assert.equal(outcome.failed, false)
  assert.match(outcome.text, /^Compacted thread/)
})

test('a call that joined a compaction already in progress says so', () => {
  const outcome = outcomeOf({ ended: 'settled', status: done({}) }, { ...ACK, coalesced: true, state: 'running' })
  assert.match(outcome.text.split('\n')[0] ?? '', /joined a compaction of the thread that was already in progress/)
})
