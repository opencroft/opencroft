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
  // How many events at the FRONT of this replay are live-state snapshots
  // (modes, the queue, the plan, usage…) rather than entries of the log —
  // agent-client prepends them so a windowed reader is not blind to state that
  // last changed above the cut.
  //
  // It is here because the two uses of `startIndex` are not the same number.
  // As a PAGING cursor it names the first logged event, which is what
  // `beforeIndex` must be given. As a NUMBERING origin it is wrong by exactly
  // this count, because the client's first received event is a snapshot that
  // has no position in the log at all — so numbering from it puts every real
  // event too high, and an edit or a fork naming a turn by its position
  // reaches a different one, or nothing. Absent means zero, which is what
  // every frame written before this existed meant.
  snapshotPrefix?: number
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
  snapshotPrefix = 0,
): HistoryEndEvent {
  // `satisfies` for the same reason the other conditional spreads carry one:
  // the return annotation checks the keys written here and cannot reach inside
  // a spread, so a misspelling would compile and the header would arrive
  // without the authors it now carries. This frame and the history page's
  // header are the same object on two paths, and a guard on one of them only
  // is how the two come to differ silently.
  return {
    kind: HISTORY_END_KIND,
    startIndex,
    hasMore,
    snapshotPrefix,
    ...(header ? ({ header } satisfies Pick<HistoryEndEvent, 'header'>) : {}),
  }
}

// The route's answer when the session id it was asked for is not in the
// engine's memory at all — the process it lived in restarted, its process was
// stopped, or it was unloaded — as opposed to a session with an empty log.
// Before this frame existed the two were indistinguishable on the wire: an
// unknown session replayed nothing and closed its history at index 0, and the
// reader's transcript was replaced with that nothing. A client that receives
// this reopens the tab's session (ensureLocalSession restores the recorded
// transcript) and connects again under whatever id that hands back.
export const SESSION_GONE_KIND = 'session_gone' as const

export interface SessionGoneEvent {
  kind: typeof SESSION_GONE_KIND
}

export type AcpStreamEvent = AuthoredChatEvent | HistoryEndEvent | SessionGoneEvent
