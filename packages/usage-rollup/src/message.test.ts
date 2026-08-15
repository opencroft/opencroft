import assert from 'node:assert/strict'
import test from 'node:test'

import { composeDailyRollupMessage } from './message'
import type { RollupRow } from './types'

function row(overrides: Partial<RollupRow> = {}): RollupRow {
  return {
    day: '2026-08-14',
    agent: 'bob',
    model: 'claude-sonnet-5',
    requests: 100,
    rawInputTokens: 200,
    cacheWriteTokens: 1_000,
    cacheReadTokens: 2_000_000,
    outputTokens: 50_000,
    coldPrimeRequests: 0,
    coldPrimeTokens: 0,
    ...overrides,
  }
}

test('reports no activity plainly rather than an empty table', () => {
  const message = composeDailyRollupMessage('2026-08-14', [])
  assert.equal(message, 'Usage rollup — 2026-08-14: no transcript activity found.')
})

test('sums multiple models for the same agent into one table row', () => {
  const message = composeDailyRollupMessage('2026-08-14', [
    row({ agent: 'bob', model: 'claude-sonnet-5', requests: 100 }),
    row({ agent: 'bob', model: 'claude-opus-5', requests: 50 }),
  ])
  const agentLines = message.split('\n').filter((l) => l.startsWith('| bob'))
  assert.equal(agentLines.length, 1)
  assert.match(agentLines[0], /150/)
})

test('keeps GLM usage out of the cached-provider table and in its own line', () => {
  const message = composeDailyRollupMessage('2026-08-14', [
    row({ agent: 'alice', model: 'claude-opus-5', requests: 10 }),
    row({ agent: 'alice', model: 'glm-5.2', requests: 5, rawInputTokens: 12_000 }),
  ])
  assert.doesNotMatch(message.split('GLM')[0], /glm-5\.2/)
  assert.match(message, /GLM \(separate provider, no caching\): 5 requests, 12\.0K raw input/)
})

test('omits the cold-re-prime line when nothing crossed the threshold', () => {
  const message = composeDailyRollupMessage('2026-08-14', [row({ coldPrimeRequests: 0 })])
  assert.doesNotMatch(message, /Cold re-primes/)
})

test('reports cold re-primes when present', () => {
  const message = composeDailyRollupMessage('2026-08-14', [row({ coldPrimeRequests: 3, coldPrimeTokens: 450_000 })])
  assert.match(message, /Cold re-primes \(cache write > 100\.0K\): 3 requests, 450\.0K tokens/)
})

test('formats billions of cache-read tokens compactly', () => {
  const message = composeDailyRollupMessage('2026-08-14', [row({ cacheReadTokens: 10_204_000_000 })])
  assert.match(message, /10\.2B/)
})
