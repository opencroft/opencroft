import assert from 'node:assert/strict'
import test from 'node:test'

import { CANONICAL_EFFORTS, canonicalEffortId } from './session-effort'
import { CANONICAL_MODES, canonicalModeId } from './session-modes'
import { createSynonymResolver } from './synonyms'

type Grade = 'low' | 'high'

test('a canonical value is always its own synonym', () => {
  // An agent already speaking our language needs no registration at all.
  const resolver = createSynonymResolver<Grade>(['low', 'high'], {})
  assert.equal(resolver.resolve('any-agent', 'low'), 'low')
  assert.equal(resolver.resolve('any-agent', 'high'), 'high')
})

test('matching is exact — a near-miss is not absorbed', () => {
  // The vocabulary is filled by hand, so a spelling nobody has looked at
  // surfaces as unrecognised instead of being quietly claimed by a rule that
  // happened to fit. Registering the variant is cheap; guessing is not.
  const resolver = createSynonymResolver<Grade>(['low', 'high'], { high: ['extraHigh'] })
  assert.equal(resolver.resolve('any-agent', 'extraHigh'), 'high')
  for (const nearMiss of ['extrahigh', 'extra_high', 'extra-high', 'EXTRAHIGH']) {
    assert.equal(resolver.resolve('any-agent', nearMiss), undefined, nearMiss)
  }
})

test('an unregistered spelling resolves to nothing rather than a guess', () => {
  const resolver = createSynonymResolver<Grade>(['low', 'high'], {})
  assert.equal(resolver.resolve('any-agent', 'turbo'), undefined)
})

test('an adapter registration wins over the shared one, and stays scoped to it', () => {
  // The point of the per-adapter layer: a word that means one thing for one
  // agent must not silently mean it for every agent.
  const resolver = createSynonymResolver<Grade>(
    ['low', 'high'],
    { low: ['baseline'] },
    { fast: { high: ['baseline'] } },
  )
  assert.equal(resolver.resolve('fast', 'baseline'), 'high')
  assert.equal(resolver.resolve('other', 'baseline'), 'low')
})

test('every spelling Claude Code actually sends is registered', () => {
  // With exact matching there is no normaliser to catch an unregistered
  // variant, so the wire ids the bridge really emits have to be listed. This
  // is the test that fails if someone adds a canonical value and forgets it.
  for (const wire of ['auto', 'plan', 'default', 'acceptEdits', 'dontAsk', 'bypassPermissions']) {
    assert.ok(canonicalModeId('claude-subscription', wire), `${wire} is unregistered`)
  }
})

// ── the two real vocabularies ──────────────────────────────────────────────

test("Claude Code's spellings resolve to our mode ids", () => {
  const cases: [string, string][] = [
    ['auto', 'auto'],
    ['plan', 'plan'],
    ['default', 'manual-edits'],
    ['acceptEdits', 'accept-edits'],
    ['dontAsk', 'reject-edits'],
    ['bypassPermissions', 'bypass'],
  ]
  for (const [wire, ours] of cases) {
    assert.equal(canonicalModeId('claude-subscription', wire), ours, wire)
  }
})

test('`default` is read as manual-edits only for the agent it was verified against', () => {
  // It describes nothing on its own — another agent could use it for anything —
  // so the guess stays scoped rather than leaking into the shared table.
  assert.equal(canonicalModeId('claude', 'default'), 'manual-edits')
  assert.equal(canonicalModeId('some-other-agent', 'default'), undefined)
})

test('xhigh resolves to Extra', () => {
  // The synonym that earns the registry: the agent surfaces it as "Xhigh".
  assert.equal(canonicalEffortId('claude', 'xhigh'), 'extra')
  assert.equal(CANONICAL_EFFORTS.extra.label, 'Extra')
})

test('not thinking and not tuning are different answers', () => {
  // `off` is an instruction not to think; `default` leaves whatever baseline the
  // agent already has. Folding them together made one of the two unreachable.
  assert.equal(canonicalEffortId('claude', 'default'), 'default')
  assert.equal(canonicalEffortId('claude', 'off'), 'off')
  // `none` reads as the instruction rather than the baseline. An agent that
  // means its baseline by it says so per adapter, which is what that layer of
  // the registry is for.
  assert.equal(canonicalEffortId('claude', 'none'), 'off')
})

test('no synonym is registered against two different canonical values', () => {
  // Within one vocabulary a spelling must mean exactly one thing, or which one
  // wins comes down to object key order.
  for (const [name, ids] of [
    ['modes', Object.keys(CANONICAL_MODES)],
    ['efforts', Object.keys(CANONICAL_EFFORTS)],
  ] as [string, string[]][]) {
    assert.equal(new Set(ids).size, ids.length, `${name} has a duplicate id`)
  }
})
