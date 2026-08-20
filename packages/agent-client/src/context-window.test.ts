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

test('a bridged session with no configured window has no known window, however plausible the report', () => {
  assert.equal(knownContextWindow(selection(), 200_000), undefined)
  assert.equal(knownContextWindow(selection(), 1_000_000), undefined, 'a correct figure is still unverifiable here')
})

test('a native session may use the size it reported -- we computed that one', () => {
  // resolveContextWindow (native-harness.ts) returns the configured value or
  // the /models-discovered one, and 0 for neither. It cannot guess, so this is
  // the discovery authority arriving over the only channel it has.
  assert.equal(knownContextWindow(selection({ adapterId: 'native' }), 128_000), 128_000)
})

test('a native session reporting 0 has no window -- 0 means "could not determine", not "no capacity"', () => {
  assert.equal(knownContextWindow(selection({ adapterId: 'native' }), 0), undefined)
  assert.equal(knownContextWindow(selection({ adapterId: 'native' }), undefined), undefined)
})

test('a non-positive configured window is not a window', () => {
  assert.equal(knownContextWindow(selection({ contextWindow: 0 }), 200_000), undefined)
  assert.equal(knownContextWindow(selection({ contextWindow: -1 }), 200_000), undefined)
})

test('an unknown adapter id is treated as unverified, not as native', () => {
  // Fails toward withholding: a name we cannot resolve earns no trust.
  assert.equal(knownContextWindow(selection({ adapterId: 'not-a-real-adapter' }), 200_000), undefined)
})

test('normalizeUsage keeps `used` untouched and only ever decides the window', () => {
  assert.deepEqual(normalizeUsage(selection(), { used: 185_000, size: 200_000 }), {
    used: 185_000,
    size: undefined,
  })
  assert.deepEqual(normalizeUsage(selection({ contextWindow: 1_000_000 }), { used: 185_000, size: 200_000 }), {
    used: 185_000,
    size: 1_000_000,
  })
})

test('normalizeUsage withholds a window rather than the reading -- tokens still report in full', () => {
  // A withheld window must never cost the caller the token count: the ring
  // shows usage without a percentage, which is not the same as showing nothing.
  const out = normalizeUsage(selection(), { used: 531_737, size: 200_000 })
  assert.equal(out.used, 531_737)
  assert.equal(out.size, undefined)
})
