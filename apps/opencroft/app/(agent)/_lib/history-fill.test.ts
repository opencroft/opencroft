import assert from 'node:assert/strict'
import test from 'node:test'

import { type FillState, shouldFill } from './history-fill'

const VIEWPORT = 800

const at = (scrollTop: number, firstBlockOffsetTop = 0): FillState => ({
  hasMore: true,
  loading: false,
  geometry: { scrollTop, clientHeight: VIEWPORT, firstBlockOffsetTop },
})

// ── the four guard intents carried over from the predicate this replaces ────
// They are the regression net for the controller rewrite: each is a case a
// shipping implementation had to learn, and none is expressed by the geometry.

test('a short history ends exhausted rather than looping', () => {
  // Content never fills the viewport, so the geometry says "fill" forever. Only
  // the server saying there is nothing left stops it.
  let state = at(0)
  let fetches = 0
  while (shouldFill(state)) {
    fetches += 1
    assert.ok(fetches < 50, 'must terminate')
    // Each page adds nothing measurable, as collapsed rows can.
    state = { ...state, hasMore: fetches < 3 }
  }
  assert.equal(state.hasMore, false)
  assert.equal(fetches, 3)
})

test('a page that adds no height still terminates', () => {
  const stuck: FillState = { ...at(0), hasMore: false }
  assert.equal(shouldFill(stuck), false)
})

test('never asks while a fetch is in flight', () => {
  assert.equal(shouldFill({ ...at(0), loading: true }), false)
})

test('never asks once history is exhausted, however much room there is', () => {
  assert.equal(shouldFill({ ...at(0), hasMore: false }), false)
})

// ── the level check itself ──────────────────────────────────────────────────

test('fills while the reader is within one viewport of the top', () => {
  assert.equal(shouldFill(at(VIEWPORT - 1)), true)
})

test('rests once the reader is more than a viewport from the top', () => {
  assert.equal(shouldFill(at(VIEWPORT + 1)), false)
})

test('an empty list fills — there is room and nothing to measure against', () => {
  assert.equal(shouldFill({ hasMore: true, loading: false, geometry: null }), true)
})

test('content shorter than the viewport fills, with no special case for it', () => {
  // The reason the separate short-history predicate is gone: at the top of a
  // short list both terms are near zero, so the level check already holds.
  assert.equal(shouldFill(at(0)), true)
})

test('measures from the first real block, so the loading indicator cannot feed itself', () => {
  // Rendering the indicator pushes the first block down. Measured from the
  // indicator the condition would stay true because it is showing, which is
  // the documented way this becomes infinite pagination.
  const indicatorHeight = 40
  const farFromTop = VIEWPORT * 2
  assert.equal(shouldFill(at(farFromTop, indicatorHeight)), false)
})

test('the trigger is relative to the first block, not to absolute scroll position', () => {
  // Same scroll offset, different content above: only the distance between
  // them decides, which is what keeps this correct after a prepend.
  assert.equal(shouldFill(at(1000, 900)), true)
  assert.equal(shouldFill(at(1000, 100)), false)
})
