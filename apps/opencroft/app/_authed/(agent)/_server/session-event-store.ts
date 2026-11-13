// This app's durable copy of an agent session's transcript.
//
// The engine holds the tail of a session's logs in memory and serves reads
// from there; this records them whole, so reopening a conversation does not
// depend on the harness being able to replay it, and serves what lies below
// the tail back to the engine (`sessionHistoryPort`). Nothing here is on the path an event takes
// to a reader — the write happens after the event has already been emitted and
// fanned out, so a slow or broken store costs a transcript that has to fall
// back to the harness's replay, never a dropped frame in a live chat.
//
// The same shape as the durable queue next door (queue-store.ts), and for the
// same reason: the engine owns the behaviour, this owns the disk.
//
// ── What is recorded: the engine's logs, entry by entry ───────────────────
//
// The engine keeps a session's transcript compacted (agent-client's
// TranscriptLog): its own log, and one log per subagent, each entry standing
// at a position that never moves and rewritten in place as it grows. Every
// write it makes is handed here (`recordLogWrite`) and lands as the row at
// that position: inserted, or replaced. A row is therefore always the entry as
// the engine last held it, and a log read back is the log the engine had.
//
// ── Positions: the engine's, offset by where the log starts here ───────────
//
// A row's position is the engine's position plus the log's base: where the
// engine's entry 0 is stored. A restored session's base is its first row
// (history settings can trim the front, so that is not always 0); a new
// session's is the next free position under the key, never below what the
// search index refers to. The base is fixed per engine session when it first
// writes, or set before by whoever seeds it from the rows
// (`attachSessionLogs`, `prepareSessionLogs`). A subagent's log is stored
// from 0 and its base is 0.
//
// ── Whole history, a tail in memory ───────────────────────────────────────
//
// Nothing is trimmed unless the history settings ask (transcript-retention.ts,
// both off by default): every entry of every log stays. A reopen reads only
// the tail of the session's own log, from a turn's start (`readSessionLogs`),
// with the state entries below it the session still needs, and the logs of
// the subagents still running; the engine reads the rest through
// `sessionHistoryPort` when a reader pages up to it.
//
// ── Why the writes are batched ────────────────────────────────────────────
//
// A streaming turn rewrites a reply's entry per chunk — hundreds for one
// answer. Writing a row per chunk would put a database round-trip inside the
// stream's own callback, so writes are collected and written in batches, and
// the rewrites of one entry within a batch are written once. What that costs is
// bounded and known: an unclean shutdown loses at most one unflushed batch off
// the end of a transcript, which is the tail of a turn that was still being
// written when the process stopped.
//
// ── The search index rides on the same writes ─────────────────────────────
//
// TranscriptMessage, the search index, is derived from the session's own log
// by transcript-message-index.ts. Each batch is handed to it right after the
// write, inside the same per-key chain, and a move here applies to it too.
// The index keeps a session's whole history, which is the point of having
// it, so nothing that keeps the conversation clears it: not a recording
// cleared for a replay, not an edit (which drops only the turns it rewinds).
// The history settings drop what they trim, and retiring the key drops it all. The index is written AFTER the
// events, never in their transaction, so a failure there costs search text,
// never the transcript. Subagent logs are not indexed.
//
// ── Rows recorded before the logs were compacted ──────────────────────────
//
// A key listed in AgentSessionLegacyLog may hold rows of the layout before:
// one row per event, subagent steps wrapped in the session's own log. Each is
// rewritten once (session-log-rewrite.ts), in its chain: before a reopen or an
// offline listing reads it, or by the background sweep, one key at a time.
// The sweep leaves a key an engine session in this process writes under; a
// session is only ever reopened through the rewrite, so such a key is one a
// new session went on recording into, and its next reopen rewrites it.

import { agentSessionEvent, agentSessionLegacyLog, db } from '@opencroft/db'
import { boundedSelect, inBudget } from '@opencroft/db/bounded-select'
import { contiguous, type LogReader, MISSING_ENTRY } from 'agent-client/pagination'
import { type HistoryPort, type LogWrite, type PlacedEntry, SESSION_LOG } from 'agent-client/transcript-log'
import type { ChatEvent } from 'agent-client/types'
import { and, desc, eq, gte, inArray, lt, ne, notInArray, or, type SQL, sql } from 'drizzle-orm'

import { LogRewriter, type LogRow } from '@/app/_authed/(agent)/_server/session-log-rewrite'
import {
  applyIndexRemap,
  catchUpSession,
  clearTranscriptIndex,
  dropTranscriptIndexBelow,
  holdForReplay,
  indexedThrough,
  indexRecordedEvents,
  moveTranscriptIndex,
  planIndexRemap,
  releaseAfterReplay,
  sessionsBehindIndex,
  settleTranscriptIndex,
  truncateTranscriptIndex,
} from '@/app/_authed/(agent)/_server/transcript-message-index'

/**
 * How much of a session's own log a reopen reads: the newest turns holding at
 * least this many entries. The engine keeps about as many in memory once it
 * evicts (agent-client's TAIL_KEEP), so a reopened session holds what a
 * running one would.
 */
const TAIL_ENTRIES = 2000

/**
 * How much history the settings keep (transcript-retention.ts), per session:
 * at most `maxEntries` entries of its own log, and nothing from turns that
 * started more than `cleanupAfterDays` days ago. Null keeps everything, and
 * both are null until the settings say otherwise.
 */
export interface HistoryRetention {
  maxEntries: number | null
  cleanupAfterDays: number | null
}

/** Flush when this many writes are waiting, whatever the timer says. */
const FLUSH_AT_EVENTS = 20

/** …and at the latest this long after the first write of a batch arrived. */
const FLUSH_AFTER_MS = 250

/** Rows per statement when a whole log is written at once, under the byte budget too. */
const ROWS_PER_INSERT = 200

/**
 * Where each of an engine session's logs starts in the table: the stored
 * position of the engine's entry 0, by log ('' for the session's own, a
 * subagent's session id for its). `resolved` false: the session's own base is
 * still to be read as the next free position under the key, at its first
 * flush.
 */
interface LogBinding {
  sessionKey: string
  bases: Map<string, number>
  resolved: boolean
}

/** One buffered write, with the engine session that made it. */
interface PendingWrite {
  sessionId: string
  write: LogWrite
}

