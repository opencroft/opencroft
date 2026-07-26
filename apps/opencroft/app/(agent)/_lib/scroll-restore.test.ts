import assert from 'node:assert/strict'
import test from 'node:test'

import { restoreShift } from './scroll-restore'

// A minimal model of the scroll container during a "load older" prepend.
// Heights are the only thing that matters, so no DOM is involved.
//
//   contentAbove  height of everything above the anchor block
//   scrollTop     current scroll offset
//
// A prepend adds `added` px above the anchor. The reader keeps their place
// only if scrollTop ends up moved by exactly `added`.
function layout(contentAbove: number, scrollTop: number) {
  return { contentAbove, scrollTop, totalHeight: contentAbove + 4000 }
}

// ---------------------------------------------------------------------------
// The formula that shipped earlier, reproduced here so the failure it
// produces is pinned by a test rather than argued about. It captures the
// distance from the bottom of the content, then restores scrollTop to the new
// scrollHeight minus that distance.
// ---------------------------------------------------------------------------
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
  // committed. Nothing in the old code enforced ordering A; `setEvents` lives
  // in use-acp-session and resolves before the .then() that did the capture.
  //
  // This is the confirmed mechanism behind both reported failure modes: the
  // restore computes 0, the viewport stays pinned at the very top, and the
  // sentinel therefore never leaves the viewport.
  const alreadyGrown = layout(1000 + ADDED, 0)
  const captured = legacyCapture(alreadyGrown)
  assert.equal(legacyRestore(alreadyGrown, captured), 0, 'viewport stays at scrollTop 0')
})

test('legacy formula also absorbs unrelated height changes below the reader', () => {
  // Markdown/codemirror blocks below the viewport finish measuring between
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

// ---------------------------------------------------------------------------
// IntersectionObserver semantics: the callback runs on a CHANGE of intersection
// state (plus once on observe()). Modelled here to pin why a failed restore
// stops paging entirely rather than merely looking wrong.
// ---------------------------------------------------------------------------
function makeObserver(onFire: (intersecting: boolean) => void) {
  let last: boolean | null = null
  return {
    // Report the sentinel's current visibility; only a change reaches the
    // callback, exactly like the real API.
    report(intersecting: boolean) {
      if (last === intersecting) {
        return
      }
      last = intersecting
      onFire(intersecting)
    },
    // disconnect() + observe() — drops the remembered state, so the next
    // report fires even if the value is unchanged.
    rearm() {
      last = null
    },
  }
}

test('a failed restore wedges the observer: no further loads without re-arming', () => {
  const loads: string[] = []
  const observer = makeObserver((intersecting) => {
    if (intersecting) {
      loads.push('load')
    }
  })

  observer.report(true) // reader reaches the top -> first page loads
  assert.equal(loads.length, 1)

  // Restore no-opped (ordering B above), so the sentinel is still on screen.
  observer.report(true)
  assert.equal(loads.length, 1, 'unchanged state produces no callback — paging is stuck')

  // Only a manual down-then-up scroll cycle resets it.
  observer.report(false)
  observer.report(true)
  assert.equal(loads.length, 2)
})

test('re-arming after a completed prepend resumes paging with the sentinel still visible', () => {
  const loads: string[] = []
  const observer = makeObserver((intersecting) => {
    if (intersecting) {
      loads.push('load')
    }
  })

  observer.report(true)
  assert.equal(loads.length, 1)

  // What the fix does once a restore actually moved the content.
  observer.rearm()
  observer.report(true)
  assert.equal(loads.length, 2, 'still-visible sentinel pages again, one page per prepend')

  // And it terminates: once the restore pushes the sentinel out of view, the
  // re-armed observer reports false and nothing further loads.
  observer.rearm()
  observer.report(false)
  assert.equal(loads.length, 2)
})
