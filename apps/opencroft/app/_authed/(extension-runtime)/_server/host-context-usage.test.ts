// Pure-function tests for the context-usage reporting behind the send-message
// node's listSessions/compact actions — the unknown-vs-zero rule and the
// compaction verdict. No DB, no agent-client session store: run directly with
//   node_modules/.bin/tsx --test 'app/(extension-runtime)/_server/host-context-usage.test.ts'
import assert from 'node:assert/strict'
import test from 'node:test'

import { compactionVerdict, toContextUsage } from './session-context-usage'

// ── toContextUsage ───────────────────────────────────────────────────────
//
// The live-branch fixtures below use a window that could only have been
// vouched for -- a discovered or configured one. 200_000 is the family base
// window an unlabelled bridge advertises, and it appears deliberately only in
// the provenance tests further down, where refusing it is the point. A fixture
// that relayed it here would read as an endorsement of the one figure this
// module exists to refuse.

test('a harness that reported usage maps straight through', () => {
  assert.deepEqual(toContextUsage({ used: 12_000, size: 128_000 }), {
    usedTokens: 12_000,
    contextLimit: 128_000,
  })
})

test('no usage at all is null, never zero tokens', () => {
  // The distinction a caller depends on: an offline session, or one that has
  // not finished a turn since being loaded, holds an UNKNOWN amount. Reporting
  // 0 would read as "nothing held" and suppress a compaction that is due.
  assert.equal(toContextUsage(undefined), null)
})

test('usage without a known window reports the tokens and a null limit', () => {
  // The native harness sends size 0 for a model it has no context window for,
  // which agent-client already normalises to undefined. Tokens are still real.
  assert.deepEqual(toContextUsage({ used: 500 }), { usedTokens: 500, contextLimit: null })
})

test('zero tokens actually reported is preserved as zero, not folded into unknown', () => {
  assert.deepEqual(toContextUsage({ used: 0, size: 128_000 }), { usedTokens: 0, contextLimit: 128_000 })
})

// ── toContextUsage's last-known fallback (offline sessions) ────────────────

test('no live usage but a last-known reading reports it with asOf set', () => {
  // The window comes from the agent's configured one, not from the persisted
  // pair — see the provenance tests below.
  assert.deepEqual(toContextUsage(undefined, { used: 12_000, size: 200_000, at: 1_700_000_000_000 }, 1_000_000), {
    usedTokens: 12_000,
    contextLimit: 1_000_000,
    asOf: 1_700_000_000_000,
  })
})

// ── the offline branch's window is the agent's, never the persisted one ────
//
// This is the third door a reading takes to a surface. The live path and the
// restore path both run a reading through agent-client's normaliseUsage; a
// persisted pair read for an offline session reaches the wire without passing
// either, so it gets the same test here rather than inheriting a cleanliness
// it was never checked for.

test('a persisted size is not relayed: without a configured window there is no ratio', () => {
  assert.deepEqual(
    toContextUsage(undefined, { used: 88_000, size: 200_000, at: 1_700_000_000_000 }),
    { usedTokens: 88_000, contextLimit: null, asOf: 1_700_000_000_000 },
    'the 200_000 was written by an earlier session from its harness report; reading it back does not verify it',
  )
})

test('the configured window replaces the persisted one rather than filling in for it', () => {
  assert.deepEqual(
    toContextUsage(undefined, { used: 88_000, size: 200_000, at: 1_700_000_000_000 }, 1_000_000),
    { usedTokens: 88_000, contextLimit: 1_000_000, asOf: 1_700_000_000_000 },
    'a disagreeing persisted size loses to the agent config, exactly as a bridged one loses on the live path',
  )
})

test('a configured window the persisted reading disproves is withheld offline too', () => {
  assert.deepEqual(
    toContextUsage(undefined, { used: 531_737, size: 200_000, at: 1_700_000_000_000 }, 300_000),
    { usedTokens: 531_737, contextLimit: null, asOf: 1_700_000_000_000 },
    'the same subordinate gate the live path applies -- a mistyped override cannot render past 100% here either',
  )
})