// Buffers and the write chain survive a dev hot-reload, so a reload mid-turn
// cannot strand a pending batch in a module instance nothing will flush again.
const globalRef = globalThis as typeof globalThis & {
  __agentSessionLogBuffers?: Map<string, Map<string, PendingWrite>>
  __agentSessionEventWrites?: Map<string, Promise<void>>
  __agentSessionEventPositions?: Map<string, number>
  __agentSessionLogBindings?: Map<string, LogBinding>
  __agentSessionLogPrepared?: Map<string, Map<string, number>>
  __agentSessionEventTimer?: ReturnType<typeof setTimeout>
  __agentHistoryRetention?: HistoryRetention
}
globalRef.__agentSessionLogBuffers ??= new Map()
globalRef.__agentSessionEventWrites ??= new Map()
globalRef.__agentSessionEventPositions ??= new Map()
globalRef.__agentSessionLogBindings ??= new Map()
globalRef.__agentSessionLogPrepared ??= new Map()

/** Per key, the writes waiting, one per entry: a later write of the same entry replaces the earlier. */
const buffers = globalRef.__agentSessionLogBuffers
// How many writes a key's buffer has taken since its last flush, rewrites of
// one entry included: what the flush cadence counts. Losing it to a reload
// only delays one flush to the timer.
const received = new Map<string, number>()
const writes = globalRef.__agentSessionEventWrites
/**
 * The next free position of the session's own log per key, once this process
 * has established it.
 *
 * Read from the table the first time it is needed and then kept, so a batch
 * does not cost a `max(position)` query. One process owns a session at a time,
 * so nothing else is allocating positions under the same key while this holds
 * one.
 */
const positions = globalRef.__agentSessionEventPositions
/** Each engine session's bases, by session id. */
const bindings = globalRef.__agentSessionLogBindings
/** Bases set for the next engine session to write under a key, by key (see prepareSessionLogs). */
const prepared = globalRef.__agentSessionLogPrepared

/** What the history settings keep now: everything until setHistoryRetention says otherwise. */
function retention(): HistoryRetention {
  return globalRef.__agentHistoryRetention ?? { maxEntries: null, cleanupAfterDays: null }
}

/** Take the history settings: what every write and sweep from now on trims by. */
export function setHistoryRetention(next: HistoryRetention): void {
  globalRef.__agentHistoryRetention = next
}

/**
 * Run a write for one key behind whatever is already queued for it.
 *
 * Same ordering rule, and the same reasoning, as the durable queue's `persist`:
 * batches for one session must land in the order they were issued, or a
 * transcript records an entry's older state over its newer one. A failed batch
 * is logged and stepped over rather than allowed to wedge the ones behind it.
 */
function chain(sessionKey: string, write: () => Promise<void>): Promise<void> {
  const tail = writes.get(sessionKey) ?? Promise.resolve()
  const next = tail.then(async () => {
    try {
      await write()
    } catch (error) {
      console.error('[session-event-store] durable transcript write failed', sessionKey, error)
    }
  })
  writes.set(sessionKey, next)
  void next.then(() => {
    if (writes.get(sessionKey) === next) {
      writes.delete(sessionKey)
    }
  })
  return next
}

/** Wait out every write already issued for a key, including ones chained while waiting. */
async function settled(sessionKey: string): Promise<void> {
  for (let pending = writes.get(sessionKey); pending; ) {
    await pending
    const tail = writes.get(sessionKey)
    pending = tail === pending ? undefined : tail
  }
}

async function nextPosition(sessionKey: string): Promise<number> {
  const known = positions.get(sessionKey)
  if (known !== undefined) {
    return known
  }
  const [row] = await db
    .select({ max: sql<number | null>`max(${agentSessionEvent.position})` })
    .from(agentSessionEvent)
    .where(and(eq(agentSessionEvent.sessionKey, sessionKey), eq(agentSessionEvent.subagentId, SESSION_LOG)))
  // Never below what the search index refers to: it outlives a clear of the
  // events, and a position numbered again would alias one of its rows.
  const next = Math.max((row?.max ?? -1) + 1, await indexedThrough(sessionKey))
  positions.set(sessionKey, next)
  return next
}

// The bases an engine session writes under `sessionKey` with: its own, or the
// ones prepared for the next session there, or a new set whose session base is
// read at the first flush.
function bindingOf(sessionKey: string, sessionId: string): LogBinding {
  const known = bindings.get(sessionId)
  if (known && known.sessionKey === sessionKey) {
    return known
  }
  const bases = prepared.get(sessionKey)
  prepared.delete(sessionKey)
  const binding: LogBinding = bases
    ? { sessionKey, bases: new Map(bases), resolved: true }
    : { sessionKey, bases: new Map(), resolved: false }
  bindings.set(sessionId, binding)
  return binding
}

// A binding's bases, its own log's read now if still open. A subagent log the
// binding has not seen starts at 0: a subagent's id names it alone, so nothing
// else is stored under it.
async function resolvedBases(binding: LogBinding): Promise<Map<string, number>> {
  if (!binding.resolved) {
    binding.bases.set(SESSION_LOG, await nextPosition(binding.sessionKey))
    binding.resolved = true
  }
  return binding.bases
}

function baseOf(bases: Map<string, number>, log: string): number {
  let base = bases.get(log)
  if (base === undefined) {
    base = 0
    bases.set(log, base)
  }
  return base
}

interface StoredRow {
  subagentId: string
  position: number
  event: ChatEvent
}

// Insert each row, or replace the one at its position.
async function upsertRows(sessionKey: string, rows: readonly StoredRow[], createdAt: Date): Promise<void> {
  for await (const batch of inBudget(rows, (row) => JSON.stringify(row.event).length, ROWS_PER_INSERT)) {
    await db
      .insert(agentSessionEvent)
      .values(batch.map((row) => ({ sessionKey, ...row, createdAt })))
      .onConflictDoUpdate({
        target: [agentSessionEvent.sessionKey, agentSessionEvent.subagentId, agentSessionEvent.position],
        // The time a row was first written stays: it is when the entry began.
        set: { event: sql`excluded.${sql.identifier('event')}` },
      })
  }
}

