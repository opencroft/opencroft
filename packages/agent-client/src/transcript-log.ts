import { isSnapshotEvent } from './fold'
import type { ChatEvent } from './types'

// The log a write landed in: '' for the session's own, a subagent's session id
// for that subagent's.
export const SESSION_LOG = ''

/**
 * One change to a log: the entry now standing at `position` in log `log`.
 * `appended` is false when an entry already there was rewritten in place (a
 * chunk run that grew, a tool call's merged update, an entity's newest state,
 * the turn's usage reading). A host keeping a durable copy writes the entry at
 * that position, inserting or replacing.
 */
export interface LogWrite {
  log: string
  position: number
  event: ChatEvent
  appended: boolean
}

/**
 * A host's durable copy of a session's logs, read back: what lets the engine
 * hold only a tail of a long log in memory. Positions are the engine's, of the
 * log named (`''` for the session's own, a subagent's session id for its).
 *
 * A read sees every write the host was handed (`onRecord`) before it, whether
 * the host has stored it yet or not: the engine lets go of an entry as soon
 * as it was handed over.
 */
export interface HistoryPort {
  /** The entries stored from `from` up to `to`, in position order; a position the copy lacks is absent. */
  read(sessionId: string, log: string, from: number, to: number): Promise<PlacedEntry[]>
  /** The position of the newest `user` entry below `position`, or null for none. */
  turnStartBefore(sessionId: string, log: string, position: number): Promise<number | null>
  /** One past the newest position stored in the log; 0 for a log with nothing. */
  end(sessionId: string, log: string): Promise<number>
}

// The kinds a subagent's `steps` counts: one entry per block its section
// draws, once chunk runs are merged.
const STEP_KINDS = new Set<ChatEvent['kind']>(['agent_message', 'agent_thought', 'tool_call'])

// Snapshots that replace wholesale and are re-sent unchanged (every session
// open, every resume): one equal to the current snapshot adds nothing.
const DEDUPED_SNAPSHOTS = new Set<ChatEvent['kind']>(['available_commands', 'config_options', 'modes'])

