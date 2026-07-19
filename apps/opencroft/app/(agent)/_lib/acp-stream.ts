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
}

export const HISTORY_END_EVENT: HistoryEndEvent = { kind: HISTORY_END_KIND }

export type AcpStreamEvent = ChatEvent | HistoryEndEvent