async function writeBatch(sessionKey: string, batch: readonly PendingWrite[]): Promise<void> {
  const rows = new Map<string, StoredRow>()
  for (const { sessionId, write } of batch) {
    const bases = await resolvedBases(bindingOf(sessionKey, sessionId))
    const position = baseOf(bases, write.log) + write.position
    rows.set(`${write.log}\n${position}`, { subagentId: write.log, position, event: write.event })
  }
  const createdAt = new Date()
  await upsertRows(sessionKey, [...rows.values()], createdAt)
  let sessionEnd: number | undefined
  for (const row of rows.values()) {
    if (row.subagentId === SESSION_LOG) {
      sessionEnd = Math.max(sessionEnd ?? 0, row.position + 1)
    }
  }
  if (sessionEnd !== undefined) {
    positions.set(sessionKey, Math.max(await nextPosition(sessionKey), sessionEnd))
  }
  // In position order: a rewrite of an earlier entry in this batch is of a
  // reply still growing, and nothing the index reads stands after it yet.
  await indexRecordedEvents(
    sessionKey,
    [...rows.values()]
      .filter((row) => row.subagentId === SESSION_LOG)
      .sort((a, b) => a.position - b.position)
      .map((row) => ({ position: row.position, event: row.event, createdAt })),
  )
  // The limit is held as the log grows; the age cut waits for the sweep,
  // since a turn ages out by the clock, not by a write.
  const kept = retention()
  if (sessionEnd !== undefined && kept.maxEntries !== null) {
    await trimHistory(sessionKey, { maxEntries: kept.maxEntries, cleanupAfterDays: null }, new Date())
  }
}

// The stored position of the first turn of the session's own log that starts
// at or after `position` or at or after `since`, whichever is given; the
// newest turn when none does, which is always kept. Null for a log with none.
async function firstTurnFrom(
  sessionKey: string,
  bound: { position: number } | { since: Date },
): Promise<number | null> {
  const user = and(ofLog(sessionKey, SESSION_LOG), eq(agentSessionEvent.kind, 'user'))
  const [row] = await db
    .select({
      from: sql<number | null>`min(${agentSessionEvent.position})`,
    })
    .from(agentSessionEvent)
    .where(
      and(
        user,
        'position' in bound
          ? gte(agentSessionEvent.position, bound.position)
          : gte(agentSessionEvent.createdAt, bound.since),
      ),
    )
  if (row?.from !== null && row?.from !== undefined) {
    return row.from
  }
  const [newest] = await db
    .select({ at: sql<number | null>`max(${agentSessionEvent.position})` })
    .from(agentSessionEvent)
    .where(user)
  return newest?.at ?? null
}

/**
 * Trim one key's history to what `kept` keeps: the session's own log is cut
 * at a turn's start, so a turn is removed whole or not at all, and the newest
 * turn always stays. The logs of the subagents spawned in what was cut go
 * with it, and so do the search index's messages there. Must run in the key's
 * chain.
 */
async function trimHistory(sessionKey: string, kept: HistoryRetention, now: Date): Promise<void> {
  const range = await rangeOf(sessionKey, SESSION_LOG)
  if (!range) {
    return
  }
  const cuts: (number | null)[] = []
  if (kept.maxEntries !== null && range.last + 1 - range.first > kept.maxEntries) {
    cuts.push(await firstTurnFrom(sessionKey, { position: range.last + 1 - kept.maxEntries }))
  }
  if (kept.cleanupAfterDays !== null) {
    cuts.push(await firstTurnFrom(sessionKey, { since: new Date(now.getTime() - kept.cleanupAfterDays * DAY_MS) }))
  }
  const cutoff = Math.max(...cuts.filter((cut): cut is number => cut !== null), range.first)
  if (cutoff <= range.first) {
    return
  }
  await db.delete(agentSessionEvent).where(and(ofLog(sessionKey, SESSION_LOG), lt(agentSessionEvent.position, cutoff)))
  await dropOrphanedSubagentLogs(sessionKey)
  await dropTranscriptIndexBelow(sessionKey, cutoff)
}

const DAY_MS = 24 * 60 * 60 * 1000

// Drop the subagent logs under a key whose header no log holds any more, and
// then those of the subagents they spawned, whose headers went with them.
async function dropOrphanedSubagentLogs(sessionKey: string): Promise<void> {
  for (;;) {
    const orphans = await db
      .selectDistinct({ id: agentSessionEvent.subagentId })
      .from(agentSessionEvent)
      .where(
        and(
          eq(agentSessionEvent.sessionKey, sessionKey),
          ne(agentSessionEvent.subagentId, SESSION_LOG),
          sql`not exists (
            select 1 from ${agentSessionEvent} as header
            where header.${sql.identifier('sessionKey')} = ${sessionKey}
              and header.${sql.identifier('kind')} = 'subagent'
              and header.${sql.identifier('event')} -> 'subagent' ->> 'subagentSessionId' = ${agentSessionEvent.subagentId}
          )`,
        ),
      )
    if (orphans.length === 0) {
      return
    }
    await db.delete(agentSessionEvent).where(
      and(
        eq(agentSessionEvent.sessionKey, sessionKey),
        inArray(
          agentSessionEvent.subagentId,
          orphans.map((row) => row.id),
        ),
      ),
    )
  }
}

/**
 * Trim every recorded transcript to what the history settings keep: what the
 * age cut needs run on a clock, and what a change of the settings applies to
 * the history already recorded. Each key in its own chain, behind its live
 * writes. Answers how many keys were looked at; nothing is read when both
 * settings keep everything.
 *
 * The settings are read again for each key as its trim runs, so a change
 * made while a sweep is under way holds for every key it has not reached:
 * settings cleared then end the sweep there.
 */
export async function sweepHistory(now: Date = new Date()): Promise<{ sessions: number }> {
  if (keepsEverything(retention())) {
    return { sessions: 0 }
  }
  const keys = await db.selectDistinct({ sessionKey: agentSessionEvent.sessionKey }).from(agentSessionEvent)
  let looked = 0
  for (const { sessionKey } of keys) {
    if (keepsEverything(retention())) {
      break
    }
    looked += 1
    await flushKey(sessionKey)
    await chain(sessionKey, async () => {
      const kept = retention()
      if (!keepsEverything(kept)) {
        await trimHistory(sessionKey, kept, now)
      }
    })
  }
  return { sessions: looked }
}

function keepsEverything(kept: HistoryRetention): boolean {
  return kept.maxEntries === null && kept.cleanupAfterDays === null
}

function flushKey(sessionKey: string): Promise<void> {
  const batch = buffers.get(sessionKey)
  if (!batch || batch.size === 0) {
    return settled(sessionKey)
  }
  // Taken before the write is chained, so writes arriving while it runs start
  // the next batch instead of being written twice.
  buffers.delete(sessionKey)
  received.delete(sessionKey)
  const pending = [...batch.values()]
  return chain(sessionKey, () => writeBatch(sessionKey, pending))
}

function scheduleFlush(): void {
  if (globalRef.__agentSessionEventTimer) {
    return
  }
  const timer = setTimeout(() => {
    globalRef.__agentSessionEventTimer = undefined
    void flushSessionEvents()
  }, FLUSH_AFTER_MS)
  // A transcript waiting to be written is not a reason to hold the process open.
  timer.unref?.()
  globalRef.__agentSessionEventTimer = timer
}

