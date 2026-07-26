// The "keep loading until it scrolls" decision, kept out of the component so
// the invariant is directly testable without a DOM — same reason scroll-restore
// lives beside it.
//
// Why it has to exist: scrolling is the only thing that asks for older history,
// and a view that doesn't overflow cannot be scrolled. A first page too short to
// fill the viewport therefore leaves a chat that shows a fragment and has no way
// to ask for the rest.

export interface FillState {
  // Whether the server has older history behind the current window.
  hasMore: boolean
  // Whether a page is already on its way; asking again would double-fetch.
  loading: boolean
  // The scroll container's content height and its visible height.
  scrollHeight: number
  clientHeight: number
}

// Whether another page should be fetched right now.
//
// Terminates because each fetch either makes the content taller than the
// viewport — ending it — or moves the cursor strictly backwards until the
// server reports no more. A page cannot come back empty while history remains,
// so there is no state where this returns true forever without progress.
export function shouldLoadMore(state: FillState): boolean {
  if (!state.hasMore || state.loading) {
    return false
  }
  return state.scrollHeight <= state.clientHeight
}
