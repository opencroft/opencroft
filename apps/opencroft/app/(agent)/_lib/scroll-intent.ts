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

// How close to the start of the content still counts as "hasn't moved since
// pressing the button". The same tolerance as the bottom edge and for the same
// reason: it absorbs the ±1px of rounding plus a nudge, while staying too
// narrow to call a reader who has genuinely scrolled away "still at the top".
export const AT_TOP_THRESHOLD = 32

// Where the reader ends up after they press "load older messages". A design
// call, and this is the one line that flips it:
//
//  * false (shipped) — the position is left alone, so the newly loaded
//    messages appear where the reader is looking and the click visibly did
//    something.
//  * true — their place is kept instead: what they were reading stays put and
//    the new batch lands above it, so reading back through history is one
//    continuous upward motion. The cost is that the click looks inert until
//    they scroll up into what arrived.
//
// Product decision, not a technical one. Both sides are covered by tests so the
// flip stays a one-line change.
export const LOAD_OLDER_KEEPS_POSITION = false

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

export interface ScrollSituation {
  cause: ScrollCause
  // Where the reader was BEFORE this commit — read from state the scroll
  // listener maintains, not measured after the content landed, because by then
  // the new content has already changed the answer.
  atBottom: boolean
  // Whether they are still at the start of the content, i.e. still looking at
  // the place the button was when they pressed it.
  atTop: boolean
}

// Named fields rather than positional arguments: three of the four inputs are
// booleans, and getting two of them the wrong way round is the kind of mistake
// that type-checks and then misbehaves only in one branch.
export function decideScrollAction(
  situation: ScrollSituation,
  keepsPosition: boolean = LOAD_OLDER_KEEPS_POSITION,
): ScrollAction {
  switch (situation.cause) {
    // Switching conversations always lands at the end, whatever else was in
    // flight — the position being held belonged to a chat that is now gone.
    case 'session-changed':
      return 'jump-bottom'
    // A prepend outranks following the bottom either way. The content grew
    // ABOVE the reader, so "there is more content now" is never a reason to
    // move to the end — that was the failure the old holdPosition() gate
    // existed to prevent, expressed here as ordering instead of a guard.
    case 'loading-older':
      // Under B, doing nothing IS the behaviour — but only while the reader is
      // still where the button was. Leaving the position alone is what puts the
      // new messages in front of them; correcting would push those messages
      // straight back out of sight, which is the whole thing B rejects.
      //
      // If they have scrolled away since pressing — a slow fetch, a keyboard
      // press followed by a scroll — doing nothing is no longer a reveal, it is
      // the content lurching under them by the height of everything that
      // arrived. So the correction is not vestigial under B; it is what covers
      // the case where B's reasoning stops applying.
      return keepsPosition || !situation.atTop ? 'hold-position' : 'none'
    default:
      return situation.atBottom ? 'follow-bottom' : 'none'
  }
}
