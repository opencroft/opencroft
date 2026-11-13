// Where a search hit sits in a session's log.
//
// A hit names a stored position, and an engine position is the stored one
// less the session's base (session-event-store.ts), for the history the
// engine holds and the history below it alike: the entry is read where it
// stands, through the log's reader, rather than searched for.

import { type LogReader, MISSING_ENTRY } from 'agent-client/pagination'

/**
 * Where a turn is in the session's log: at an index; older than the history
 * kept for it (the history settings trimmed it, and the search index still
 * knew it until they did); or gone, when nothing remembers it.
 */
export type TurnLocation = { kind: 'found'; index: number } | { kind: 'older' } | { kind: 'gone' }

/**
 * Locate the entry a search hit names, at engine position `position` (null
 * for a session that has no base to map it by). `indexed` answers whether the
 * search index holds a message there, which tells a trimmed entry from one
 * that never was; asked only when the log has no entry to show.
 */
export async function locateTurn(
  reader: LogReader,
  position: number | null,
  indexed: () => Promise<boolean>,
): Promise<TurnLocation> {
  if (position !== null && position >= 0 && position < reader.end) {
    const read = await reader.read(position, position + 1)
    const entry = read.start === position ? read.events[0] : undefined
    if (entry && entry !== MISSING_ENTRY) {
      return { kind: 'found', index: position }
    }
  }
  return (await indexed()) ? { kind: 'older' } : { kind: 'gone' }
}
