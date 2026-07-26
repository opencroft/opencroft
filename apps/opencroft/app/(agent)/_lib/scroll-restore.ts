// Geometry for the "load older history" scroll restore, kept out of the
// component so the ordering semantics that broke it twice are directly
// testable without a DOM (see scroll-restore.test.ts).
//
// The problem this solves: when a page of older messages is prepended, the
// content above the reader grows, and scrollTop must move by exactly that
// growth or the viewport jumps. Two things make that harder than it looks.
//
//  1. The prepend and the render-window growth are separate React state
//     updates in separate components (`setEvents` in use-acp-session,
//     `setVisibleCount` in agent-chat), so there is no guarantee about which
//     commit the measurement runs in relative to the content landing.
//  2. Content below the reader can change height on its own (markdown and
//     codemirror blocks measure asynchronously), so any formula derived from
//     the container's total scrollHeight silently absorbs those changes too.
//
// Measuring one element that exists on both sides of the prepend, in content
// coordinates, is immune to both: the only thing that moves it is content
// inserted above it.

// Below this, "the content moved" cannot be distinguished from measurement
// noise, so the correction is skipped rather than applied.
//
// One pixel, not a smaller guess: `scrollHeight` and `clientHeight` are integers
// in the CSSOM View IDL while `scrollTop` is a double, so a position derived
// from them carries up to ±1px of rounding — and the spec pins no rounding mode,
// so engines may differ at the half-pixel. It is also why an exact comparison
// against those values never holds.
//
// Skipping small corrections is a fix in its own right, not just an
// optimisation: writing a position that is already correct is what turns
// rounding into visible jitter.
const EPSILON = 1

// A position in CONTENT coordinates — distance from the top of the scrollable
// content — derived from two viewport-relative rects and the current offset.
//
// Deliberately not `offsetTop`, which is the idiom the surveyed clients use.
// `offsetTop` is measured against the nearest POSITIONED ancestor, so it is
// only comparable with `scrollTop` when the scroll container is itself that
// ancestor. Element can rely on that because it owns its scroll node; we are
// inside Radix's viewport and own nothing about its positioning. If the offset
// parent resolves further out, the number silently becomes page-relative and
// every comparison against `scrollTop` is measuring across two coordinate
// spaces. Rects are container-relative by construction, and fractional where
// `offsetTop` is rounded to an integer.
export function contentTop(elementRectTop: number, rootRectTop: number, scrollTop: number): number {
  return elementRectTop - rootRectTop + scrollTop
}

export interface ScrollAnchor {
  // A block rendered both before and after the prepend. Its id names the turn
  // (or the user message), not a position, so a page landing mid-turn merges
  // into the block without renaming it and this still finds the element.
  id: string
  // Its offset from the top of the scrollable CONTENT (not the viewport) at
  // capture time. Content coordinates are what make this robust to the reader
  // scrolling between capture and commit — scrolling moves the viewport, not
  // the content, so it leaves this untouched.
  top: number
}

// How far scrollTop must move to keep `anchor` visually in place, given where
// that same element sits now. Null means "not yet": either the anchor is not
// in the DOM, or nothing has been inserted above it in this commit — in both
// cases the caller should keep the capture and wait for a later commit rather
// than consuming it against a layout that has not changed.
export function restoreShift(anchor: ScrollAnchor, currentTop: number | null): number | null {
  if (currentTop === null) {
    return null
  }
  const shift = currentTop - anchor.top
  return Math.abs(shift) < EPSILON ? null : shift
}

// A single correction cannot be right, which is why the one that shipped kept
// being nearly right. Markdown, code blocks and images above the reader finish
// laying out AFTER the commit that introduced them, so the height added above
// keeps growing for several frames. Measure-correct-forget lands on the first
// of those frames and every later one moves the reader.
//
// So the position is held: the same invariant is re-asserted on every commit
// and every resize until the content above stops changing. What follows is the
// arithmetic for one step of that hold.

// How long a hold may keep correcting. This is a valve, not the expected exit —
// quiescence is. It exists so that a row which animates forever cannot hold a
// correction open forever, and a hold that ends this way is reported rather
// than absorbed, because it means something above the reader never settled.
export const HOLD_DEADLINE_MS = 500

export interface HoldState {
  // Primary: a block rendered on both sides of the prepend. Only content
  // inserted above it moves it, which is what makes it immune to the async
  // measuring happening everywhere else in the list.
  anchor: ScrollAnchor | null
  // Fallback, used only when the anchor block is not in the DOM: the distance
  // from the reader to the end of the content. Every surveyed client preserves
  // this one, and it needs no element — but it charges height changes BELOW the
  // reader (a streaming reply growing) to the correction, so it is second
  // choice rather than the invariant.
  bottomDistance: number
}

export interface HoldGeometry {
  // Where the anchor block sits in content coordinates now, or null if it is
  // no longer rendered.
  anchorTop: number | null
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

// One step of a held position: how far to scroll now, and the state to hold
// from next time.
//
// The two baselines behave differently on purpose, and getting this backwards
// double-applies every correction:
//
//   * The anchor MUST be re-baselined. It is measured in content coordinates,
//     and scrolling moves the viewport rather than the content — so after the
//     correction the anchor still reads as displaced, and a second step would
//     apply the same shift again.
//   * `bottomDistance` MUST NOT be. It is the invariant itself: the correction
//     is what restores it, so the captured value stays the target.
export function holdStep(hold: HoldState, now: HoldGeometry): { shift: number | null; hold: HoldState } {
  if (hold.anchor && now.anchorTop !== null) {
    const shift = restoreShift(hold.anchor, now.anchorTop)
    if (shift === null) {
      return { shift: null, hold }
    }
    return { shift, hold: { ...hold, anchor: { id: hold.anchor.id, top: now.anchorTop } } }
  }
  const distance = now.scrollHeight - now.scrollTop - now.clientHeight
  const shift = distance - hold.bottomDistance
  return Math.abs(shift) < EPSILON ? { shift: null, hold } : { shift, hold }
}

// Measured from the first applied correction, not from when the fetch started:
// a slow request must not spend the budget that exists to bound how long the
// content takes to settle.
export function holdExpired(settlingSince: number, now: number): boolean {
  return now - settlingSince >= HOLD_DEADLINE_MS
}
