import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeResetsAt,
  normalizeTurnUsage,
  parseRateLimit,
  parseSessionFailure,
  parseTurnQuota,
} from './usage-meta'

// These pin the parsers at the boundary they exist for: wire data shaped by
// another program, where a malformed decoration must drop, never throw, and
// an absent field must stay absent rather than read as a zero.

test('normalizeResetsAt accepts epoch seconds or milliseconds by magnitude', () => {
  assert.equal(normalizeResetsAt(1_760_000_000), 1_760_000_000_000)
  assert.equal(normalizeResetsAt(1_760_000_000_000), 1_760_000_000_000)
})

test('normalizeResetsAt drops values that fit neither reading', () => {
  assert.equal(normalizeResetsAt(0), undefined)
  assert.equal(normalizeResetsAt(-5), undefined)
  assert.equal(normalizeResetsAt('soon'), undefined)
  assert.equal(normalizeResetsAt(undefined), undefined)
})

test('parseRateLimit needs a status and a window name', () => {
  assert.equal(
    parseRateLimit({ '_claude/rateLimit': { status: 'allowed', rateLimitType: 'five_hour' } })?.window,
    'five_hour',
  )
  assert.equal(parseRateLimit({ '_claude/rateLimit': { status: 'allowed' } }), undefined)
  assert.equal(parseRateLimit({ '_claude/rateLimit': { rateLimitType: 'five_hour' } }), undefined)
  assert.equal(parseRateLimit({}), undefined)
  assert.equal(parseRateLimit(undefined), undefined)
  assert.equal(parseRateLimit('nonsense'), undefined)
})

test('normalizeTurnUsage reads the cache counters under every name they arrive by', () => {
  // ACP's own experimental `Usage` — what the claude bridge puts on the
  // prompt response.
  assert.deepEqual(
    normalizeTurnUsage({
      totalTokens: 100,
      inputTokens: 10,
      outputTokens: 20,
      cachedReadTokens: 60,
      cachedWriteTokens: 10,
    }),
    { totalTokens: 100, inputTokens: 10, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10 },
  )
  // The bridge's `_meta.quota.token_count`, in codex-acp's spelling.
  assert.deepEqual(
    normalizeTurnUsage({
      totalTokens: 100,
      inputTokens: 10,
      cachedInputTokens: 60,
      cachedWriteTokens: 10,
      outputTokens: 20,
    }),
    { totalTokens: 100, inputTokens: 10, outputTokens: 20, cacheReadTokens: 60, cacheWriteTokens: 10 },
  )
  // A reading with no cache figures at all keeps them absent, not zero.
  assert.deepEqual(normalizeTurnUsage({ totalTokens: 5, inputTokens: 5 }), { totalTokens: 5, inputTokens: 5 })
})

test('parseTurnQuota keeps a bare token_count and drops malformed model rows', () => {
  const quota = parseTurnQuota({
    quota: {
      token_count: { totalTokens: 10 },
      model_usage: [{ model: 'm', token_count: { totalTokens: 12 } }, { model: '', token_count: {} }, 'junk'],
    },
  })
  assert.deepEqual(quota, {
    tokenCount: { totalTokens: 10 },
    modelUsage: [{ model: 'm', tokenCount: { totalTokens: 12 } }],
  })
  assert.deepEqual(parseTurnQuota({ quota: {} }), undefined)
  assert.deepEqual(parseTurnQuota({}), undefined)
})

test('parseSessionFailure reads the AIR payload and refuses an unnamed one', () => {
  const failure = parseSessionFailure({
    jetbrains: {
      air: {
        sessionFailure: {
          id: 't:error',
          kind: 'quota_exhausted',
          category: 'limit',
          severity: 'error',
          title: 'Out of quota',
        },
      },
    },
  })
  assert.deepEqual(failure, {
    id: 't:error',
    kind: 'quota_exhausted',
    title: 'Out of quota',
    category: 'limit',
    severity: 'error',
    actions: undefined,
  })
  assert.equal(parseSessionFailure({ jetbrains: { air: { sessionFailure: { id: 'x' } } } }), undefined)
  assert.equal(parseSessionFailure({}), undefined)
})
