import type { RecordsWindow } from 'agent-client/pagination'
import type { ChatEvent } from 'agent-client/types'

/** One account as a message header draws it, mirroring the server's own shape. */
export interface ResolvedAuthor {
  name: string
  avatarUrl: string | null
}

/**
 * A chat event with the accounts its messages were stamped by, resolved.
 *
 * The second app-private addition to this wire, and here for the same reason
 * as the first: agent-client stores what was delivered, and what was delivered
 * carries handles rather than names. Turning a handle into a face needs the
 * database and the space graph, which is the host's business and not a
 * package's, so the resolution is attached on the way out instead of being
 * looked up on the way in.
 *
 * IT TRAVELS WITH THE EVENT, deliberately, rather than as a directory the
 * client accumulates. A header must draw the same way wherever it appears, and
 * a shared directory makes what a message shows depend on which other messages
 * happen to have arrived — the same message with a face deep in a transcript
 * and without one at the top of it.
 *
 * Absent on every kind but `user`, and absent there too when nothing resolved.
 */
export type AuthoredChatEvent = ChatEvent & { authors?: Record<string, ResolvedAuthor> }

/**
 * A page of older history, resolved the same way the live stream is.
 *
 * Named here rather than in the package because the resolution is the host's:
 * `RecordsWindow` is what agent-client stored, this is what the app hands to a
 * reader.
 */
export interface AuthoredRecordsWindow extends Omit<RecordsWindow, 'events' | 'header'> {
  events: AuthoredChatEvent[]
  header?: { index: number; event: AuthoredChatEvent }
}

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
  header?: { index: number; event: AuthoredChatEvent }
}

export function historyEndEvent(
  startIndex: number,
  hasMore: boolean,
  header?: HistoryEndEvent['header'],
): HistoryEndEvent {
  return { kind: HISTORY_END_KIND, startIndex, hasMore, ...(header ? { header } : {}) }
}

export type AcpStreamEvent = AuthoredChatEvent | HistoryEndEvent