// The entity an event carries the full state of, for the kinds the transcript
// places once and patches where it stands.
function entityKey(event: ChatEvent): string | null {
  switch (event.kind) {
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

// Whether an event leaves a chunk run open: it draws nothing of its own
// between two chunks, so a reader's fold continues the text across it.
// Anything else (a tool call, a turn boundary, a first sighting of an entity,
// a request card) starts a new block, so the run ends there. Erring towards
// ending a run only costs an entry: two adjacent entries of one run fold to
// the same text as one.
function keepsRunOpen(event: ChatEvent): boolean {
  return (
    isSnapshotEvent(event) ||
    event.kind === 'tool_update' ||
    event.kind === 'permission_resolved' ||
    event.kind === 'ask_user_resolved' ||
    event.kind === 'presence'
  )
}

type ToolUpdate = Extract<ChatEvent, { kind: 'tool_update' }>
type Usage = Extract<ChatEvent, { kind: 'usage' }>
type Chunk = Extract<ChatEvent, { kind: 'agent_message' | 'agent_thought' }>

// A tool call's updates as one, field by field, the later value winning: what
// every fold of the updates in order arrives at.
function mergeToolUpdate(earlier: ToolUpdate, later: ToolUpdate): ToolUpdate {
  const title = later.title ?? earlier.title
  const status = later.status ?? earlier.status
  const input = later.input ?? earlier.input
  const output = later.output ?? earlier.output
  const diffs = later.diffs ?? earlier.diffs
  return {
    kind: 'tool_update',
    toolCallId: later.toolCallId,
    ...(title !== undefined ? { title } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(diffs !== undefined ? { diffs } : {}),
  }
}

// The turn's newest reading. Cost and rate limits are session- and
// account-scale state that rides some readings only, so a reading without them
// keeps the last ones (as the engine's SessionUsage does).
function mergeUsage(earlier: Usage, later: Usage): Usage {
  const cost = later.cost ?? earlier.cost
  const rateLimits = later.rateLimits ?? earlier.rateLimits
  return { ...later, ...(cost ? { cost } : {}), ...(rateLimits ? { rateLimits } : {}) }
}

/** An entry with the position it stands at. */
export interface PlacedEntry {
  position: number
  event: ChatEvent
}

// One log and what appending to it needs to find without a scan. Every
// position here is the log's own, not an index into `entries`.
interface LogIndex {
  // The entries from `start` on: what the log holds in memory. A log whose
  // older entries were let go (`evictBefore`) or were never loaded starts past 0.
  entries: ChatEvent[]
  start: number
  // The update entry each call's next update merges into: its first update
  // since the call was announced, within the turn. A fold applies an update
  // only to a call it has seen, and closes open calls at the turn's end, so an
  // update before either boundary can't take a later one's fields.
  toolUpdates: Map<string, number>
  // Each entity's entry, at its first sighting, held or not.
  entities: Map<string, number>
  // The entries below `start` still rewritten from here: the headers of
  // subagents that are still running, whose step counts grow.
  outside: Map<number, ChatEvent>
  // The last snapshot appended of each deduplicated kind, serialized.
  snapshots: Map<ChatEvent['kind'], string>
  // This turn's usage entry.
  usage?: number
  // The chunk entry the next chunk of the same kind and message extends.
  run?: number
}

// Whether a subagent's header says it can still take steps: no state is a
// subagent still running.
function isRunningSubagent(event: ChatEvent | undefined): boolean {
  return event?.kind === 'subagent' && event.subagent.state === undefined
}

function indexOf(entries: ChatEvent[], start = 0): LogIndex {
  const index: LogIndex = {
    entries,
    start,
    toolUpdates: new Map(),
    entities: new Map(),
    outside: new Map(),
    snapshots: new Map(),
  }
  entries.forEach((event, offset) => {
    const position = start + offset
    if (event.kind === 'tool_call') {
      index.toolUpdates.delete(event.toolCallId)
    } else if (event.kind === 'tool_update' && !index.toolUpdates.has(event.toolCallId)) {
      index.toolUpdates.set(event.toolCallId, position)
    } else if (event.kind === 'turn_end') {
      index.toolUpdates.clear()
    } else if (event.kind === 'user') {
      index.usage = undefined
    } else if (event.kind === 'usage') {
      index.usage = position
    } else if (DEDUPED_SNAPSHOTS.has(event.kind)) {
      index.snapshots.set(event.kind, JSON.stringify(event))
    }
    const entity = entityKey(event)
    if (entity !== null && !index.entities.has(entity)) {
      index.entities.set(entity, position)
    }
  })
  return index
}

/**
 * A session's transcript as the engine keeps it: the session's own log and one
 * log per subagent, compacted as they are appended to.
 *
 * - Chunks of one run (same kind and `messageId`, nothing drawn between) merge
 *   into one entry.
 * - A tool call's updates merge, field by field, into one entry at the first
 *   update after the call within a turn. An update before the call is
 *   announced, or after the turn ends, stays an entry of its own.
 * - A subagent, background task or compaction keeps one entry at its first
 *   sighting, rewritten with its newest state.
 * - Usage keeps one entry per turn, rewritten with the newest reading.
 * - A commands, config options or modes snapshot equal to the current one is
 *   not appended.
 * - A subagent's step (`subagent_event`) is unwrapped into the innermost
 *   subagent's own log, and its `subagent` entry carries `steps`: how many
 *   step entries (`agent_message`, `agent_thought`, `tool_call`) its log
 *   holds. A step that adds one rewrites the header where it stands.
 *
 * Every rule leaves what a fold of the log draws equal to a fold of the events
 * appended. A position never moves once given, so it names an entry for good.
 *
 * The session's own log need not be held whole: it can start past 0 (`start`,
 * a log restored from its tail) and let go of its oldest turns
 * (`evictBefore`). Positions stay the log's own either way; what is not held
 * is the host's to read back. `before` names the entries below `start` that
 * appending still has to know of: the entities placed there (an update
 * rewrites them where they stand) and the snapshots the deduplication compares
 * against.
 *
 * The arrays it is built over are its own from then on: it appends to them,
 * replaces their entries and drops from their front, and never replaces the
 * arrays.
 */
export class TranscriptLog {
  private readonly logs = new Map<string, LogIndex>()
  private readonly steps = new Map<string, number>()
  // Where each subagent's `subagent` entry stands: which log, which position.
  private readonly headers = new Map<string, { log: string; position: number }>()

  constructor(
    entries: ChatEvent[] = [],
    subagentLogs: ReadonlyMap<string, ChatEvent[]> = new Map(),
    opts: { start?: number; before?: readonly PlacedEntry[] } = {},
  ) {
    const own = indexOf([], opts.start ?? 0)
    for (const { position, event } of opts.before ?? []) {
      const entity = entityKey(event)
      if (entity !== null && !own.entities.has(entity)) {
        own.entities.set(entity, position)
        if (event.kind === 'subagent') {
          this.headers.set(event.subagent.subagentSessionId, { log: SESSION_LOG, position })
          if (isRunningSubagent(event)) {
            own.outside.set(position, event)
          }
        }
      } else if (DEDUPED_SNAPSHOTS.has(event.kind)) {
        own.snapshots.set(event.kind, JSON.stringify(event))
      }
    }
    this.adopt(SESSION_LOG, entries, own)
    for (const [subagentId, log] of subagentLogs) {
      this.adopt(subagentId, log)
    }
  }

  /** The session's own log, or a subagent's, as held; undefined for a subagent with none. */
  entries(log: string = SESSION_LOG): ChatEvent[] | undefined {
    return this.logs.get(log)?.entries
  }

  /** The position of a log's first entry held: past 0 once older ones are not. */
  start(log: string = SESSION_LOG): number {
    return this.logs.get(log)?.start ?? 0
  }

  /**
   * Let go of the session's own entries below `position`, which the host has
   * been handed and can read back. Nothing of a turn still open may stand
   * there: the caller cuts at a turn's start. The logs of finished subagents
   * placed there go too, with those of the subagents they spawned; a subagent
   * still running keeps its log, and its header is kept aside to be rewritten.
   */
  evictBefore(position: number): void {
    const own = this.index(SESSION_LOG)
    const count = Math.min(position - own.start, own.entries.length)
    if (count <= 0) {
      return
    }
    const dropped = own.entries.splice(0, count)
    const start = own.start
    own.start += count
    for (const [id, at] of own.toolUpdates) {
      if (at < own.start) {
        own.toolUpdates.delete(id)
      }
    }
    if (own.usage !== undefined && own.usage < own.start) {
      own.usage = undefined
    }
    if (own.run !== undefined && own.run < own.start) {
      own.run = undefined
    }
    const gone = new Set<string>()
    dropped.forEach((entry, offset) => {
      if (entry.kind !== 'subagent') {
        return
      }
      if (isRunningSubagent(entry)) {
        own.outside.set(start + offset, entry)
      } else {
        gone.add(entry.subagent.subagentSessionId)
      }
    })
    // A finished subagent's children are finished too, or nothing is left to
    // tell them so; their logs go with it.
    for (let changed = true; changed; ) {
      changed = false
      for (const [id, header] of this.headers) {
        if (!gone.has(id) && gone.has(header.log)) {
          gone.add(id)
          changed = true
        }
      }
    }
    for (const id of gone) {
      this.logs.delete(id)
      this.steps.delete(id)
    }
  }

  /**
   * The subagents spawned at or after `position` in the session's own log, and
   * the ones they spawned: what a conversation cut there no longer has.
   */
  subagentsFrom(position: number): Set<string> {
    const from = new Set<string>()
    for (const [id, header] of this.headers) {
      if (header.log === SESSION_LOG && header.position >= position) {
        from.add(id)
      }
    }
    for (let changed = true; changed; ) {
      changed = false
      for (const [id, header] of this.headers) {
        if (!from.has(id) && from.has(header.log)) {
          from.add(id)
          changed = true
        }
      }
    }
    return from
  }

  /** Every subagent log, by subagent session id. */
  subagentLogs(): Map<string, ChatEvent[]> {
    const logs = new Map<string, ChatEvent[]>()
    for (const [id, index] of this.logs) {
      if (id !== SESSION_LOG) {
        logs.set(id, index.entries)
      }
    }
    return logs
  }

  /** How many steps a subagent's log holds. */
  stepsOf(subagentId: string): number {
    return this.steps.get(subagentId) ?? 0
  }

  /**
   * Append one event. The writes it made, its own entry's first; none for a
   * snapshot that changed nothing. A step that adds an entry to a subagent's
   * log is followed by the rewrite of that subagent's header.
   */
  append(event: ChatEvent): LogWrite[] {
    let log = SESSION_LOG
    let inner = event
    while (inner.kind === 'subagent_event') {
      log = inner.subagentSessionId
      inner = inner.event
    }
    const write = this.appendTo(log, inner)
    if (!write) {
      return []
    }
    const writes = [write]
    if (log !== SESSION_LOG && write.appended && STEP_KINDS.has(write.event.kind)) {
      this.steps.set(log, this.stepsOf(log) + 1)
      const header = this.rewriteHeader(log)
      if (header) {
        writes.push(header)
      }
    }
    return writes
  }

  // Take `entries` as a log, indexed on top of `seed` (what is known below its
  // start) when given: an entity placed below stands where it was placed, and
  // a snapshot held is newer than one below.
  private adopt(id: string, entries: ChatEvent[], seed?: LogIndex): void {
    const index = indexOf(entries, seed?.start ?? 0)
    if (seed) {
      for (const [entity, position] of seed.entities) {
        index.entities.set(entity, position)
      }
      for (const [kind, serialized] of seed.snapshots) {
        if (!index.snapshots.has(kind)) {
          index.snapshots.set(kind, serialized)
        }
      }
      index.outside = seed.outside
    }
    this.logs.set(id, index)
    if (id !== SESSION_LOG) {
      this.steps.set(id, entries.filter((entry) => STEP_KINDS.has(entry.kind)).length)
    }
    entries.forEach((entry, offset) => {
      if (entry.kind === 'subagent' && !this.headers.has(entry.subagent.subagentSessionId)) {
        this.headers.set(entry.subagent.subagentSessionId, { log: id, position: index.start + offset })
      }
    })
  }

  private index(log: string): LogIndex {
    let index = this.logs.get(log)
    if (!index) {
      index = indexOf([])
      this.logs.set(log, index)
    }
    return index
  }

  private appendTo(log: string, event: ChatEvent): LogWrite | null {
    const index = this.index(log)
    const { entries } = index
    // An entry below what is held is rewritten for the host all the same, and
    // kept aside only when it is one still rewritten from here.
    const rewrite = (position: number, entry: ChatEvent): LogWrite => {
      if (position >= index.start) {
        entries[position - index.start] = entry
      } else if (isRunningSubagent(entry)) {
        index.outside.set(position, entry)
      } else {
        index.outside.delete(position)
      }
      return { log, position, event: entry, appended: false }
    }
    const add = (entry: ChatEvent): LogWrite => {
      entries.push(entry)
      return { log, position: index.start + entries.length - 1, event: entry, appended: true }
    }
    const held = (position: number): ChatEvent | undefined => entryAt(index, position)

    if (event.kind === 'agent_message' || event.kind === 'agent_thought') {
      const open = index.run === undefined ? undefined : (held(index.run) as Chunk | undefined)
      if (index.run !== undefined && open && open.kind === event.kind && open.messageId === event.messageId) {
        return rewrite(index.run, { ...open, text: open.text + event.text })
      }
      const write = add(event)
      index.run = write.position
      return write
    }

    const entity = entityKey(event)
    if (entity !== null) {
      const entry = this.withSteps(event)
      const at = index.entities.get(entity)
      if (at !== undefined) {
        return rewrite(at, entry)
      }
      const write = add(entry)
      index.entities.set(entity, write.position)
      if (entry.kind === 'subagent') {
        this.headers.set(entry.subagent.subagentSessionId, { log, position: write.position })
      }
      index.run = undefined
      return write
    }

    if (event.kind === 'tool_update') {
      const at = index.toolUpdates.get(event.toolCallId)
      if (at !== undefined) {
        return rewrite(at, mergeToolUpdate(held(at) as ToolUpdate, event))
      }
      const write = add(event)
      index.toolUpdates.set(event.toolCallId, write.position)
      return write
    }

    if (event.kind === 'usage') {
      if (index.usage !== undefined) {
        return rewrite(index.usage, mergeUsage(held(index.usage) as Usage, event))
      }
      const write = add(event)
      index.usage = write.position
      return write
    }

    if (DEDUPED_SNAPSHOTS.has(event.kind)) {
      const serialized = JSON.stringify(event)
      if (index.snapshots.get(event.kind) === serialized) {
        return null
      }
      index.snapshots.set(event.kind, serialized)
      return add(event)
    }

    if (event.kind === 'user') {
      index.usage = undefined
    } else if (event.kind === 'tool_call') {
      index.toolUpdates.delete(event.toolCallId)
    } else if (event.kind === 'turn_end') {
      index.toolUpdates.clear()
    }
    if (!keepsRunOpen(event)) {
      index.run = undefined
    }
    return add(event)
  }

  // A `subagent` entry carries the step count this log keeps, whatever the
  // event said: the count is the log's to know.
  private withSteps(event: ChatEvent): ChatEvent {
    if (event.kind !== 'subagent') {
      return event
    }
    return { kind: 'subagent', subagent: { ...event.subagent, steps: this.stepsOf(event.subagent.subagentSessionId) } }
  }

  private rewriteHeader(subagentId: string): LogWrite | null {
    const header = this.headers.get(subagentId)
    const index = header ? this.logs.get(header.log) : undefined
    const entry = header && index ? entryAt(index, header.position) : undefined
    if (!header || !index || entry?.kind !== 'subagent') {
      return null
    }
    const updated: ChatEvent = this.withSteps(entry)
    if (header.position >= index.start) {
      index.entries[header.position - index.start] = updated
    } else {
      index.outside.set(header.position, updated)
    }
    return { log: header.log, position: header.position, event: updated, appended: false }
  }
}

// The entry at a log position, held or kept aside.
function entryAt(index: LogIndex, position: number): ChatEvent | undefined {
  return position >= index.start ? index.entries[position - index.start] : index.outside.get(position)
}

/**
 * A recorded transcript compacted by the same rules the engine appends by —
 * for rewriting a log that was recorded event by event. `placed[i]` is where `events[i]`
 * landed (its log and position), or null for a snapshot that added nothing:
 * what remaps anything that named an event by its old index.
 */
export function compactTranscript(events: Iterable<ChatEvent>): {
  log: TranscriptLog
  placed: ({ log: string; position: number } | null)[]
} {
  const log = new TranscriptLog()
  const placed: ({ log: string; position: number } | null)[] = []
  for (const event of events) {
    const [own] = log.append(event)
    placed.push(own ? { log: own.log, position: own.position } : null)
  }
  return { log, placed }
}
