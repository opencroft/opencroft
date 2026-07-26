import assert from 'node:assert/strict'
import test from 'node:test'

import { AT_BOTTOM_THRESHOLD, decideScrollAction, isAtBottom, LOAD_OLDER_KEEPS_POSITION } from './scroll-intent'

// ---------------------------------------------------------------------------
// Both sides of the product decision, so flipping the constant stays one line
// with the behaviour on each side already written down.
// ---------------------------------------------------------------------------

const loadingOlder = (atTop: boolean, atBottom = false) => ({ cause: 'loading-older' as const, atBottom, atTop })

test('B (shipped): from the top, nothing moves — that is what shows the new messages', () => {
  assert.equal(decideScrollAction(loadingOlder(true), false), 'none')
})

test('B: away from the top, the position is held after all', () => {
  // Not a hedge on the decision. B's reasoning is "leaving it alone puts the
  // new messages in front of the reader" — which stops being true the moment
  // they are no longer looking at where the button was. A slow fetch they
  // scrolled during, or a keyboard press followed by a scroll, and doing
  // nothing is no longer a reveal: it is the content lurching under them by
  // the height of everything that arrived.
  assert.equal(decideScrollAction(loadingOlder(false), false), 'hold-position')
})

test('A: the place is kept wherever they are', () => {
  assert.equal(decideScrollAction(loadingOlder(true), true), 'hold-position')
  assert.equal(decideScrollAction(loadingOlder(false), true), 'hold-position')
})

test('the default matches the shipped constant', () => {
  // So the two cannot drift apart if someone flips the flag without reading
  // the tests either side of it.
  assert.equal(decideScrollAction(loadingOlder(true)), LOAD_OLDER_KEEPS_POSITION ? 'hold-position' : 'none')
  assert.equal(decideScrollAction(loadingOlder(false)), 'hold-position')
})

// ---------------------------------------------------------------------------
// The precedence. These are the pairs that used to be separate effects, and
// each test names the failure that pair actually produced.
// ---------------------------------------------------------------------------

test('a prepend outranks following the bottom', () => {
  // The old shape: a "load older" prepend grows the content, the bottom-follow
  // effect sees more content and scrolls to the end, and the reader is thrown
  // to the bottom of a conversation they were reading the top of. It took a
  // holdPosition() gate on every follow path to prevent, and any new path that
  // forgot to consult it reintroduced it. Here it is ordering, not a guard.
  //
  // True on both sides of the flag: under B the answer is "leave it alone",
  // which is still not "jump to the end".
  assert.notEqual(decideScrollAction(loadingOlder(true, true)), 'follow-bottom')
  assert.notEqual(decideScrollAction(loadingOlder(false, true)), 'follow-bottom')
})

test('switching conversations outranks a prepend still settling', () => {
  // The position being held belongs to a chat that is no longer on screen.
  assert.equal(decideScrollAction({ cause: 'session-changed', atBottom: false, atTop: true }), 'jump-bottom')
})

test('an unclaimed update follows the bottom only if the reader was there', () => {
  assert.equal(decideScrollAction({ cause: 'none', atBottom: true, atTop: false }), 'follow-bottom')
  assert.equal(decideScrollAction({ cause: 'none', atBottom: false, atTop: false }), 'none')
})

// ---------------------------------------------------------------------------
// "At the bottom".
// ---------------------------------------------------------------------------

test('at the end counts as at the bottom', () => {
  assert.equal(isAtBottom({ scrollTop: 1000, clientHeight: 500, scrollHeight: 1500 }), true)
})

test('within the threshold of the end still counts', () => {
  // Streaming content should keep following through the last few pixels rather
  // than unpinning the moment layout rounds against us.
  assert.equal(isAtBottom({ scrollTop: 1000 - AT_BOTTOM_THRESHOLD, clientHeight: 500, scrollHeight: 1500 }), true)
})

test('a screen above the end does not', () => {
  assert.equal(isAtBottom({ scrollTop: 500, clientHeight: 500, scrollHeight: 1500 }), false)
})

test('a conversation too short to scroll counts as at the bottom', () => {
  // Signal's clause. This is the case hit first in practice, and the one where the
  // arithmetic is degenerate — every term near zero — so it is decided by
  // construction rather than by a subtraction that could round either way.
  assert.equal(isAtBottom({ scrollTop: 0, clientHeight: 800, scrollHeight: 120 }), true)
})

test('a short conversation stays at the bottom even with a nonsense scrollTop', () => {
  // Safari drives scrollTop out of range while rubber-banding, and a
  // non-scrollable container has no valid value to report. Without the
  // explicit clause this is a subtraction on a number that means nothing.
  assert.equal(isAtBottom({ scrollTop: -60, clientHeight: 800, scrollHeight: 120 }), true)
})

test('exactly filling the viewport counts as at the bottom', () => {
  assert.equal(isAtBottom({ scrollTop: 0, clientHeight: 800, scrollHeight: 800 }), true)
})
