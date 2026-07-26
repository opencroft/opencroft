import assert from 'node:assert/strict'
import test from 'node:test'

import { type FillState, shouldFill } from './history-fill'
import { contentTop } from './scroll-restore'

const VIEWPORT = 800

const at = (scrollTop: number, firstBlockContentTop = 0): FillState => ({
  hasMore: true,
  loading: false,
  geometry: { scrollTop, clientHeight: VIEWPORT, firstBlockContentTop },
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

test('the first block is measured in the container coordinates, not the page ones', () => {
  // The failure this pins: `offsetTop` resolves against the nearest POSITIONED
  // ancestor. Inside Radix's viewport nothing guarantees that is the scroll
  // container, so it can silently carry the chat's whole page offset while
  // scrollTop stays container-relative — two origins in one subtraction.
  //
  // Here the chat sits 1200px down the page, the reader is 1000px into an
  // 800px viewport, and the first block is at the very start of the content.
  const PAGE_OFFSET = 1200
  const scrollTop = 1000
  const viewportRectTop = 500
  const firstBlockRectTop = viewportRectTop - scrollTop

  const measured = contentTop(firstBlockRectTop, viewportRectTop, scrollTop)
  assert.equal(measured, 0, 'rects put the first block at the start of the content')

  const state = at(scrollTop, measured)
  assert.equal(shouldFill(state), false, 'more than a viewport from the start: nothing is due')

  // The same predicate fed the page-relative figure instead. It fires — and
  // because the offset does not shrink as pages land, it keeps firing, paging
  // to the beginning of history on its own. On a short chat that looks like it
  // works, which is why it needs a test rather than a try.
  assert.equal(shouldFill(at(scrollTop, PAGE_OFFSET)), true)
})
