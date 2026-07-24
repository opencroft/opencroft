import type { EventsWindow } from 'agent-client/pagination'
import type { ChatEvent } from 'agent-client/types'
import { useCallback, useRef, useState } from 'react'

export interface UsePaginatedHistoryOptions {
  // Fetches the page of history events immediately before `beforeIndex` — a
  // previous window's `startIndex` (the tail window's own `startIndex` for the
  // first call). Wired by the host to its own history source, e.g. a server fn
  // backed by agent-client's `getEventsWindow`.
  fetchPage: (beforeIndex: number) => Promise<EventsWindow>
}

// The "load older on scroll-up" half of a paginated chat transcript: a host
// that only streams/renders a bounded tail window (instead of a session's full
// history; sending the full replay to the
// browser on every open/reconnect was the actual cause of a server OOM) wires
// this up to fetch and prepend earlier pages as the user scrolls back. Doesn't
// know about SSE, EventSource, or agent-client internals — the host supplies
// `fetchPage` and calls `reset()` once it knows the tail window's own cursor
// (e.g. from a stream's "history done" marker), then `loadOlder()` from its
// scroll handler, prepending the returned events ahead of what it already has.
export function usePaginatedHistory({ fetchPage }: UsePaginatedHistoryOptions) {
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const cursorRef = useRef<number | null>(null)

  // Call once the host knows where its currently-loaded window starts (e.g.
  // the tail window's startIndex) — on initial load and on every reconnect,
  // since a fresh SSE connection re-sends a fresh tail and any earlier cursor
  // no longer applies.
  const reset = useCallback((startIndex: number, more: boolean) => {
    cursorRef.current = startIndex
    setHasMore(more)
  }, [])

  const loadOlder = useCallback(async (): Promise<ChatEvent[]> => {
    if (loadingMore || !hasMore || cursorRef.current === null) {
      return []
    }
    setLoadingMore(true)
    try {
      const page = await fetchPage(cursorRef.current)
      cursorRef.current = page.startIndex
      setHasMore(page.hasMore)
      return page.events
    } finally {
      setLoadingMore(false)
    }
  }, [fetchPage, hasMore, loadingMore])

  return { hasMore, loadingMore, reset, loadOlder }
}
