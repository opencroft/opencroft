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
  // Present only when the newest turn itself was too large to send in full —
  // a turn with a huge number of tool calls can blow up the initial load the
  // same way a huge transcript can. A second, independent cursor for "load
  // older tool calls in this turn" (see getSessionTurnRecordsPageLocal),
  // separate from `startIndex`/`hasMore` above, which page whole earlier turns.
  trimmedTurn?: { turnStart: number; startIndex: number; hasMore: boolean }
}

export function historyEndEvent(
  startIndex: number,
  hasMore: boolean,
  trimmedTurn?: HistoryEndEvent['trimmedTurn'],
): HistoryEndEvent {
  return { kind: HISTORY_END_KIND, startIndex, hasMore, ...(trimmedTurn ? { trimmedTurn } : {}) }
}

export type AcpStreamEvent = ChatEvent | HistoryEndEvent
