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

// Events that say what the session IS -- its usage, options, commands, mode,
// title, queue, cadence -- rather than adding anything the transcript draws.
// They arrive constantly (a usage reading per step, a burst of snapshots every
// time a session opens) and they are not records: counted, they spent the
// budget on nothing visible, so a chat reopened after a restart could open on
// its last few messages with everything before them "not loaded", and a page
// of older history could be all snapshots and add nothing to the screen.
// They are transparent here instead: no boundary of their own, no break in the
// run of chunks around them, no cost. A reader cut above one loses nothing --
// the live stream prepends the current value of each (see withSnapshotPrefix).
function isStateEvent(event: ChatEvent): boolean {
  switch (event.kind) {
    case 'usage':
    case 'config_options':
    case 'available_commands':
    case 'modes':
    case 'mode_changed':
    case 'session_info':
    case 'queue':
    case 'presence':
      return true
    default:
      return false
  }
}

// The things the transcript draws ONCE and then patches where they stand: the
// plan, each subagent, each background task, each compaction. Every event of
// one carries its whole current state, and only the first places it -- the
// rest update the same block (see the client's fold). So only a first sighting
// is a record; an update is transparent, like a state event. Counted, a plan
// built one item at a time spent a record per item: three list entries cost
// six records of a budget meant for six things on screen.
function entityOf(event: ChatEvent): string | null {
  switch (event.kind) {
    case 'plan':
      return 'plan'
    case 'subagent':
      return `subagent:${event.subagent.subagentSessionId}`
    case 'async_task':
      return `task:${event.task.asyncTaskId}`
    case 'compaction':
      return `compaction:${event.compaction.compactionId}`
    default:
      return null
  }
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
  const drawn = new Set<string>()
  let runKind: ChatEvent['kind'] | null = null

  for (let i = start; i < end; i++) {
    const event = events[i]
    if (isStateEvent(event)) {
      continue
    }
    const entity = entityOf(event)
    if (entity !== null) {
      // An empty plan retires the one on screen and draws nothing; the next
      // plan after it is a new block, and a record again.
      if (event.kind === 'plan' && event.entries.length === 0) {
        drawn.delete(entity)
        continue
      }
      if (drawn.has(entity)) {
        continue
      }
      drawn.add(entity)
    }
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
      // Except that nothing is still open once its turn has ended. A turn that
      // is cancelled or cut off leaves tool calls that never report a terminal
      // status, and a group left open here would have no boundary after it for
      // the rest of the log: every later turn became part of one "record", and
      // a cold open served the whole tail from that point instead of its
      // budget. The turn_end is the last event of the record it closes.
      if (event.kind === 'turn_end') {
        openGroups.clear()
      }
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

// A window paged by RECORDS over the whole log — the chat transcript's only
// cursor. Distinct from EventsWindow in one way that matters: `events` is a
// contiguous slice, and the enclosing turn's `user` event is returned
// SEPARATELY as `header` rather than spliced into it.
//
// Splicing it in would make the slice non-contiguous, and that only looks
// harmless for the newest page: paging further back inside the same turn
// yields the same header again, so a consumer that concatenates pages either
// renders the question twice or, if it drops the duplicate, ends up with the
// question below records that precede it. Handing it over as its own field
// leaves the consumer an unambiguous rule — if it already has that index,
// insert the page's records after the header it already shows.
export interface RecordsWindow {
  // Contiguous slice of the log; never includes `header`.
  events: ChatEvent[]
  // Absolute index of the first counted AGENT record — the cursor to pass back
  // as `beforeIndex`. Deliberately not the header's index: anchoring it there
  // would re-serve the same turn's tail on every page instead of terminating.
  startIndex: number
  hasMore: boolean
  // The `user` event of the turn this window starts inside, when that event
  // sits above `startIndex`. Absent when the window already begins at or
  // before its turn's own header, or when no turn precedes it.
  header?: { index: number; event: ChatEvent }
}

// Whether a record counts against the budget. Only agent-side records do: a
// turn's question is free, so every turn the window touches keeps its header
// whether or not the budget reached it.
//
// Counting headers would let the budget expire ON one — loading a question
// whose replies didn't fit, which renders as though the agent never answered.
// A short view is fine; a wrong one isn't.
//
// A turn's end is free too unless it carries a failure: it is a boundary, and
// only a failed one draws anything.
function isAgentRecord(events: ChatEvent[], boundary: number): boolean {
  const event = events[boundary]
  if (event?.kind === 'turn_end') {
    return event.failure !== undefined
  }
  return event?.kind !== 'user'
}

// The `user` event of the turn containing `index`, when it sits strictly above
// it — what makes a partially-loaded turn still render with its question.
function headerAbove(events: ChatEvent[], index: number): RecordsWindow['header'] {
  for (let i = index - 1; i >= 0; i--) {
    if (events[i].kind === 'user') {
      return { index: i, event: events[i] }
    }
  }
  return undefined
}

// Walks back from `end` until `records` agent records have been counted,
// returning the boundary to start at. Falls back to 0 when the log runs out
// first — a short history is served whole rather than clipped.
function startOfLastRecords(events: ChatEvent[], end: number, records: number): number {
  const boundaries = recordBoundaries(events, 0, end)
  let counted = 0
  for (let i = boundaries.length - 1; i >= 0; i--) {
    if (isAgentRecord(events, boundaries[i])) {
      counted += 1
      if (counted === records) {
        return boundaries[i]
      }
    }
  }
  return 0
}

// The newest `records` agent records — what a cold-opened chat shows first.
export function tailByRecords(events: ChatEvent[], records: number): RecordsWindow {
  if (records <= 0) {
    return { events: [], startIndex: events.length, hasMore: events.length > 0 }
  }
  const startIndex = startOfLastRecords(events, events.length, records)
  return {
    events: events.slice(startIndex),
    startIndex,
    hasMore: startIndex > 0,
    header: headerAbove(events, startIndex),
  }
}

// The `records` agent records immediately before `beforeIndex` — one scroll-up.
// `beforeIndex` is a `startIndex` a previous window returned.
export function pageBeforeByRecords(events: ChatEvent[], beforeIndex: number, records: number): RecordsWindow {
  const end = Math.max(0, Math.min(beforeIndex, events.length))
  if (records <= 0 || end === 0) {
    return { events: [], startIndex: 0, hasMore: false }
  }
  const startIndex = startOfLastRecords(events, end, records)
  return {
    events: events.slice(startIndex, end),
    startIndex,
    hasMore: startIndex > 0,
    header: headerAbove(events, startIndex),
  }
}
