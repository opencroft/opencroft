// Which window a reading may be shown against. Checked directly against a
// table rather than only through a live session, the same reasoning the other
// pure exports in this package are covered by: the rule is about where a
// number CAME FROM, and a table is the only place every provenance can sit
// side by side.
import assert from 'node:assert/strict'
import test from 'node:test'

import { knownContextWindow, normalizeUsage } from './context-window'
import type { AgentSelection } from './types'

// 'openclaw' is an ACP adapter (an external bridge); 'native' is the
// in-process harness. That difference is the whole point of the table below,
// so it is asserted rather than assumed.
function selection(overrides: Partial<AgentSelection> = {}): AgentSelection {
  return {
    providerId: 'test-provider',
    adapterId: 'openclaw',
    model: 'test-model',
    apiKey: '',
    cwd: '/tmp/context-window-test',
    ...overrides,
  }
}

test('a configured window wins, whatever the harness reported', () => {
  const s = selection({ contextWindow: 1_000_000 })
  assert.equal(knownContextWindow(s, 200_000), 1_000_000, 'a bridged claim does not displace a configured window')
  assert.equal(knownContextWindow(s, 0), 1_000_000, 'nor does the absence of one')
  assert.equal(knownContextWindow(s, undefined), 1_000_000)
})

test('a configured window wins even when this reading does not contradict the reported one', () => {
  // The regression that reopened this: 185k against a reported 200k is not
  // self-contradicting, so a rule keyed on `used > size` never fired and the
  // bridge's figure was relayed as fact. Provenance does not depend on the
  // reading agreeing or disagreeing.
  assert.equal(knownContextWindow(selection({ contextWindow: 1_000_000 }), 200_000), 1_000_000)
})

test('a bridged session with no configured window uses the size the harness reported', () => {
  // Rewritten 2026-09-18: this asserted the opposite — a bridged size was
  // withheld as unverifiable, because the old bridge seeded a family default
  // and reported it as fact. The decision was that permanently hiding
  // the window costs more, and the bridge now learns real per-model windows.
  // What the old test protected — never rendering against an impossible
  // figure — lives in the value guards below and in displayableContextWindow's
  // used-vs-size check, no longer in adapter identity.
  assert.equal(knownContextWindow(selection(), 200_000), 200_000)
  assert.equal(knownContextWindow(selection(), 1_000_000), 1_000_000)
})

test('a native session may use the size it reported', () => {
  // Once the discovery authority (resolveContextWindow returns the configured
  // or /models-discovered value, 0 for neither); now the same rule every
  // harness gets — kept to pin that the unification did not regress native.
  assert.equal(knownContextWindow(selection({ adapterId: 'native' }), 128_000), 128_000)
})

test('a native session reporting 0 has no window -- 0 means "could not determine", not "no capacity"', () => {
  assert.equal(knownContextWindow(selection({ adapterId: 'native' }), 0), undefined)
  assert.equal(knownContextWindow(selection({ adapterId: 'native' }), undefined), undefined)
})

test('a non-positive configured window is not configured — the reported size stands in', () => {
  // Rewritten 2026-09-18: an unusable configured value used to block the
  // window entirely, because nothing below it was trusted. It now means what
  // the node field's empty state means — "not configured" — and the reported
  // size takes over. What the old expectation protected (never rendering
  // against the bad configured value itself) still holds: 0 and -1 are not
  // what gets shown, the harness's figure is.
  assert.equal(knownContextWindow(selection({ contextWindow: 0 }), 200_000), 200_000)
  assert.equal(knownContextWindow(selection({ contextWindow: -1 }), 200_000), 200_000)
  assert.equal(
    knownContextWindow(selection({ contextWindow: 0 }), undefined),
    undefined,
    'and with nothing reported, nothing shows',
  )
})

test('a non-finite window is not a window, from either source', () => {
  // Infinity cannot arrive over JSON but can be produced in-process, and a
  // ratio drawn against it reads 0% at every token count — the most
  // convincing way to be wrong. A non-finite CONFIGURED value falls through
  // to the reported size (same "not configured" reading as above); a
  // non-finite REPORTED one has nothing to fall through to.
  assert.equal(knownContextWindow(selection({ contextWindow: Number.POSITIVE_INFINITY }), 200_000), 200_000)
  assert.equal(knownContextWindow(selection({ contextWindow: Number.NaN }), 200_000), 200_000)
  assert.equal(knownContextWindow(selection(), Number.POSITIVE_INFINITY), undefined)
  assert.equal(
    knownContextWindow(selection({ adapterId: 'native' }), Number.POSITIVE_INFINITY),
    undefined,
    'the reported figure gets the same guard whichever harness sent it',
  )
})

test('an unknown adapter id gets the same treatment as every harness — the value guards decide, not the name', () => {
  // Rewritten 2026-09-18: adapter identity used to gate window trust and an
  // unresolvable name failed toward withholding. The name no longer decides
  // anything here; what still cannot pass is a value the guards reject.
  assert.equal(knownContextWindow(selection({ adapterId: 'not-a-real-adapter' }), 200_000), 200_000)
})

test('normalizeUsage keeps `used` untouched and only ever decides the window', () => {
  assert.deepEqual(normalizeUsage(selection(), { used: 185_000, size: 200_000 }), {
    used: 185_000,
    size: 200_000,
  })
  assert.deepEqual(normalizeUsage(selection({ contextWindow: 1_000_000 }), { used: 185_000, size: 200_000 }), {
    used: 185_000,
    size: 1_000_000,
  })
})

test('normalizeUsage withholds a window this very reading contradicts -- tokens still report in full', () => {
  // The sanity gate (displayableContextWindow): 531k used against a reported
  // 200k window is an impossible ratio, so the window is dropped, never the
  // reading — the ring shows usage without a percentage, which is not the
  // same as showing nothing. With the bridged size trusted now, this gate is
  // what still stands between the reader and a >100% ring.
  const out = normalizeUsage(selection(), { used: 531_737, size: 200_000 })
  assert.equal(out.used, 531_737)
  assert.equal(out.size, undefined)
})
