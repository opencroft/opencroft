import type { ChatEvent } from 'agent-client/types'

// Wire-protocol addition private to the core app's SSE route (acp.stream.ts)
// and its consumer (use-acp-session.ts). agent-client's `subscribe` replays a
// session's stored history synchronously before returning, so the route can
// append this marker right after subscribing and know every historical
// ChatEvent has already been enqueued ahead of it. It is NOT a ChatEvent and
// must never be produced by agent-client — packages stay unaware of how the
// core app batches history on the wire.
export const HISTORY_END_KIND = 'history_end' as const

export interface HistoryEndEvent {
  kind: typeof HISTORY_END_KIND
  // The replayed window's cursor: pass back as `beforeIndex` to fetch the page
  // immediately before it (see getSessionHistoryPageLocal). `hasMore` is false
  // once startIndex is 0 — the whole session has been sent, nothing left to
  // page in. A cold-opened long-history chat now only ever receives a bounded
  // tail here instead of the full transcript.
  startIndex: number
  hasMore: boolean
  // The `user` event of the turn the window starts inside, when it sits above
  // `startIndex` — so a partially-loaded turn still renders with its question.
  // Kept out of the replayed events deliberately (see RecordsWindow): the
  // client places it itself, which is what stops it repeating once paging
  // moves further up inside the same turn.
  header?: { index: number; event: ChatEvent }
}

export function historyEndEvent(
  startIndex: number,
  hasMore: boolean,
  header?: HistoryEndEvent['header'],
): HistoryEndEvent {
  return { kind: HISTORY_END_KIND, startIndex, hasMore, ...(header ? { header } : {}) }
}

export type AcpStreamEvent = ChatEvent | HistoryEndEvent
