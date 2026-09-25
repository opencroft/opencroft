import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeResetsAt,
  normalizeTurnUsage,
  normalizeUtilization,
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

test('parseRateLimit reads the wire fraction as the percentage it means', () => {
  // The shape a live account actually sends: 0.79 of the weekly window, which
  // is 79% used and not the 1% a straight read rounds to.
  assert.deepEqual(
    parseRateLimit({
      '_claude/rateLimit': {
        status: 'allowed_warning',
        rateLimitType: 'seven_day_overage_included',
        utilization: 0.79,
      },
    }),
    { status: 'allowed_warning', window: 'seven_day_overage_included', utilization: 79 },
  )
})

test('normalizeUtilization converts the ends of the range and drops what is not a fraction', () => {
  assert.equal(normalizeUtilization(0), 0)
  assert.equal(normalizeUtilization(1), 100)
  // The tail of 0.79 * 100 never reaches a stored reading.
  assert.equal(normalizeUtilization(0.79), 79)
  assert.equal(normalizeUtilization(0.1234), 12.3)
  // Out of range: a percentage-shaped value would pin the window at full, so
  // it drops instead and the row shows no gauge.
  assert.equal(normalizeUtilization(79), undefined)
  assert.equal(normalizeUtilization(-0.1), undefined)
  assert.equal(normalizeUtilization('0.5'), undefined)
  assert.equal(normalizeUtilization(undefined), undefined)
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

test('parseTurnQuota reads codex-acp token_count, reasoning tokens included', () => {
  // codex-acp 1.13.1, src/TokenCount.ts via `buildQuotaMeta` in
  // src/CodexAcpServer.ts: `{ totalTokens, inputTokens, cachedInputTokens,
  // outputTokens, reasoningOutputTokens }`, the same object in `token_count`
  // and in the single `model_usage` row.
  const tokenCount = {
    totalTokens: 1_000,
    inputTokens: 300,
    cachedInputTokens: 500,
    outputTokens: 200,
    reasoningOutputTokens: 150,
  }
  const expected = { totalTokens: 1_000, inputTokens: 300, outputTokens: 200, thoughtTokens: 150, cacheReadTokens: 500 }
  assert.deepEqual(
    parseTurnQuota({ quota: { token_count: tokenCount, model_usage: [{ model: 'gpt-5', token_count: tokenCount }] } }),
    {
      tokenCount: expected,
      modelUsage: [{ model: 'gpt-5', tokenCount: expected }],
    },
  )
  // ACP's own spelling wins where both appear.
  assert.equal(normalizeTurnUsage({ totalTokens: 1, thoughtTokens: 2, reasoningOutputTokens: 3 })?.thoughtTokens, 2)
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

// Wire shapes copied from the bridges, not from our own type. The earlier
// fixture carried a `kind` no bridge sends, so the parser that required it
// passed its test and dropped every real verdict.
//
// claude-agent-acp 0.79.0, dist/session-failure-extension.js:
// `sessionFailureMeta()` sends `{ id, revision, category, severity, title,
// details?, reason?, actions }` — no `kind`. `prepare()` builds a turn-scoped
// id as `${turnId}:error` and a session-scoped one as
// `${sessionId}:session-error:${epoch}:${n}`; the categories and actions come
// from its `AIR_FAILURE_POLICY`.
//
// codex-acp 1.13.1, src/CodexAcpServer.ts (`SessionFailure`) and
// src/CodexEventHandler.ts (`recordSessionFailure`, `SESSION_FAILURE_POLICY`):
// `{ id, revision, category, severity, title, details?, actions }` — neither
// `kind` nor `reason`.
//
// Titles are placeholders: the bridges fill them from provider error text.
function airMeta(sessionFailure: unknown) {
  return { jetbrains: { air: { version: 1, sessionFailure } } }
}

test('parseSessionFailure keeps a claude-agent-acp quota verdict, which carries no kind', () => {
  // `quota_exhausted`: category `limit`, actions `[]`, attached to the prompt
  // response by `failActiveWithSessionFailure`. No `reason` — the bridge sets
  // one only on sign-in refusals.
  assert.deepEqual(
    parseSessionFailure(
      airMeta({
        id: 'prompt-uuid-1:error',
        revision: 1,
        category: 'limit',
        severity: 'error',
        title: 'The Claude account has no available quota.',
        actions: [],
      }),
    ),
    {
      id: 'prompt-uuid-1:error',
      label: 'quota_exhausted',
      revision: 1,
      title: 'The Claude account has no available quota.',
      category: 'limit',
      severity: 'error',
      actions: [],
    },
  )
})

test('parseSessionFailure keeps the claude-agent-acp reason beside the derived label', () => {
  // `publishRefusal` in hide-claude-auth.js: `auth_required` refined by
  // `claude_subscription_not_supported`, session-scoped, with details.
  assert.deepEqual(
    parseSessionFailure(
      airMeta({
        id: 'session-1:session-error:epoch-1:1',
        revision: 1,
        category: 'access',
        severity: 'error',
        title: 'Sign in to continue using Claude.',
        details: 'This integration does not support using claude.ai subscriptions.',
        reason: 'claude_subscription_not_supported',
        actions: ['login'],
      }),
    ),
    {
      id: 'session-1:session-error:epoch-1:1',
      label: 'auth_required',
      reason: 'claude_subscription_not_supported',
      revision: 1,
      title: 'Sign in to continue using Claude.',
      category: 'access',
      severity: 'error',
      details: 'This integration does not support using claude.ai subscriptions.',
      actions: ['login'],
    },
  )
})

test('parseSessionFailure keeps a codex-acp quota verdict, which carries neither kind nor reason', () => {
  // `usageLimitExceeded` maps to `quota_exhausted`: category `limit`, actions `[]`.
  assert.deepEqual(
    parseSessionFailure(
      airMeta({
        id: 'turn-1:error',
        revision: 1,
        category: 'limit',
        severity: 'error',
        title: "You've hit your usage limit.",
        actions: [],
      }),
    ),
    {
      id: 'turn-1:error',
      label: 'quota_exhausted',
      revision: 1,
      title: "You've hit your usage limit.",
      category: 'limit',
      severity: 'error',
      actions: [],
    },
  )
})

test('parseSessionFailure labels by category where the wire cannot tell kinds apart', () => {
  // codex-acp's retry warning (`recordRetryWarning`) empties the actions, so a
  // rate-limit retry is `limit` + `[]` like a quota exhaustion. It must not be
  // read as one.
  assert.equal(
    parseSessionFailure(
      airMeta({ id: 't:error', revision: 2, category: 'limit', severity: 'warning', title: 'Retrying', actions: [] }),
    )?.label,
    'limit',
  )
  // `limit` + `new_session` is a context or a budget exhaustion in both bridges.
  assert.equal(
    parseSessionFailure(
      airMeta({ id: 't:error', category: 'limit', severity: 'error', title: 'Too long', actions: ['new_session'] }),
    )?.label,
    'limit',
  )
  // `service` + `retry` is an overload or a provider error.
  assert.equal(
    parseSessionFailure(
      airMeta({ id: 't:error', category: 'service', severity: 'error', title: 'Busy', actions: ['retry'] }),
    )?.label,
    'service',
  )
})

test('parseSessionFailure takes a kind the harness does send over the inferred one', () => {
  const failure = parseSessionFailure(
    airMeta({ id: 't:error', kind: 'budget_exhausted', category: 'limit', title: 'Budget spent', actions: [] }),
  )
  assert.equal(failure?.label, 'budget_exhausted')
  assert.equal(failure?.kind, 'budget_exhausted')
  // Severity absent on the wire means `error` (codex-acp's documented default).
  assert.equal(failure?.severity, 'error')
})

test('parseSessionFailure drops a malformed decoration and keeps a sloppy one', () => {
  // Nothing a host could show: no title, or no id.
  assert.equal(parseSessionFailure(airMeta({ id: 'x' })), undefined)
  assert.equal(parseSessionFailure(airMeta({ title: 'Out of quota' })), undefined)
  assert.equal(parseSessionFailure(airMeta('junk')), undefined)
  assert.equal(parseSessionFailure({}), undefined)
  assert.equal(parseSessionFailure(undefined), undefined)
  // Showable, with junk around it: the junk goes, the verdict stays.
  assert.deepEqual(
    parseSessionFailure(airMeta({ id: 'x', title: 'Out', revision: 'two', reason: '', actions: ['retry', 7] })),
    { id: 'x', label: 'unknown', title: 'Out', category: 'unknown', severity: 'error', actions: ['retry'] },
  )
})
