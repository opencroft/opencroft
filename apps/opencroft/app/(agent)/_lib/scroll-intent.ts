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
export function decideScrollAction(cause: ScrollCause, atBottom: boolean): ScrollAction {
  switch (cause) {
    // Switching conversations always lands at the end, whatever else was in
    // flight — the position being held belonged to a chat that is now gone.
    case 'session-changed':
      return 'jump-bottom'
    // A prepend outranks following the bottom. The content grew ABOVE the
    // reader, so "there is more content now" is not a reason to move to the
    // end; doing so is precisely the failure the old holdPosition() gate
    // existed to prevent, expressed here as ordering instead of a guard.
    case 'loading-older':
      return 'hold-position'
    default:
      return atBottom ? 'follow-bottom' : 'none'
  }
}
