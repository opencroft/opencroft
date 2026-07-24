import type { ChatEvent } from './types'

// Index of each 'user' event in `events` — each starts a new turn/exchange, so
// these are the only safe places to cut a page. Cutting mid-turn could separate
// a tool_call from its tool_update, or split an assistant reply's delta chunks,
// breaking fold()'s accumulation logic.
function turnStarts(events: ChatEvent[]): number[] {
  const starts: number[] = []
  events.forEach((event, index) => {
    if (event.kind === 'user') {
      starts.push(index)
    }
  })
  return starts
}

export interface EventsWindow {
  events: ChatEvent[]
  // Absolute index into the session's full event log this window starts at —
  // the cursor a caller passes back as `beforeIndex` to page further back.
  startIndex: number
  // Whether events exist before `startIndex` (i.e. an earlier page remains).
  hasMore: boolean
}

// The last `turns` user-turns of `events` — the tail window a cold-opened chat
// should show first, instead of the full history a full session/load replay
// produces. `turns <= 0` returns an empty window (still valid: startIndex is
// events.length, hasMore true whenever there's any history at all).
export function tailByTurns(events: ChatEvent[], turns: number): EventsWindow {
  const starts = turnStarts(events)
  if (turns <= 0) {
    return { events: [], startIndex: events.length, hasMore: events.length > 0 }
  }
  if (starts.length <= turns) {
    return { events, startIndex: 0, hasMore: false }
  }
  const startIndex = starts[starts.length - turns]
  return { events: events.slice(startIndex), startIndex, hasMore: startIndex > 0 }
}

// The `turns` user-turns immediately before `beforeIndex` (exclusive) — the
// next page a "load older" scroll should fetch. `beforeIndex` is normally a
// `startIndex` returned by a previous window (tail or page).
export function pageBeforeByTurns(events: ChatEvent[], beforeIndex: number, turns: number): EventsWindow {
  const clampedBefore = Math.max(0, Math.min(beforeIndex, events.length))
  const starts = turnStarts(events.slice(0, clampedBefore))
  if (starts.length === 0) {
    return { events: events.slice(0, clampedBefore), startIndex: 0, hasMore: false }
  }
  const startIndex = starts.length <= turns ? 0 : starts[starts.length - turns]
  return { events: events.slice(startIndex, clampedBefore), startIndex, hasMore: startIndex > 0 }
}
