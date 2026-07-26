import assert from 'node:assert/strict'
import test from 'node:test'

import { AT_BOTTOM_THRESHOLD, decideScrollAction, isAtBottom, LOAD_OLDER_KEEPS_POSITION } from './scroll-intent'

// ---------------------------------------------------------------------------
// The precedence. These are the pairs that used to be separate effects, and
// each test names the failure that pair actually produced.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Both sides of the product decision, so flipping the constant is a one-line
// change with the behaviour on each side already written down.
// ---------------------------------------------------------------------------

test('A: the reader keeps their place, and the new batch lands above them', () => {
  assert.equal(decideScrollAction('loading-older', false, true), 'hold-position')
  assert.equal(decideScrollAction('loading-older', true, true), 'hold-position')
})

test('B: the position is left alone, so the view lands on the oldest new message', () => {
  assert.equal(decideScrollAction('loading-older', false, false), 'none')
  // Still not the bottom, even though the reader was at the bottom when they
  // pressed it — which is possible in a conversation short enough that the
  // button and the end are on screen together. "There is more content now" is
  // never a reason to jump to the end when the content arrived above them.
  assert.equal(decideScrollAction('loading-older', true, false), 'none')
})

test('the default matches the shipped constant', () => {
  assert.equal(decideScrollAction('loading-older', false), LOAD_OLDER_KEEPS_POSITION ? 'hold-position' : 'none')
})

test('a prepend outranks following the bottom', () => {
  // The old shape: a "load older" prepend grows the content, the bottom-follow
  // effect sees more content and scrolls to the end, and the reader is thrown
  // to the bottom of a conversation they were reading the top of. It took a
  // holdPosition() gate on every follow path to prevent, and any new path that
  // forgot to consult it reintroduced it. Here it is ordering, not a guard.
  assert.equal(decideScrollAction('loading-older', true), 'hold-position')
})

test('switching conversations outranks a prepend still settling', () => {
  // The position being held belongs to a chat that is no longer on screen.
  assert.equal(decideScrollAction('session-changed', false), 'jump-bottom')
})

test('an unclaimed update follows the bottom only if the reader was there', () => {
  assert.equal(decideScrollAction('none', true), 'follow-bottom')
  assert.equal(decideScrollAction('none', false), 'none')
})

test('the reader having scrolled up does not stop a prepend being held', () => {
  // Holding is *for* the reader who scrolled up; it must not be conditional on
  // them being at the bottom, which they never are when paging back.
  assert.equal(decideScrollAction('loading-older', false), 'hold-position')
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