/**
 * Record one write the engine made to a session's logs. Buffered — see the
 * note at the top of the file for what an unclean shutdown costs.
 *
 * Never awaited by its caller and never able to throw into one: this sits on
 * the engine's emit path, where a rejection would reach a `catch {}` and a
 * delay would reach every reader of the stream.
 */
export function recordLogWrite(sessionKey: string, sessionId: string, write: LogWrite): void {
  // Bound now rather than at the flush: a session prepared for has to take
  // its bases before another session under the key can.
  bindingOf(sessionKey, sessionId)
  let batch = buffers.get(sessionKey)
  if (!batch) {
    batch = new Map()
    buffers.set(sessionKey, batch)
    received.set(sessionKey, 0)
  }
  const key = `${sessionId}\n${write.log}\n${write.position}`
  // Deleted first so the entry moves to the end: the batch is in write order.
  batch.delete(key)
  batch.set(key, { sessionId, write })
  const count = (received.get(sessionKey) ?? 0) + 1
  received.set(sessionKey, count)
  if (count >= FLUSH_AT_EVENTS) {
    void flushKey(sessionKey)
    return
  }
  scheduleFlush()
}

/** Write every buffered write out now. */
export async function flushSessionEvents(): Promise<void> {
  await Promise.all([...buffers.keys()].map((sessionKey) => flushKey(sessionKey)))
}

/**
 * A key's recorded logs, as an engine session is seeded from them (see
 * agent-client's RecordedLogOpts): the tail of the session's own, from a
 * turn's start, the subagent logs still taking steps, and where each starts in
 * the table. `start`, `turnsBefore` and `before` are in the engine's
 * positions: the stored ones less the session's base.
 */
export interface RecordedLogs {
  events: ChatEvent[]
  subagentLogs: Map<string, ChatEvent[]>
  bases: Map<string, number>
  start: number
  turnsBefore: number
  before: PlacedEntry[]
}

// Rows of one log under a key, as stored.
function ofLog(sessionKey: string, log: string): SQL {
  return and(eq(agentSessionEvent.sessionKey, sessionKey), eq(agentSessionEvent.subagentId, log)) as SQL
}

// One log's stored entries from `from` up to `to`, in position order, in
// bounded batches: a range can be longer than one SELECT should return.
async function readRows(sessionKey: string, log: string, from: number, to: number): Promise<PlacedEntry[]> {
  const rows: PlacedEntry[] = []
  for await (const row of boundedSelect<{ position: number; event: unknown }>(db, {
    from: agentSessionEvent,
    fields: { position: agentSessionEvent.position, event: agentSessionEvent.event },
    key: [agentSessionEvent.position],
    where: and(
      ofLog(sessionKey, log),
      gte(agentSessionEvent.position, from),
      lt(agentSessionEvent.position, to),
    ) as SQL,
  })) {
    if (isChatEvent(row.event)) {
      rows.push({ position: row.position, event: row.event })
    }
  }
  return rows
}

// The first and last stored position of one log; null for a log with no rows.
async function rangeOf(sessionKey: string, log: string): Promise<{ first: number; last: number } | null> {
  const [row] = await db
    .select({
      first: sql<number | null>`min(${agentSessionEvent.position})`,
      last: sql<number | null>`max(${agentSessionEvent.position})`,
    })
    .from(agentSessionEvent)
    .where(ofLog(sessionKey, log))
  if (!row || row.first === null || row.last === null) {
    return null
  }
  return { first: row.first, last: row.last }
}

// The stored position of the newest `user` entry of a log below `position`.
async function storedTurnStartBefore(sessionKey: string, log: string, position: number): Promise<number | null> {
  const [row] = await db
    .select({ at: sql<number | null>`max(${agentSessionEvent.position})` })
    .from(agentSessionEvent)
    .where(and(ofLog(sessionKey, log), eq(agentSessionEvent.kind, 'user'), lt(agentSessionEvent.position, position)))
  return row?.at ?? null
}

// How many turns the session's own log holds below a stored position.
async function countTurns(sessionKey: string, below: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(agentSessionEvent)
    .where(
      and(ofLog(sessionKey, SESSION_LOG), eq(agentSessionEvent.kind, 'user'), lt(agentSessionEvent.position, below)),
    )
  return row?.count ?? 0
}

// The state kinds a session folds the newest of (agent-client's
// foldRestoredState): one each is all a session needs from below its tail.
const STATE_KINDS = ['modes', 'mode_changed', 'config_options', 'available_commands', 'session_info', 'plan', 'usage']

// The entries below `below` in the session's own log that its state still
// comes from, oldest first: the newest of each state kind (a title-bearing
// one for `session_info`, the only field read from it), and every subagent,
// background task and compaction not ended.
async function stateBelow(sessionKey: string, below: number): Promise<PlacedEntry[]> {
  const own = and(ofLog(sessionKey, SESSION_LOG), lt(agentSessionEvent.position, below)) as SQL
  const newest = await db
    .selectDistinctOn([agentSessionEvent.kind], {
      position: agentSessionEvent.position,
      event: agentSessionEvent.event,
    })
    .from(agentSessionEvent)
    .where(
      and(
        own,
        inArray(agentSessionEvent.kind, STATE_KINDS),
        or(ne(agentSessionEvent.kind, 'session_info'), sql`${agentSessionEvent.event} ->> 'title' is not null`),
      ),
    )
    .orderBy(agentSessionEvent.kind, desc(agentSessionEvent.position))
  const open = await db
    .select({ position: agentSessionEvent.position, event: agentSessionEvent.event })
    .from(agentSessionEvent)
    .where(
      and(
        own,
        or(
          and(
            eq(agentSessionEvent.kind, 'subagent'),
            sql`${agentSessionEvent.event} -> 'subagent' ->> 'state' is null`,
          ),
          and(
            eq(agentSessionEvent.kind, 'async_task'),
            sql`${agentSessionEvent.event} -> 'task' ->> 'state' in ('running', 'paused')`,
          ),
          and(
            eq(agentSessionEvent.kind, 'compaction'),
            sql`${agentSessionEvent.event} -> 'compaction' ->> 'status' not in ('completed', 'failed')`,
          ),
        ),
      ),
    )
  return [...newest, ...open]
    .filter((row): row is PlacedEntry => isChatEvent(row.event))
    .sort((a, b) => a.position - b.position)
}

