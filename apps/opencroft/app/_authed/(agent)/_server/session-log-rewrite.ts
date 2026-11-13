// Rewriting a key's recorded logs into the compacted layout.
//
// Rows recorded before the engine compacted its logs are one row per event:
// every chunk of a reply, every update of a tool call, and each step of a
// subagent wrapped (`subagent_event`) in the session's own log. The engine
// reads its logs back as they are stored, so rows in that layout come back
// uncompacted, with a subagent's steps inside the parent and no step count on
// its header. The event store rewrites such a key once (see
// AgentSessionLegacyLog), through this.
//
// The rows go through the engine's own compaction (agent-client's
// TranscriptLog), so a rewritten log is the log the engine would have written
// for the same events. Rows already compacted come out drawing the same: a
// merged entry merges with nothing but its own run. A key can hold both: a
// session whose recording began in the old layout and went on in the new.
//
// Positions are renumbered from the first stored position of the session's
// own log, so what lies below it -- search messages for history the old cap
// trimmed -- keeps its position; `remap` moves the positions from there on. A
// subagent's log is numbered from 0, as the engine numbers it.
//
// History the cap cut is not in the rows and stays cut: a subagent whose
// spawn was cut has steps and no header, and is drawn under the fallback name.

import { type LogWrite, SESSION_LOG, TranscriptLog } from 'agent-client/transcript-log'
import type { ChatEvent } from 'agent-client/types'

/** One stored row of a key, as the rewrite reads and writes it. */
export interface LogRow {
  subagentId: string
  position: number
  event: ChatEvent
  createdAt: Date
}

/** A key's rows rewritten: the rows to store, and where each old position of the session's own log went. */
export interface RewrittenLogs {
  rows: LogRow[]
  /**
   * The new position for an old one of the session's own log: below its first
   * row, the same; an entry's own
   * where it stood, merged into it or not; for an old position no entry of the
   * session's log kept (a step moved to its subagent's log, a snapshot equal
   * to the one before, a gap), the next entry added after it. Past the old
   * log's end, moved down by as much as the log shrank. The index names only
   * questions' and messages' first rows, which keep entries of their own.
   */
  remap: (position: number) => number
}

/**
 * The rows of one key compacted, taken a row at a time so a long log is not
 * held twice: the session's own log first, in position order, then the
 * subagent logs already in the compacted layout, each in position order. A
 * subagent's log of that layout was recorded after whatever steps it left in
 * the session's own log, so its rows follow them.
 *
 * A row keeps the time of the first row merged into it: when the entry began.
 */
export class LogRewriter {
  private readonly log = new TranscriptLog()
  private readonly began = new Map<string, Date>()
  // Old positions of the session's own rows, in order, where each landed in
  // the session's own log (-1: elsewhere or nowhere), and whether it landed as
  // a new entry there rather than into one already placed.
  private readonly oldPositions: number[] = []
  private readonly landed: number[] = []
  private readonly added: boolean[] = []
  private subagentsBegun = false

  addOwn(row: LogRow): void {
    if (this.subagentsBegun) {
      throw new Error('the session log rows come before the subagent logs')
    }
    const write = this.append(row, row.event)
    const own = write?.log === SESSION_LOG
    this.oldPositions.push(row.position)
    this.landed.push(own ? write.position : -1)
    this.added.push(own && write.appended)
  }

  addSubagent(row: LogRow): void {
    this.subagentsBegun = true
    this.append(row, { kind: 'subagent_event', subagentSessionId: row.subagentId, event: row.event })
  }

  finish(): RewrittenLogs {
    const first = this.oldPositions[0] ?? 0
    const rows: LogRow[] = []
    const entries = this.log.entries(SESSION_LOG) ?? []
    entries.forEach((event, position) => {
      rows.push({
        subagentId: SESSION_LOG,
        position: first + position,
        event,
        createdAt: this.at(SESSION_LOG, position),
      })
    })
    for (const [id, events] of this.log.subagentLogs()) {
      events.forEach((event, position) => {
        rows.push({ subagentId: id, position, event, createdAt: this.at(id, position) })
      })
    }

    const { oldPositions, landed, added } = this
    const end = first + entries.length
    const last = oldPositions[oldPositions.length - 1]
    const oldEnd = last === undefined ? first : last + 1
    // From the end back, each old row's new position: its own entry's, or for
    // a row the session's log did not keep, the next new entry's. Not the next
    // row kept: a rewrite of an entity lands back where the entity stands.
    const next = new Array<number>(oldPositions.length)
    for (let i = oldPositions.length - 1, after = end; i >= 0; i -= 1) {
      const at = landed[i] as number
      next[i] = at >= 0 ? first + at : after
      if (added[i]) {
        after = first + at
      }
    }
    const remap = (position: number): number => {
      if (position < first) {
        return position
      }
      if (position >= oldEnd) {
        return position - oldEnd + end
      }
      // The first old row at or after `position`.
      let lo = 0
      let hi = oldPositions.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if ((oldPositions[mid] as number) < position) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      return lo < next.length ? (next[lo] as number) : end
    }
    return { rows, remap }
  }

  private append(row: LogRow, event: ChatEvent): LogWrite | undefined {
    const [write] = this.log.append(event)
    if (write) {
      const key = `${write.log}\n${write.position}`
      if (!this.began.has(key)) {
        this.began.set(key, row.createdAt)
      }
    }
    return write
  }

  private at(log: string, position: number): Date {
    return this.began.get(`${log}\n${position}`) ?? new Date()
  }
}
