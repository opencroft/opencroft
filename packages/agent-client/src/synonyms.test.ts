import assert from 'node:assert/strict'
import test from 'node:test'

import { CANONICAL_EFFORTS, canonicalEffortId } from './session-effort'
import { CANONICAL_MODES, canonicalModeId } from './session-modes'
import { createSynonymResolver, normalizeSynonym } from './synonyms'

type Grade = 'low' | 'high'

test('a canonical value is always its own synonym', () => {
  // An agent already speaking our language needs no registration at all.
  const resolver = createSynonymResolver<Grade>(['low', 'high'], {})
  assert.equal(resolver.resolve('any-agent', 'low'), 'low')
  assert.equal(resolver.resolve('any-agent', 'high'), 'high')
})

test('case and separators are not meaningful', () => {
  // So a registration only needs spellings that differ in letters.
  const resolver = createSynonymResolver<Grade>(['low', 'high'], { high: ['extraHigh'] })
  for (const spelling of ['extraHigh', 'extra_high', 'extra-high', 'EXTRAHIGH', 'Extra High']) {
    assert.equal(resolver.resolve('any-agent', spelling), 'high', spelling)
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

test('normalizeSynonym strips only case and separators', () => {
  assert.equal(normalizeSynonym('Accept_Edits'), 'acceptedits')
  assert.equal(normalizeSynonym('accept-edits'), 'acceptedits')
  assert.equal(normalizeSynonym('acceptEdits'), 'acceptedits')
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

test('an agent reporting no reasoning and one reporting its baseline are both Default', () => {
  for (const spelling of ['default', 'none', 'off']) {
    assert.equal(canonicalEffortId('claude', spelling), 'default', spelling)
  }
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
