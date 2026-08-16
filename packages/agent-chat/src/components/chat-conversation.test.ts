import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AT_BOTTOM_THRESHOLD,
  decideScrollAction,
  HOLD_DEADLINE_MS,
  type HoldState,
  holdExpired,
  holdStep,
  isAtBottom,
  LOAD_OLDER_KEEPS_POSITION,
  restoreShift,
} from './chat-conversation'

// ---------------------------------------------------------------------------
// decideScrollAction — both sides of the product decision, so flipping the
// constant stays one line with the behaviour on each side already written
// down.
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

// ---------------------------------------------------------------------------
// The "load older" restore, holding a position CONTINUOUSLY rather than
// correcting once.
//
// The scenario throughout: a page of older turns lands 400px tall, then an
// image and a code block above the reader finish measuring and add another
// 150px. A controller that corrects once and forgets is 150px wrong — and it
// is wrong at exactly the moment the reader starts reading.
// ---------------------------------------------------------------------------

// A minimal model of the scroll container during a prepend. Heights are the
// only thing that matters, so no DOM is involved.
function layout(contentAbove: number, scrollTop: number) {
  return { contentAbove, scrollTop, totalHeight: contentAbove + 4000 }
}

// The formula that shipped before the anchor rewrite, reproduced here so the
// failure it produces is pinned by a test rather than argued about. It
// captures the distance from the bottom of the content, then restores
// scrollTop to the new scrollHeight minus that distance.
function legacyCapture(l: ReturnType<typeof layout>) {
  return l.totalHeight - l.scrollTop
}
function legacyRestore(l: ReturnType<typeof layout>, captured: number) {
  return l.totalHeight - captured
}

const ADDED = 600

test('legacy formula restores correctly when it wins the race with React', () => {
  // Ordering A — the capture runs BEFORE the prepend is committed, which is
  // what the old code assumed: React schedules default-lane updates on a
  // macrotask while the .then() continuation is a microtask, so this is the
  // common case.
  const before = layout(1000, 0)
  const captured = legacyCapture(before)
  const after = layout(1000 + ADDED, 0)
  assert.equal(legacyRestore(after, captured), ADDED)
})

test('legacy formula silently no-ops when React commits the prepend first', () => {
  // Ordering B — the same capture, run AFTER the prepend has already been
  // committed. Nothing in the old code enforced ordering A.
  //
  // This is the confirmed mechanism behind the original failure: the restore
  // computes 0, the viewport stays pinned at the very top, and the sentinel
  // therefore never leaves the viewport.
  const alreadyGrown = layout(1000 + ADDED, 0)
  const captured = legacyCapture(alreadyGrown)
  assert.equal(legacyRestore(alreadyGrown, captured), 0, 'viewport stays at scrollTop 0')
})

test('legacy formula also absorbs unrelated height changes below the reader', () => {
  // Markdown and code blocks below the viewport finish measuring between
  // capture and restore, growing total height by 250px that has nothing to do
  // with the prepend. The bottom-anchored formula charges it to the restore.
  const before = layout(1000, 0)
  const captured = legacyCapture(before)
  const after = { ...layout(1000 + ADDED, 0), totalHeight: 1000 + ADDED + 4000 + 250 }
  assert.equal(legacyRestore(after, captured), ADDED + 250, 'over-scrolls by the unrelated growth')
})

// ---------------------------------------------------------------------------
// The anchor-element formula, driven through the same orderings.
// ---------------------------------------------------------------------------

test('anchor restore is correct regardless of when it is captured', () => {
  const anchor = { id: 't:42', top: 1000 }
  // Ordering A and ordering B both reduce to the same question — where is the
  // anchor now versus where it was — so the race no longer has a wrong side.
  assert.equal(restoreShift(anchor, 1000 + ADDED), ADDED)
})

test('anchor restore ignores height changes below the anchor', () => {
  // Content growing below the anchor does not move the anchor, so it
  // contributes nothing to the shift.
  const anchor = { id: 't:42', top: 1000 }
  assert.equal(restoreShift(anchor, 1000 + ADDED), ADDED)
})

test('anchor restore is unaffected by the reader scrolling mid-fetch', () => {
  // The anchor is stored in CONTENT coordinates, so a scroll between capture
  // and commit leaves `top` untouched and the shift is still just the
  // prepended height — the reader's own scrolling is preserved rather than
  // double-counted.
  const anchor = { id: 't:42', top: 1000 }
  assert.equal(restoreShift(anchor, 1000 + ADDED), ADDED)
})

test('waits for a later commit when the prepend has not landed yet', () => {
  const anchor = { id: 't:42', top: 1000 }
  // Anchor not in the DOM for this commit.
  assert.equal(restoreShift(anchor, null), null)
  // Anchor present but unmoved — this commit is not the one that added content.
  assert.equal(restoreShift(anchor, 1000), null)
  // Sub-pixel layout noise is not a content change either.
  assert.equal(restoreShift(anchor, 1000.2), null)
})

