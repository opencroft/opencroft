// Pure-function tests for the context-usage reporting behind the send-message
// node's listSessions/compact actions — the unknown-vs-zero rule and the
// compaction verdict. No DB, no agent-client session store: run directly with
//   node_modules/.bin/tsx --test 'app/(extension-runtime)/_server/host-context-usage.test.ts'
import assert from 'node:assert/strict'
import test from 'node:test'

import { compactionVerdict, toContextUsage } from './session-context-usage'

// ── toContextUsage ───────────────────────────────────────────────────────

test('a harness that reported usage maps straight through', () => {
  assert.deepEqual(toContextUsage({ used: 12_000, size: 200_000 }), {
    usedTokens: 12_000,
    contextLimit: 200_000,
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
  assert.deepEqual(toContextUsage({ used: 0, size: 200_000 }), { usedTokens: 0, contextLimit: 200_000 })
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
  // The gate compactSessionOnGraph applies (`compacted === false` skips).
  // Spelled out here because getting it wrong is silent in both directions:
  // too eager grows the context on the failure path, too shy leaves an agent
  // without its instructions.
  const skipsRestore = (before: number, after: number) => compactionVerdict(usage(before), usage(after)) === false
  assert.equal(skipsRestore(500_000, 20_000), false, 'shrank -> restore')
  assert.equal(skipsRestore(500_000, 500_000), false, 'unchanged -> restore')
  assert.equal(skipsRestore(500_000, 501_200), true, 'grew -> skip')
  assert.equal(compactionVerdict(null, null) === false, false, 'unknown -> restore')
})
