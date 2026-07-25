import { isTerminalToolStatus } from './fold'
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

// The index of the last 'user' event in `events` — the start of the newest
// turn it contains — or null if it has none. `events` is typically a window's
// own `.events` slice, not a full session log; add the window's `startIndex`
// to the result to get an absolute index. Used to find where a tail window's
// newest turn begins, so it can be further trimmed by tailRecordsInTurn.
export function lastUserIndex(events: ChatEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].kind === 'user') {
      return i
    }
  }
  return null
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

// The correlation id an event's request/response group shares with its
// counterpart, or null for an event that isn't part of one. Mirrors fold.ts's
// three Map-keyed correlations exactly — pagination needs the same grouping
// to know where a cut is safe, without folding any content itself.
function groupId(event: ChatEvent): string | null {
  switch (event.kind) {
    case 'tool_call':
    case 'tool_update':
      return `tool:${event.toolCallId}`
    case 'permission_request':
    case 'permission_resolved':
      return `permission:${event.requestId}`
    case 'ask_user':
    case 'ask_user_resolved':
      return `ask:${event.requestId}`
    default:
      return null
  }
}

// Whether this event closes its group. A tool_update only closes on a
// terminal status — 'pending'/'in_progress' updates leave the group open, so
// a still-running tool call is never treated as a safe cut point.
function isResolution(event: ChatEvent): boolean {
  switch (event.kind) {
    case 'tool_update':
      return isTerminalToolStatus(event.status)
    case 'permission_resolved':
    case 'ask_user_resolved':
      return true
    default:
      return false
  }
}

function isChunkEvent(event: ChatEvent): boolean {
  return event.kind === 'agent_message' || event.kind === 'agent_thought'
}

// Legal record-start indices within `events[start, end)` — the in-turn
// counterpart of `turnStarts`, one level finer. A record is a singleton
// event, a maximal run of same-kind streaming chunks (agent_message /
// agent_thought — foldEvents concatenates these while consecutive), or a
// closed request/response group (see groupId/isResolution). A boundary is
// only emitted once every group open at that point has closed, so a window
// cut at any returned index can never separate a tool_call from its
// tool_call_updates, or a permission/ask request from its resolution — the
// same invariant turnStarts protects for whole turns, one level deeper. An
// unresolved trailing group is never assigned a boundary after it, so it
// always ships in full with whatever record follows it (or, at the end of
// the range, as the entire remainder) — a live/streaming turn is never cut
// mid-tool-call.
function recordBoundaries(events: ChatEvent[], start: number, end: number): number[] {
  const boundaries: number[] = []
  const openGroups = new Set<string>()
  let runKind: ChatEvent['kind'] | null = null

  for (let i = start; i < end; i++) {
    const event = events[i]
    const id = groupId(event)

    if (id !== null) {
      runKind = null
      if (openGroups.has(id)) {
        if (isResolution(event)) {
          openGroups.delete(id)
        }
        continue
      }
      if (openGroups.size === 0) {
        boundaries.push(i)
      }
      if (!isResolution(event)) {
        openGroups.add(id)
      }
      continue
    }

    if (openGroups.size > 0) {
      // An unrelated event arriving while a group is still open — merge it
      // into that still-open record rather than risk cutting the group.
      runKind = null
      continue
    }

    if (isChunkEvent(event)) {
      if (event.kind !== runKind) {
        boundaries.push(i)
      }
      runKind = event.kind
      continue
    }

    runKind = null
    boundaries.push(i)
  }

  return boundaries
}

// The last `records` closed records of a turn's body — everything after its
// leading 'user' event at `turnStart`, up to `turnEnd` (exclusive; pass
// `events.length` for the newest, possibly still-streaming turn). This is the
// further tail-trim a turn with a huge number of tool calls needs on top of
// tailByTurns's whole-turn cut: a single long agent run can hold enough
// records to blow up a load on its own, and whole-turn windowing can't bound
// it since the oversized turn is still one page. The turn's own leading
// 'user' event is never included here — callers splice it in separately so it
// always ships regardless of how the rest of the turn is trimmed.
export function tailRecordsInTurn(
  events: ChatEvent[],
  turnStart: number,
  turnEnd: number,
  records: number,
): EventsWindow {
  const bodyStart = turnStart + 1
  if (records <= 0) {
    return { events: [], startIndex: turnEnd, hasMore: turnEnd > bodyStart }
  }
  const boundaries = recordBoundaries(events, bodyStart, turnEnd)
  if (boundaries.length <= records) {
    return { events: events.slice(bodyStart, turnEnd), startIndex: bodyStart, hasMore: false }
  }
  const startIndex = boundaries[boundaries.length - records]
  return { events: events.slice(startIndex, turnEnd), startIndex, hasMore: startIndex > bodyStart }
}

// The `records` records immediately before `beforeIndex` within the same
// turn's body — the "load older tool calls in this turn" counterpart to
// pageBeforeByTurns. `beforeIndex` is normally a `startIndex` a previous
// in-turn window (tail or page) returned.
export function pageBeforeRecordsInTurn(
  events: ChatEvent[],
  turnStart: number,
  beforeIndex: number,
  records: number,
): EventsWindow {
  const bodyStart = turnStart + 1
  const clampedBefore = Math.max(bodyStart, Math.min(beforeIndex, events.length))
  const boundaries = recordBoundaries(events, bodyStart, clampedBefore)
  if (boundaries.length === 0) {
    return { events: events.slice(bodyStart, clampedBefore), startIndex: bodyStart, hasMore: false }
  }
  const startIndex = boundaries.length <= records ? bodyStart : boundaries[boundaries.length - records]
  return { events: events.slice(startIndex, clampedBefore), startIndex, hasMore: startIndex > bodyStart }
}