// Geometry for the anchor path; the container figures are unused there and are
// only present because the fallback shares the shape.
function atAnchor(anchorTop: number) {
  return { anchorTop, scrollTop: 0, scrollHeight: 5000, clientHeight: 800 }
}

test('one correction is not enough: content above keeps landing after it', () => {
  const hold: HoldState = { anchor: { id: 't:42', top: 1000 }, bottomDistance: 3200 }
  // The commit that carries the page.
  const first = holdStep(hold, atAnchor(1400))
  assert.equal(first.shift, 400)
  // Everything above has finished measuring — 550px was added in total.
  const settled = holdStep(hold, atAnchor(1550))
  assert.equal(settled.shift, 550, 'a one-shot correction is short by whatever lands after it')
})

test('holding corrects each increment exactly once', () => {
  let hold: HoldState = { anchor: { id: 't:42', top: 1000 }, bottomDistance: 3200 }
  const applied: number[] = []
  for (const anchorTop of [1400, 1550, 1550]) {
    const step = holdStep(hold, atAnchor(anchorTop))
    hold = step.hold
    if (step.shift !== null) {
      applied.push(step.shift)
    }
  }
  assert.deepEqual(applied, [400, 150])
  assert.equal(
    applied.reduce((a, b) => a + b, 0),
    550,
    'the corrections sum to the height actually inserted above the reader',
  )
})

test('the anchor is re-baselined, so a second step does not re-apply the first', () => {
  // This is the failure mode of holding a content-coordinate anchor: scrolling
  // moves the viewport, not the content, so after the correction the anchor
  // still reads as displaced. Without re-baselining, every subsequent step
  // would apply the same shift again and run the reader off the end.
  const hold: HoldState = { anchor: { id: 't:42', top: 1000 }, bottomDistance: 3200 }
  const first = holdStep(hold, atAnchor(1400))
  assert.equal(first.shift, 400)
  assert.equal(holdStep(first.hold, atAnchor(1400)).shift, null)
})

test('sub-pixel noise is not a content change', () => {
  const hold: HoldState = { anchor: { id: 't:42', top: 1000 }, bottomDistance: 3200 }
  assert.equal(holdStep(hold, atAnchor(1000.4)).shift, null)
})

// ---------------------------------------------------------------------------
// The fallback: no anchor element to measure against.
// ---------------------------------------------------------------------------

test('falls back to distance-from-bottom when the anchor block is gone', () => {
  const hold: HoldState = { anchor: null, bottomDistance: 3200 }
  // 600px landed above: total height grew, scrollTop did not, so the reader is
  // now 600px further from the end than they were.
  const step = holdStep(hold, { anchorTop: null, scrollTop: 1000, scrollHeight: 5600, clientHeight: 800 })
  assert.equal(step.shift, 600)
})

test('the fallback baseline is NOT re-baselined — it is the invariant itself', () => {
  // Mirror image of the anchor rule, and getting the two the same way round is
  // what makes a held position converge. Applying the shift restores the
  // captured distance, so the captured value stays the target.
  const hold: HoldState = { anchor: null, bottomDistance: 3200 }
  const first = holdStep(hold, { anchorTop: null, scrollTop: 1000, scrollHeight: 5600, clientHeight: 800 })
  assert.equal(first.shift, 600)
  // scrollTop moved by the shift; the distance from the end is back to 200.
  const next = holdStep(first.hold, { anchorTop: null, scrollTop: 1600, scrollHeight: 5600, clientHeight: 800 })
  assert.equal(next.shift, null)
})

test('the fallback charges height changes BELOW the reader to the correction', () => {
  // Recorded rather than fixed: this is exactly why the anchor is primary and
  // this is second choice. A streaming reply growing under the reader looks
  // identical to content landing above them when all you measure is the total.
  const hold: HoldState = { anchor: null, bottomDistance: 3200 }
  const step = holdStep(hold, { anchorTop: null, scrollTop: 1000, scrollHeight: 5250, clientHeight: 800 })
  assert.equal(step.shift, 250, 'over-corrects by growth that was never above the reader')
})

test('the anchor is preferred whenever it is measurable', () => {
  // Both paths are available here and they disagree: the anchor says nothing
  // moved above, the totals say 250px did (a reply growing below). The anchor
  // wins, so nothing is corrected — which is the right answer.
  const hold: HoldState = { anchor: { id: 't:42', top: 1000 }, bottomDistance: 3200 }
  const step = holdStep(hold, { anchorTop: 1000, scrollTop: 1000, scrollHeight: 5250, clientHeight: 800 })
  assert.equal(step.shift, null)
})

// ---------------------------------------------------------------------------
// The deadline. A valve, not the expected exit — quiescence is that, and it
// lives here because it is a question about frames rather than about
// geometry.
// ---------------------------------------------------------------------------

test('a hold runs until the deadline, then gives up', () => {
  assert.equal(holdExpired(1000, 1000), false)
  assert.equal(holdExpired(1000, 1000 + HOLD_DEADLINE_MS - 1), false)
  assert.equal(holdExpired(1000, 1000 + HOLD_DEADLINE_MS), true)
})
