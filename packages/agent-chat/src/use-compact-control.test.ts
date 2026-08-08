// Pins compactStatusMessage's branches -- the one piece of non-trivial logic
// behind the ContextRing's statusMessage/statusTone wiring.
import assert from 'node:assert/strict'
import test from 'node:test'

import { compactStatusMessage } from './use-compact-control'

test('no status yet has nothing to say -- the ring already shows idle', () => {
  assert.deepEqual(compactStatusMessage(null), { tone: 'default' })
})

test('never-requested reads the same as no status', () => {
  assert.deepEqual(compactStatusMessage({ state: 'never-requested' }), { tone: 'default' })
})

test('pending and running stay silent -- the ring and the button already say so', () => {
  assert.deepEqual(compactStatusMessage({ state: 'pending' }), { tone: 'default' })
  assert.deepEqual(compactStatusMessage({ state: 'running' }), { tone: 'default' })
})

test('error surfaces the server-provided message, destructive', () => {
  assert.deepEqual(compactStatusMessage({ state: 'error', error: 'boom' }), {
    message: 'boom',
    tone: 'destructive',
  })
})

test('error falls back to generic copy when the server sent none', () => {
  assert.deepEqual(compactStatusMessage({ state: 'error' }), {
    message: 'Compaction failed.',
    tone: 'destructive',
  })
})

test('done with a shrunk context reports the before/after token counts', () => {
  const outcome = compactStatusMessage({
    state: 'done',
    result: {
      contextUsageBefore: { usedTokens: 12000, contextLimit: null },
      contextUsageAfter: { usedTokens: 3000, contextLimit: null },
      compacted: true,
    },
  })
  assert.deepEqual(outcome, { message: 'Compacted — 12,000 → 3,000 tokens.', tone: 'default' })
})

test('done with nothing to compact says so, not a bare "Compacted"', () => {
  const outcome = compactStatusMessage({
    state: 'done',
    result: { contextUsageBefore: null, contextUsageAfter: null, compacted: false },
  })
  assert.match(outcome.message ?? '', /already small/)
  assert.equal(outcome.tone, 'default')
})

test('done with unknown usage still reports success rather than fabricating numbers', () => {
  const outcome = compactStatusMessage({
    state: 'done',
    result: { contextUsageBefore: null, contextUsageAfter: null, compacted: true },
  })
  assert.deepEqual(outcome, { message: 'Compacted.', tone: 'default' })
})

test('done with no result at all still reads as finished, not an error', () => {
  assert.deepEqual(compactStatusMessage({ state: 'done' }), {
    message: 'Compaction finished.',
    tone: 'default',
  })
})
