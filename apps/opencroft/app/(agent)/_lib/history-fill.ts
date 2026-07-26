// Whether more history should be fetched right now, kept out of the component
// so the guards are directly testable — the same reason scroll-restore lives
// beside it.
//
// This is a LEVEL check — "is the reader within a viewport of the top?" — asked
// repeatedly, rather than an edge trigger that fires on a transition. An
// IntersectionObserver only queues an entry when intersection *changes*, so a
// sentinel that is already in view produces nothing further, and one that our
// own correction moves out of view within the same frame produces nothing at
// all. Neither is fixable with thresholds; asking the question again is.

export interface FillGeometry {
  scrollTop: number
  clientHeight: number
  // Offset of the first REAL block. The loading indicator is excluded: it is
  // itself content, so measuring from it means rendering it satisfies the
  // condition that produced it, which paginates forever.
  firstBlockOffsetTop: number
}

export interface FillState {
  // Server-reported. Termination is always this, never geometry — geometry
  // says "there is room", only the server knows there is nothing left.
  hasMore: boolean
  // A fetch is already in flight; asking again would double-fetch.
  loading: boolean
  // Absent when nothing is rendered yet.
  geometry: FillGeometry | null
}

// Trigger a viewport ahead of the top rather than at the edge. Reaching scroll
// offset zero with history still behind it is the hard case — there is no room
// left to correct into, and browser anchoring is defined not to act there — so
// the fetch is asked for while there is still headroom.
export function shouldFill(state: FillState): boolean {
  if (!state.hasMore || state.loading) {
    return false
  }
  // Nothing rendered: there is certainly room, and no anchor to measure from.
  if (!state.geometry) {
    return true
  }
  const { scrollTop, clientHeight, firstBlockOffsetTop } = state.geometry
  // Also covers "the content doesn't fill the viewport" by construction: with
  // little content both sides are near zero, so the comparison holds and it
  // keeps filling until it doesn't. No separate short-history rule is needed.
  return scrollTop - firstBlockOffsetTop < clientHeight
}
