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
