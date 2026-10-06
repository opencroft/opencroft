// What an extension's `groupChats.compact` answers for each way a compaction's
// wait can end. The wait itself is tested in ../../(mcp)/_server/compact-outcome.test.ts.
import assert from 'node:assert/strict'
import test from 'node:test'

import { compactResultOf } from './compact-wait'
import type { ThreadCompactStatus } from './model'

const THREAD = 'my-chat.my-agent.scratch'

function done(result: Partial<NonNullable<ThreadCompactStatus['result']>>): ThreadCompactStatus {
  return {
    thread: THREAD,
    state: 'done',
    requestedAt: 1_000,
    startedAt: 2_000,
    finishedAt: 3_000,
    result: {
      thread: THREAD,
      contextUsageBefore: { usedTokens: 300_000, contextLimit: 1_000_000 },
      contextUsageAfter: { usedTokens: 40_000, contextLimit: 1_000_000 },
      compacted: true,
      instructionsRestored: true,
      ...result,
    },
  }
}

test('a compaction that shrank the context is compacted, with both readings', () => {
  assert.deepEqual(compactResultOf(done({})), { outcome: 'compacted', contextBefore: 300_000, contextAfter: 40_000 })
})

test('a finished job whose context did not shrink is not_compacted', () => {
  const status = done({ compacted: false, contextUsageAfter: { usedTokens: 301_000, contextLimit: 1_000_000 } })
  assert.deepEqual(compactResultOf(status), { outcome: 'not_compacted', contextBefore: 300_000, contextAfter: 301_000 })
})

test('a finished job with no reading after it is unknown, never compacted', () => {
  const status = done({ compacted: null, contextUsageAfter: null })
  assert.deepEqual(compactResultOf(status), { outcome: 'unknown', contextBefore: 300_000, contextAfter: null })
})

test('a failed job is failed, with its error', () => {
  const status: ThreadCompactStatus = {
    thread: THREAD,
    state: 'error',
    requestedAt: 1_000,
    error: 'the harness went away',
  }
  assert.deepEqual(compactResultOf(status), {
    outcome: 'failed',
    contextBefore: null,
    contextAfter: null,
    error: 'the harness went away',
  })
})

test('a job still pending or running when the wait ended is timed_out', () => {
  for (const state of ['pending', 'running'] as const) {
    const status: ThreadCompactStatus = { thread: THREAD, state, requestedAt: 1_000 }
    assert.deepEqual(compactResultOf(status), { outcome: 'timed_out', contextBefore: null, contextAfter: null })
  }
})
