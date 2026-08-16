import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldResyncBuffer } from './agent-command-bar'

// ---------------------------------------------------------------------------
// shouldResyncBuffer -- the reset-contract decision behind AgentCommandBar's
// buffered `value`. The whole point of the buffer is to keep typing from
// forcing a host round-trip before a character appears; the whole risk of a
// buffer is a controlled input that fights back, showing stale text a
// keystroke behind. This is the one piece of that logic worth pinning down
// on its own, since there's no rendering harness in this package to catch a
// regression here by typing into a real textarea.
//
// The second argument is "value as of the previous render", NOT "what this
// component last reported via onValueChange" -- see the function's own
// comment for why those are different and the wrong one is a real bug, not a
// style preference. The last test below pins the specific failure mode.
// ---------------------------------------------------------------------------

test('an unchanged value since last render is not a resync', () => {
  assert.equal(shouldResyncBuffer('h', 'h'), false)
})

test('a value that differs from last render is external and wins', () => {
  // A session switch loading a different saved draft, a host-driven clear,
  // an edit-message prefill -- none of these are visible to this component
  // until the PROP itself moves, which is exactly what this checks for.
  assert.equal(shouldResyncBuffer('loaded draft', 'h'), true)
})

test('an external reset to empty still counts as external', () => {
  assert.equal(shouldResyncBuffer('', 'was typing this'), true)
})

test('two external changes in a row both resync, not just the first', () => {
  // Guards against an implementation that latches "already resynced" instead
  // of comparing against the true previous-render value on every render.
  assert.equal(shouldResyncBuffer('first', 'stale'), true)
  assert.equal(shouldResyncBuffer('second', 'first'), true)
})

test('a host that never echoes keystrokes back through value reads as unchanged across many renders', () => {
  // The actual bug this function exists to avoid: an EARLIER version of this
  // logic compared against "what this component last reported outward"
  // instead of "value last render". Under that version, a host that
  // deliberately does NOT round-trip every keystroke back through `value`
  // (the whole point of the buffer) would see its own stale, un-echoed
  // `value` read as "different from what was just reported" on literally
  // every keystroke -- resyncing the buffer BACKWARDS to the pre-keystroke
  // text and erasing what was just typed. The fix is comparing against the
  // prop's own previous value, which a host holding `value` steady during
  // typing satisfies trivially: same value in, same value out, call after
  // call, exactly the "many renders pass, nothing external happened" case
  // this pins.
  const heldSteady = 'hello'
  assert.equal(shouldResyncBuffer(heldSteady, heldSteady), false)
  assert.equal(shouldResyncBuffer(heldSteady, heldSteady), false)
  assert.equal(shouldResyncBuffer(heldSteady, heldSteady), false)
})