// The subagents of a key still taking steps: those whose header, in whichever
// log it stands, has no state.
async function runningSubagents(sessionKey: string): Promise<string[]> {
  const rows = await db
    .select({ id: sql<string | null>`${agentSessionEvent.event} -> 'subagent' ->> 'subagentSessionId'` })
    .from(agentSessionEvent)
    .where(
      and(
        eq(agentSessionEvent.sessionKey, sessionKey),
        eq(agentSessionEvent.kind, 'subagent'),
        sql`${agentSessionEvent.event} -> 'subagent' ->> 'state' is null`,
      ),
    )
  return rows.flatMap((row) => (row.id ? [row.id] : []))
}

// A subagent's whole log as stored, from position 0, its base.
async function readSubagentLog(sessionKey: string, subagentId: string): Promise<ChatEvent[]> {
  const range = await rangeOf(sessionKey, subagentId)
  if (!range) {
    return []
  }
  const { start, events } = contiguous(await readRows(sessionKey, subagentId, 0, range.last + 1), range.last + 1)
  return [...Array.from({ length: start }, () => MISSING_ENTRY), ...events]
}

/**
 * The transcript recorded under a key, as a reopen seeds a session with it:
 * the tail of the session's own log, from the start of the newest turn that
 * leaves at least TAIL_ENTRIES entries (the whole log, when it is shorter or
 * has no such turn), the state below it, and the logs of the subagents still
 * running, whole. What the tail leaves out is read through
 * `sessionHistoryPort`.
 *
 * Flushes this key's own buffer first: a session reopened moments after it was
 * unloaded would otherwise come back missing the tail of its last turn, which
 * is the part a reader was looking at. Rows of the layout before compaction
 * are rewritten first.
 */
export async function readSessionLogs(sessionKey: string): Promise<RecordedLogs> {
  await rewriteLegacyKey(sessionKey)
  const range = await rangeOf(sessionKey, SESSION_LOG)
  if (!range) {
    const next = await nextPosition(sessionKey)
    return {
      events: [],
      subagentLogs: new Map(),
      bases: new Map([[SESSION_LOG, next]]),
      start: 0,
      turnsBefore: 0,
      before: [],
    }
  }
  const base = range.first
  const end = range.last + 1
  const tailFrom =
    end - base > TAIL_ENTRIES
      ? ((await storedTurnStartBefore(sessionKey, SESSION_LOG, end - TAIL_ENTRIES + 1)) ?? base)
      : base
  const own = contiguous(await readRows(sessionKey, SESSION_LOG, tailFrom, end), end)
  const subagentLogs = new Map<string, ChatEvent[]>()
  const bases = new Map<string, number>([[SESSION_LOG, base]])
  for (const id of await runningSubagents(sessionKey)) {
    const log = await readSubagentLog(sessionKey, id)
    if (log.length > 0) {
      subagentLogs.set(id, log)
      bases.set(id, 0)
    }
  }
  const below = tailFrom > base ? await stateBelow(sessionKey, tailFrom) : []
  return {
    events: own.events,
    subagentLogs,
    bases,
    start: own.start - base,
    turnsBefore: tailFrom > base ? await countTurns(sessionKey, tailFrom) : 0,
    before: below.map((entry) => ({ position: entry.position - base, event: entry.event })),
  }
}

// A reader over one log's stored rows, in positions less `base`.
function storedReader(sessionKey: string, log: string, base: number, end: number): LogReader {
  return {
    end,
    read: async (from, to) => {
      const rows = await readRows(sessionKey, log, base + from, base + to)
      return contiguous(
        rows.map((row) => ({ position: row.position - base, event: row.event })),
        to,
      )
    },
    turnStartBefore: async (position) => {
      const at = await storedTurnStartBefore(sessionKey, log, base + position)
      return at === null || at < base ? null : at - base
    },
  }
}

/**
 * The session's own log as recorded under a key, as a reader: what a listing
 * of an offline session's turns pages through. Positions are what a reopen
 * gives the engine: the stored ones less the first. Rows of the layout before
 * compaction are rewritten first, so the positions are the ones a reopen
 * gives too.
 */
export async function storedLogReader(sessionKey: string): Promise<LogReader> {
  await rewriteLegacyKey(sessionKey)
  const range = await rangeOf(sessionKey, SESSION_LOG)
  return range
    ? storedReader(sessionKey, SESSION_LOG, range.first, range.last + 1 - range.first)
    : storedReader(sessionKey, SESSION_LOG, 0, 0)
}

/**
 * Seed an engine session's bases: the session `sessionId` under `sessionKey`
 * holds the logs read with them (readSessionLogs). Set before the session is
 * restored, since it may write as it is.
 */
export function attachSessionLogs(sessionKey: string, sessionId: string, bases: ReadonlyMap<string, number>): void {
  bindings.set(sessionId, { sessionKey, bases: new Map(bases), resolved: true })
  prepared.delete(sessionKey)
}

/**
 * Bases for the next engine session to write under `sessionKey`, for a session
 * about to be created from recorded logs whose id is not known yet. One
 * session is opened under a key at a time, so the next is this one. Null
 * withdraws them, for a creation that failed.
 */
export function prepareSessionLogs(sessionKey: string, bases: ReadonlyMap<string, number> | null): void {
  if (bases) {
    prepared.set(sessionKey, new Map(bases))
  } else {
    prepared.delete(sessionKey)
  }
}

/**
 * The stored position of an engine session's entry, in its own log: where a
 * search hit and the engine's log meet. Null for a session that has not
 * written under the key.
 */
async function sessionBase(sessionKey: string, sessionId: string): Promise<number | null> {
  const binding = bindings.get(sessionId)
  if (!binding || binding.sessionKey !== sessionKey) {
    return null
  }
  return (await resolvedBases(binding)).get(SESSION_LOG) ?? null
}

/**
 * The engine position of a stored position of the session's own log, for the
 * engine session `sessionId` under `sessionKey`: where a search hit and the
 * engine's log meet. Null for a session that has not written under the key.
 */
export async function enginePositionOf(
  sessionKey: string,
  sessionId: string,
  position: number,
): Promise<number | null> {
  const base = await sessionBase(sessionKey, sessionId)
  return base === null ? null : position - base
}

/**
 * Where an engine session's logs are read back: the rows it wrote and was
 * seeded from, in its own positions. A read flushes the key first, so it sees
 * every write the session handed over (see agent-client's HistoryPort).
 */
export const sessionHistoryPort: HistoryPort = {
  async read(sessionId, log, from, to) {
    const located = await locateLog(sessionId, log)
    if (!located) {
      return []
    }
    const rows = await readRows(located.sessionKey, log, located.base + from, located.base + to)
    return rows.map((row) => ({ position: row.position - located.base, event: row.event }))
  },
  async turnStartBefore(sessionId, log, position) {
    const located = await locateLog(sessionId, log)
    if (!located) {
      return null
    }
    const at = await storedTurnStartBefore(located.sessionKey, log, located.base + position)
    return at === null || at < located.base ? null : at - located.base
  },
  async end(sessionId, log) {
    const located = await locateLog(sessionId, log)
    const range = located ? await rangeOf(located.sessionKey, log) : null
    return located && range ? Math.max(0, range.last + 1 - located.base) : 0
  },
}

