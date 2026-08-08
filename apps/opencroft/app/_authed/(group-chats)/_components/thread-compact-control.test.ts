// Pins statusLabel's branches -- the one piece of non-trivial logic in the
// thread compact control, and the thing a user reads to tell the affordance's
// state apart.
import assert from 'node:assert/strict'
import test from 'node:test'

import { statusLabel } from './thread-compact-control'

test('no status yet reads as an idle invitation, not a blank', () => {
  assert.match(statusLabel(null), /compact/i)
})

test('never-requested reads the same as no status', () => {
  assert.match(statusLabel({ sessionKey: 'k', state: 'never-requested' }), /compact/i)
})

test('pending and running both read as in progress', () => {
  assert.equal(statusLabel({ sessionKey: 'k', state: 'pending' }), 'Compacting…')
  assert.equal(statusLabel({ sessionKey: 'k', state: 'running' }), 'Compacting…')
})

test('error surfaces the server-provided message when present', () => {
  assert.equal(statusLabel({ sessionKey: 'k', state: 'error', error: 'boom' }), 'boom')
})

test('error falls back to generic copy when the server sent none', () => {
  assert.equal(statusLabel({ sessionKey: 'k', state: 'error' }), 'Compaction failed.')
})

test('done with a shrunk context reports the before/after token counts', () => {
  const label = statusLabel({
    sessionKey: 'k',
    state: 'done',
    result: {
      sessionKey: 'k',
      contextUsageBefore: { usedTokens: 12000, contextLimit: null },
      contextUsageAfter: { usedTokens: 3000, contextLimit: null },
      compacted: true,
      instructionsRestored: true,
    },
  })
  assert.equal(label, 'Compacted — 12,000 → 3,000 tokens.')
})

test('done with nothing to compact says so, not a bare "Compacted"', () => {
  const label = statusLabel({
    sessionKey: 'k',
    state: 'done',
    result: {
      sessionKey: 'k',
      contextUsageBefore: null,
      contextUsageAfter: null,
      compacted: false,
      instructionsRestored: false,
    },
  })
  assert.match(label, /already small/)
})

test('done with unknown usage still reports success rather than fabricating numbers', () => {
  const label = statusLabel({
    sessionKey: 'k',
    state: 'done',
    result: {
      sessionKey: 'k',
      contextUsageBefore: null,
      contextUsageAfter: null,
      compacted: true,
      instructionsRestored: true,
    },
  })
  assert.equal(label, 'Compacted.')
})

test('done with no result at all still reads as finished, not an error', () => {
  assert.equal(statusLabel({ sessionKey: 'k', state: 'done' }), 'Compaction finished.')
})