test('a configured window exactly at the persisted used still shows the ratio offline', () => {
  assert.deepEqual(toContextUsage(undefined, { used: 500_000, size: 200_000, at: 1 }, 500_000), {
    usedTokens: 500_000,
    contextLimit: 500_000,
    asOf: 1,
  })
})

test('a non-positive configured window is treated as none, not as a zero-capacity window', () => {
  assert.deepEqual(toContextUsage(undefined, { used: 88_000, size: 200_000, at: 1 }, 0), {
    usedTokens: 88_000,
    contextLimit: null,
    asOf: 1,
  })
})

test('a live reading ignores the configured window: it was normalised on the way in', () => {
  assert.deepEqual(
    toContextUsage({ used: 5_000, size: 128_000 }, undefined, 999),
    { usedTokens: 5_000, contextLimit: 128_000 },
    'the live branch must not second-guess agent-client, which already applied the rule with more to go on',
  )
})

test('a live reading always wins over a last-known one, and never carries asOf', () => {
  assert.deepEqual(toContextUsage({ used: 5_000, size: 128_000 }, { used: 999_000, size: 200_000, at: 1 }), {
    usedTokens: 5_000,
    contextLimit: 128_000,
  })
})

test('no live usage and no last-known reading is still null, never zero', () => {
  assert.equal(toContextUsage(undefined, undefined), null)
})

test('a last-known reading with no known window reports the tokens and a null limit, same as live', () => {
  assert.deepEqual(toContextUsage(undefined, { used: 500, at: 1_700_000_000_000 }), {
    usedTokens: 500,
    contextLimit: null,
    asOf: 1_700_000_000_000,
  })
})

// ── compactionVerdict ────────────────────────────────────────────────────

const usage = (usedTokens: number) => ({ usedTokens, contextLimit: 200_000 })

test('a drop in held tokens is a compaction', () => {
  assert.equal(compactionVerdict(usage(500_000), usage(20_000)), true)
})

test('growth is a definite failure to compact', () => {
  // What a harness with no `/compact` looks like: it answered the command as
  // ordinary text, so the context grew instead. This is the one branch that
  // must read false, because it is what suppresses the instruction restore.
  assert.equal(compactionVerdict(usage(500_000), usage(501_200)), false)
})

test('an unchanged figure is unknown, not a failure', () => {
  // Nothing orders the harness's usage report against the prompt response, so
  // a figure identical to the one before is indistinguishable from a reading
  // that has not been refreshed yet. Reporting false would claim a failure
  // that was never observed — and would skip the instruction restore on it.
  assert.equal(compactionVerdict(usage(500_000), usage(500_000)), null)
})

test('unknown usage on either side is unknown, not false', () => {
  // "I cannot see whether it shrank" must not be reported as "it did not
  // shrink" — the caller would retry compaction forever on the first, and
  // give up wrongly on the second.
  assert.equal(compactionVerdict(null, usage(20_000)), null)
  assert.equal(compactionVerdict(usage(500_000), null), null)
  assert.equal(compactionVerdict(null, null), null)
})

test('only growth suppresses the restore; every other verdict allows it', () => {
  // The gate performCompact applies (`compacted === false` skips).
  // Spelled out here because getting it wrong is silent in both directions:
  // too eager grows the context on the failure path, too shy leaves an agent
  // without its instructions.
  const skipsRestore = (before: number, after: number) => compactionVerdict(usage(before), usage(after)) === false
  assert.equal(skipsRestore(500_000, 20_000), false, 'shrank -> restore')
  assert.equal(skipsRestore(500_000, 500_000), false, 'unchanged -> restore')
  assert.equal(skipsRestore(500_000, 501_200), true, 'grew -> skip')
  assert.equal(compactionVerdict(null, null) === false, false, 'unknown -> restore')
})