// The key an engine session writes under and a log's base there, once the
// key's buffer is flushed; null for a session that has written nowhere.
async function locateLog(sessionId: string, log: string): Promise<{ sessionKey: string; base: number } | null> {
  const binding = bindings.get(sessionId)
  if (!binding) {
    return null
  }
  await flushKey(binding.sessionKey)
  return { sessionKey: binding.sessionKey, base: (await resolvedBases(binding)).get(log) ?? 0 }
}

// A stored row is read straight back into the union it was written from, so
// the only thing worth checking is that it still looks like one at all — a row
// that does not is skipped rather than handed on as an event with no kind,
// which every consumer would switch on and silently ignore anyway.
function isChatEvent(value: unknown): value is ChatEvent {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

// Forget which engine sessions write under a key: whatever writes there next
// is a new session, numbered past what the key holds.
function unbindKey(sessionKey: string): void {
  for (const [sessionId, binding] of bindings) {
    if (binding.sessionKey === sessionKey) {
      bindings.delete(sessionId)
    }
  }
  prepared.delete(sessionKey)
}

/**
 * Drop the logs recorded under a key whose conversation lives on: a session
 * never spoken to that is started afresh, or a recording about to be replaced.
 * The search index keeps the conversation's history, and numbering continues
 * past it, so nothing recorded afterwards takes a position a kept message
 * names.
 */
export async function clearSessionEvents(sessionKey: string): Promise<void> {
  buffers.delete(sessionKey)
  await settled(sessionKey)
  unbindKey(sessionKey)
  await db.delete(agentSessionEvent).where(eq(agentSessionEvent.sessionKey, sessionKey))
  await db.delete(agentSessionLegacyLog).where(eq(agentSessionLegacyLog.sessionKey, sessionKey))
}

/**
 * Forget everything recorded under a key that is being retired for good: the
 * logs, the search index and the numbering.
 *
 * The host's call, exactly like the durable queue's `clear`: dropping a live
 * session also happens when a process is stopped and the conversation is meant
 * to survive, and retiring there would throw away the transcript this exists
 * to keep.
 */
export async function retireSessionTranscript(sessionKey: string): Promise<void> {
  await clearSessionEvents(sessionKey)
  await clearTranscriptIndex(sessionKey)
  positions.delete(sessionKey)
}

/**
 * An engine session's logs as a fork or an edit leaves them: what it holds of
 * its own, from log position `start` (agent-client's getLogStart), and the
 * subagent logs it holds.
 */
export interface SessionLogsSnapshot {
  sessionId: string
  start: number
  events: readonly ChatEvent[]
  subagentLogs: ReadonlyMap<string, readonly ChatEvent[]>
}

// Write what a session holds of its logs, its own log's entry 0 standing at
// `base` (so its first held entry at `base + start`), each subagent's from 0,
// and bind the session to those bases.
async function writeLogs(sessionKey: string, logs: SessionLogsSnapshot, base: number): Promise<void> {
  const written = new Map<string, number>([[SESSION_LOG, base]])
  const rows: StoredRow[] = logs.events.map((event, offset) => ({
    subagentId: SESSION_LOG,
    position: base + logs.start + offset,
    event,
  }))
  for (const [subagentId, log] of logs.subagentLogs) {
    written.set(subagentId, 0)
    log.forEach((event, position) => {
      rows.push({ subagentId, position, event })
    })
  }
  await upsertRows(sessionKey, rows, new Date())
  positions.set(sessionKey, base + logs.start + logs.events.length)
  bindings.set(logs.sessionId, { sessionKey, bases: written, resolved: true })
}

// The subagents spawned at or after stored position `from` of the session's
// own log, with the ones they spawned: the logs a conversation cut there
// leaves behind.
async function subagentsSpawnedFrom(sessionKey: string, from: number): Promise<string[]> {
  const headerId = sql<string | null>`${agentSessionEvent.event} -> 'subagent' ->> 'subagentSessionId'`
  const found = new Set<string>()
  let logs: string[] = [SESSION_LOG]
  while (logs.length > 0) {
    const rows = await db
      .select({ id: headerId })
      .from(agentSessionEvent)
      .where(
        and(
          eq(agentSessionEvent.sessionKey, sessionKey),
          inArray(agentSessionEvent.subagentId, logs),
          eq(agentSessionEvent.kind, 'subagent'),
          // Below `from` only in the session's own log: every header in a
          // dropped subagent's log is dropped with it.
          or(ne(agentSessionEvent.subagentId, SESSION_LOG), gte(agentSessionEvent.position, from)),
        ),
      )
    logs = rows.flatMap((row) => (row.id && !found.has(row.id) ? [row.id] : []))
    for (const id of logs) {
      found.add(id)
    }
  }
  return [...found]
}

/**
 * Cut the recording of a conversation an edit has rewound: the edited turn's
 * question stood at `editedIndex` in the log of `sourceSessionId`, and `fork`
 * is the session that carries the conversation on, holding the history the
 * source held up to that turn, at the same positions.
 *
 * The edited turn's stored position is the source's base plus its index.
 * Everything from there on goes, in the session's own log and in the logs of
 * the subagents spawned there, and so does what the index holds of it; the
 * history below stays where it is. What the fork holds is written over its
 * rows (it can differ from the source in what restoring changes, such as
 * emptied queue snapshots), and the fork writes on under the same base.
 */
export async function rerecordEditedSession(
  sessionKey: string,
  sourceSessionId: string,
  editedIndex: number,
  fork: SessionLogsSnapshot,
): Promise<void> {
  // Flushed rather than dropped: the source's base can depend on its first
  // batch, and the rows it lands are cut or replaced below anyway.
  await flushKey(sessionKey)
  await chain(sessionKey, async () => {
    const binding = bindings.get(sourceSessionId)
    const base =
      (binding?.sessionKey === sessionKey ? (await resolvedBases(binding)).get(SESSION_LOG) : undefined) ??
      (await nextPosition(sessionKey))
    const cut = base + editedIndex
    const dropped = await subagentsSpawnedFrom(sessionKey, cut)
    await db
      .delete(agentSessionEvent)
      .where(and(ofLog(sessionKey, SESSION_LOG), gte(agentSessionEvent.position, base + fork.start)))
    if (dropped.length > 0) {
      await db
        .delete(agentSessionEvent)
        .where(and(eq(agentSessionEvent.sessionKey, sessionKey), inArray(agentSessionEvent.subagentId, dropped)))
    }
    // The fork's log ends where the edited turn began; its next entry is the
    // first the index has not seen.
    const end = base + fork.start + fork.events.length
    await truncateTranscriptIndex(sessionKey, Math.min(cut, end), end)
    await writeLogs(sessionKey, fork, base)
  })
}

/**
 * Record a fork's logs under the key minted for its own conversation: what it
 * kept was copied, not emitted, so nothing else records it. Numbered from the
 * key's next free position, and indexed like any other history.
 *
 * What the fork does not hold comes from the recording of `source`, the
 * session it was forked from, copied across in the database: the source's own
 * rows below the fork's start, when it holds only the tail of its history
 * (`fork.start` past 0), indexed as they are copied; and the logs of the
 * subagents spawned before the fork's end that the fork does not hold: a
 * source that was reopened holds only the logs of subagents still running.
 */
export async function recordForkedSession(
  sessionKey: string,
  fork: SessionLogsSnapshot,
  source?: { sessionKey: string; sessionId: string },
): Promise<void> {
  await flushKey(sessionKey)
  if (source) {
    await flushKey(source.sessionKey)
  }
  await chain(sessionKey, async () => {
    const base = await nextPosition(sessionKey)
    if (source) {
      await copyHistoryBelow(source, sessionKey, base, fork)
    }
    await writeLogs(sessionKey, fork, base)
    const createdAt = new Date()
    await indexRecordedEvents(
      sessionKey,
      fork.events.map((event, offset) => ({ position: base + fork.start + offset, event, createdAt })),
    )
  })
}

// Copy the history a fork does not hold from the session it was forked from:
// the source's own log below the fork's start, renumbered onto `base`, and
// every subagent log neither the fork holds nor a subagent spawned at or
// after the fork's end has, where it stands. Indexed in order as it lands.
async function copyHistoryBelow(
  source: { sessionKey: string; sessionId: string },
  sessionKey: string,
  base: number,
  fork: SessionLogsSnapshot,
): Promise<void> {
  const binding = bindings.get(source.sessionId)
  const sourceBase =
    binding?.sessionKey === source.sessionKey ? (await resolvedBases(binding)).get(SESSION_LOG) : undefined
  if (sourceBase === undefined) {
    return
  }
  const below = sourceBase + fork.start
  if (fork.start > 0) {
    await copyRows(
      sessionKey,
      base - sourceBase,
      and(
        ofLog(source.sessionKey, SESSION_LOG),
        gte(agentSessionEvent.position, sourceBase),
        lt(agentSessionEvent.position, below),
      ) as SQL,
    )
  }
  const end = below + fork.events.length
  const excluded = [...fork.subagentLogs.keys(), ...(await subagentsSpawnedFrom(source.sessionKey, end))]
  await copyRows(
    sessionKey,
    0,
    and(
      eq(agentSessionEvent.sessionKey, source.sessionKey),
      ne(agentSessionEvent.subagentId, SESSION_LOG),
      excluded.length > 0 ? notInArray(agentSessionEvent.subagentId, excluded) : undefined,
    ) as SQL,
  )
  // Indexed from the copy, a bounded batch at a time, in position order.
  let pending: { position: number; event: ChatEvent; createdAt: Date }[] = []
  for await (const row of boundedSelect<{ position: number; event: unknown; createdAt: Date }>(db, {
    from: agentSessionEvent,
    fields: {
      position: agentSessionEvent.position,
      event: agentSessionEvent.event,
      createdAt: agentSessionEvent.createdAt,
    },
    key: [agentSessionEvent.position],
    where: and(ofLog(sessionKey, SESSION_LOG), lt(agentSessionEvent.position, base + fork.start)) as SQL,
  })) {
    if (isChatEvent(row.event)) {
      pending.push({ position: row.position, event: row.event, createdAt: row.createdAt })
    }
    if (pending.length >= ROWS_PER_INSERT) {
      await indexRecordedEvents(sessionKey, pending)
      pending = []
    }
  }
  if (pending.length > 0) {
    await indexRecordedEvents(sessionKey, pending)
  }
}

// Copy the rows `where` picks to key `to` in the database, each moved `shift`
// positions; the time each was first written stays.
async function copyRows(to: string, shift: number, where: SQL): Promise<void> {
  const column = (name: string) => sql.identifier(name)
  await db.execute(sql`
    insert into ${agentSessionEvent} (${column('sessionKey')}, ${column('subagentId')}, ${column('position')}, ${column('event')}, ${column('createdAt')})
    select ${to}, ${agentSessionEvent.subagentId}, ${agentSessionEvent.position} + ${shift}, ${agentSessionEvent.event}, ${agentSessionEvent.createdAt}
    from ${agentSessionEvent}
    where ${where}
  `)
}

/**
 * Let a harness replay a conversation's history into a recording that has
 * just been cleared for it. The index already holds that history, so it is
 * held while the replay is recorded and then moved past it -- neither wiped
 * nor written twice. A conversation the index holds nothing for is indexed
 * from the replay like any other events.
 */
export async function recordReplay<T>(sessionKey: string, replay: () => Promise<T>): Promise<T> {
  await settled(sessionKey)
  const holding = await holdForReplay(sessionKey)
  try {
    return await replay()
  } finally {
    if (holding) {
      await flushKey(sessionKey)
      await chain(sessionKey, async () => releaseAfterReplay(sessionKey, await nextPosition(sessionKey)))
    }
  }
}

/**
 * Carry the transcript held under one session key onto another.
 *
 * A session key is derived from something renameable, so a rename re-mints it
 * and everything filed under the old one has to move with it — left behind, a
 * conversation's whole history is unreachable under a name nothing looks up
 * again, and the next open falls back to the harness's replay as though the
 * recording had never been made.
 */
export async function moveSessionEvents(moves: readonly { from: string; to: string }[]): Promise<void> {
  for (const { from, to } of moves) {
    if (!from || !to || from === to) {
      continue
    }
    // Both sides quiesced first: a batch still in flight for either key would
    // land after the move and be filed under a name the move has already
    // passed over.
    await flushKey(from)
    await settled(to)
    await db.update(agentSessionEvent).set({ sessionKey: to }).where(eq(agentSessionEvent.sessionKey, from))
    const legacy = await db.delete(agentSessionLegacyLog).where(eq(agentSessionLegacyLog.sessionKey, from)).returning()
    if (legacy.length > 0) {
      await db.insert(agentSessionLegacyLog).values({ sessionKey: to }).onConflictDoNothing()
    }
    await moveTranscriptIndex(from, to)
    for (const binding of bindings.values()) {
      if (binding.sessionKey === from) {
        binding.sessionKey = to
      }
    }
    for (const key of [from, to]) {
      positions.delete(key)
    }
  }
}

/**
 * Bring the search index up to date with every recorded transcript.
 *
 * Covers what live indexing could not: history recorded before the index
 * existed, and a reply a stopped process left open. Each session goes through
 * the same per-key chain as its live writes, so a session that is streaming
 * while this runs is caught up exactly once, by whichever reaches it first.
 * Idempotent: a second run finds nothing behind. History trimmed before the
 * index existed is gone and cannot be indexed.
 *
 * Answers how many sessions it wrote messages for, so the caller can tell
 * "nothing to do" from work done.
 */
export async function catchUpTranscriptIndex(): Promise<{ sessions: number }> {
  let sessions = 0
  for (const sessionKey of await sessionsBehindIndex()) {
    await flushKey(sessionKey)
    await chain(sessionKey, async () => {
      if (await catchUpSession(sessionKey, await nextPosition(sessionKey))) {
        sessions += 1
      }
    })
  }
  return { sessions }
}

/** What rewriting a key into the compacted layout changed: its rows, and their stored JSON's length, before and after. */
export interface LegacyRewrite {
  rowsBefore: number
  rowsAfter: number
  bytesBefore: number
  bytesAfter: number
}

/**
 * Rewrite a key's rows into the compacted layout if AgentSessionLegacyLog
 * still lists it, behind whatever is queued for the key: one transaction
 * replaces the rows, moves the search index's positions and takes the key
 * off the list. Null if it was not listed, if `unlessBound` and an engine
 * session here writes under it, or if the rewrite failed: that is logged, and
 * the rows stay as they were for the next attempt, read back uncompacted.
 */
async function rewriteLegacyKey(
  sessionKey: string,
  opts: { unlessBound?: boolean } = {},
): Promise<LegacyRewrite | null> {
  await flushKey(sessionKey)
  let done: LegacyRewrite | null = null
  await chain(sessionKey, async () => {
    if (opts.unlessBound && [...bindings.values()].some((binding) => binding.sessionKey === sessionKey)) {
      return
    }
    try {
      done = await rewriteListedKey(sessionKey)
    } catch (error) {
      console.error('[session-event-store] rewriting a transcript into the compacted layout failed', sessionKey, error)
    }
  })
  return done
}

async function rewriteListedKey(sessionKey: string): Promise<LegacyRewrite | null> {
  const [listed] = await db.select().from(agentSessionLegacyLog).where(eq(agentSessionLegacyLog.sessionKey, sessionKey))
  if (!listed) {
    return null
  }
  const rewriter = new LogRewriter()
  const counts = { rowsBefore: 0, bytesBefore: 0 }
  const take = (row: LogRow) => {
    counts.rowsBefore += 1
    counts.bytesBefore += JSON.stringify(row.event).length
  }
  let first: number | undefined
  let oldEnd = 0
  for await (const row of storedRows(ofLog(sessionKey, SESSION_LOG))) {
    take(row)
    first ??= row.position
    oldEnd = row.position + 1
    rewriter.addOwn(row)
  }
  for await (const row of storedRows(
    and(eq(agentSessionEvent.sessionKey, sessionKey), ne(agentSessionEvent.subagentId, SESSION_LOG)) as SQL,
  )) {
    take(row)
    rewriter.addSubagent(row)
  }
  const { rows, remap } = rewriter.finish()
  // Settled first, so every position the index names is a message's start
  // and its cursor stands past the rows.
  await settleTranscriptIndex(sessionKey, oldEnd)
  const index = await planIndexRemap(sessionKey, first ?? 0, remap)
  await db.transaction(async (tx) => {
    await tx.delete(agentSessionEvent).where(eq(agentSessionEvent.sessionKey, sessionKey))
    for await (const batch of inBudget(rows, (row) => JSON.stringify(row.event).length, ROWS_PER_INSERT)) {
      await tx.insert(agentSessionEvent).values(batch.map((row) => ({ sessionKey, ...row })))
    }
    await applyIndexRemap(tx, sessionKey, index)
    await tx.delete(agentSessionLegacyLog).where(eq(agentSessionLegacyLog.sessionKey, sessionKey))
  })
  // Positions and bases this process held for the key were the old ones.
  positions.delete(sessionKey)
  unbindKey(sessionKey)
  return {
    ...counts,
    rowsAfter: rows.length,
    bytesAfter: rows.reduce((sum, row) => sum + JSON.stringify(row.event).length, 0),
  }
}

// The rows `where` picks, in (log, position) order, in bounded batches.
async function* storedRows(where: SQL): AsyncGenerator<LogRow> {
  for await (const row of boundedSelect<{ subagentId: string; position: number; event: unknown; createdAt: Date }>(db, {
    from: agentSessionEvent,
    fields: {
      subagentId: agentSessionEvent.subagentId,
      position: agentSessionEvent.position,
      event: agentSessionEvent.event,
      createdAt: agentSessionEvent.createdAt,
    },
    key: [agentSessionEvent.subagentId, agentSessionEvent.position],
    where,
  })) {
    if (isChatEvent(row.event)) {
      yield { subagentId: row.subagentId, position: row.position, event: row.event, createdAt: row.createdAt }
    }
  }
}

/**
 * Rewrite every key AgentSessionLegacyLog still lists into the compacted
 * layout, one at a time, each behind its own live writes. A key an engine
 * session here writes under is left for its next reopen. Answers what it
 * rewrote, and how many keys are still listed after it (left, or failed).
 */
export async function rewriteLegacyTranscripts(): Promise<LegacyRewrite & { sessions: number; left: number }> {
  const total = { sessions: 0, rowsBefore: 0, rowsAfter: 0, bytesBefore: 0, bytesAfter: 0 }
  const listed = await db.select({ sessionKey: agentSessionLegacyLog.sessionKey }).from(agentSessionLegacyLog)
  for (const { sessionKey } of listed) {
    const done = await rewriteLegacyKey(sessionKey, { unlessBound: true })
    if (done) {
      total.sessions += 1
      total.rowsBefore += done.rowsBefore
      total.rowsAfter += done.rowsAfter
      total.bytesBefore += done.bytesBefore
      total.bytesAfter += done.bytesAfter
    }
  }
  const [still] = await db.select({ count: sql<number>`count(*)::int` }).from(agentSessionLegacyLog)
  return { ...total, left: still?.count ?? 0 }
}
