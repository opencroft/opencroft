import assert from 'node:assert/strict'
import test from 'node:test'

import { type FillState, shouldLoadMore } from './history-fill'

const VIEWPORT = 800

// Drives the real decision against a model of the loading it triggers, so the
// termination claim is exercised rather than asserted. `pageHeight` is what one
// page adds; `pages` is how many the server still has.
function fill(options: { pages: number; pageHeight: number; startHeight?: number }): {
  fetches: number
  state: FillState
} {
  let state: FillState = {
    hasMore: options.pages > 0,
    loading: false,
    scrollHeight: options.startHeight ?? 0,
    clientHeight: VIEWPORT,
  }
  let remaining = options.pages
  let fetches = 0
  while (shouldLoadMore(state)) {
    fetches += 1
    assert.ok(fetches < 100, 'the fill loop must terminate')
    remaining -= 1
    state = { ...state, scrollHeight: state.scrollHeight + options.pageHeight, hasMore: remaining > 0 }
  }
  return { fetches, state }
}

test('keeps fetching until the transcript is taller than the viewport', () => {
  const { fetches, state } = fill({ pages: 50, pageHeight: 200 })
  assert.equal(fetches, 5) // 5 x 200 > 800
  assert.ok(state.scrollHeight > state.clientHeight)
})

test('a history shorter than one viewport ends exhausted rather than looping', () => {
  // The case with no scrollbar at the end: it must stop because the server ran
  // out, not because anything measured a scroll position.
  const { state } = fill({ pages: 3, pageHeight: 50 })
  assert.equal(state.hasMore, false)
  assert.ok(state.scrollHeight <= state.clientHeight, 'still unscrollable — and that is fine')
  assert.equal(shouldLoadMore(state), false)
})

test('a page that adds no height still terminates, on exhaustion', () => {
  // Collapsed tool rows can add almost nothing; the loop must not depend on
  // each page making the content taller.
  const { fetches, state } = fill({ pages: 4, pageHeight: 0 })
  assert.equal(fetches, 4)
  assert.equal(state.hasMore, false)
})

test('never asks while a page is already in flight', () => {
  const inFlight: FillState = { hasMore: true, loading: true, scrollHeight: 0, clientHeight: VIEWPORT }
  assert.equal(shouldLoadMore(inFlight), false)
})

test('never asks once history is exhausted, however short the view', () => {
  const done: FillState = { hasMore: false, loading: false, scrollHeight: 10, clientHeight: VIEWPORT }
  assert.equal(shouldLoadMore(done), false)
})

test('stops as soon as the view can scroll, leaving the rest to the reader', () => {
  const scrollable: FillState = { hasMore: true, loading: false, scrollHeight: 801, clientHeight: VIEWPORT }
  assert.equal(shouldLoadMore(scrollable), false)
})

test('content exactly filling the viewport still counts as unscrollable', () => {
  // Equal heights produce no overflow, so no scroll gesture is possible — the
  // boundary has to fetch rather than rest.
  const exact: FillState = { hasMore: true, loading: false, scrollHeight: VIEWPORT, clientHeight: VIEWPORT }
  assert.equal(shouldLoadMore(exact), true)
})
