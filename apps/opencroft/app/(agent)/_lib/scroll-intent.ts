// The one decision the chat scroller makes per commit, kept out of the
// component so the precedence between its cases is directly testable.
//
// The rule is: decide from the REASON the update happened, once, and apply it
// in one place — never by inspecting geometry afterwards and inferring what was
// wanted. The controller used to be several effects that each measured the DOM
// and each wrote scrollTop (follow-the-bottom on a content key, follow-the-
// bottom from a ResizeObserver, jump-to-bottom on session change, and a restore
// after a prepend). Every failure it had was two of them acting on the same
// commit and disagreeing. One enum cannot disagree with itself, so the guards
// that used to hold them apart — and could be forgotten one at a time — stop
// being needed rather than being made more careful.

// How close to the end still counts as "following the conversation". Wide
// enough to survive the ±1px of rounding the CSSOM View IDL allows between
// scrollTop (a double) and scrollHeight/clientHeight (integers).
export const AT_BOTTOM_THRESHOLD = 32

// Where the reader ends up after they press "load older messages".
//
// The button sits at the top of the transcript, so reaching it means the reader
// is already at the top — which is the only state a click can happen in, and it
// makes the two options concrete rather than a matter of taste:
//
//  * true — their place is kept. What they were reading stays put and the new
//    batch appears above it, so reading back through history stays one
//    continuous upward motion. The cost is that the click looks like it did
//    nothing: the newly loaded messages are above the viewport until they
//    scroll into them.
//  * false — the position is left alone, so the viewport lands on the OLDEST
//    message of the new batch. Immediate feedback, at the cost of moving the
//    reader back through the transcript and reversing the direction they were
//    reading in.
//
// Product decision, not a technical one; this is the one line that flips it,
// and both sides are covered by tests.
export const LOAD_OLDER_KEEPS_POSITION = true

// Why the DOM is about to change. Set by whatever caused it, at the moment it
// causes it; 'none' means an ordinary update nobody claimed.
export type ScrollCause = 'none' | 'session-changed' | 'loading-older'

export type ScrollAction = 'none' | 'jump-bottom' | 'follow-bottom' | 'hold-position'

export interface BottomGeometry {
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

// Whether the reader is at the end of the conversation, and so should be
// carried along by new content.
export function isAtBottom(geometry: BottomGeometry): boolean {
  // A conversation too short to scroll counts as "at the end" outright, rather
  // than arriving there through arithmetic on a scrollTop that has no room to
  // vary. Signal states this case separately for the same reason: it is the
  // one where the numbers are degenerate (every term near zero) and so the one
  // where a rounding or overscroll artefact can flip the answer. It is also
  // the case we are currently inconsistent in.
  if (geometry.scrollHeight <= geometry.clientHeight) {
    return true
  }
  return geometry.scrollHeight - geometry.scrollTop - geometry.clientHeight <= AT_BOTTOM_THRESHOLD
}

// `atBottom` describes where the reader was BEFORE this commit — it is read
// from state maintained by the scroll listener, not measured after the content
// landed, because by then the new content has already changed the answer.
export function decideScrollAction(
  cause: ScrollCause,
  atBottom: boolean,
  keepsPosition: boolean = LOAD_OLDER_KEEPS_POSITION,
): ScrollAction {
  switch (cause) {
    // Switching conversations always lands at the end, whatever else was in
    // flight — the position being held belonged to a chat that is now gone.
    case 'session-changed':
      return 'jump-bottom'
    // A prepend outranks following the bottom either way. The content grew
    // ABOVE the reader, so "there is more content now" is never a reason to
    // move to the end — that was the failure the old holdPosition() gate
    // existed to prevent, expressed here as ordering instead of a guard. The
    // flag only chooses between holding the position and leaving it alone.
    case 'loading-older':
      return keepsPosition ? 'hold-position' : 'none'
    default:
      return atBottom ? 'follow-bottom' : 'none'
  }
}
