// Keeps TranscriptMessage current as the event store records a session.
//
// The event store calls in after each batch has been written, inside its own
// per-key write chain, so batches of one session are indexed in order and
// never two at once. What is cut into messages, and when, is the pure rule in
// transcript-messages.ts; this holds the state between batches and writes the
// result.
//
// THE INDEX NEVER COSTS THE TRANSCRIPT. It is written after the events and in
// a transaction of its own, so a failure here is logged and loses search text,
// never an event. The state is then dropped, and the next batch reads it back
// from the cursor and the event store, which still hold everything since the
// last write that succeeded.
//
// A reply's text is held here until it ends (see transcript-messages.ts for
// the bound on how much), so the cursor in TranscriptMessageCursor marks where
// the written rows stop. A process that did not see what came after -- after a
// restart, or for history recorded before the index existed -- replays the
// events from there, kind and text only.

import { agentSessionEvent, db, transcriptMessage, transcriptMessageCursor } from '@opencroft/db'
import { boundedSelect } from '@opencroft/db/bounded-select'
import type { ChatEvent } from 'agent-client/types'
import { and, eq, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm'

import {
  endOpenReply,
  INITIAL_STATE,
  type IndexState,
  type IndexStep,
  indexEvents,
  type RecordedEvent,
} from '@/app/_authed/(agent)/_server/transcript-messages'

// Survives a dev hot-reload, for the same reason the event store's buffers do.
const globalRef = globalThis as typeof globalThis & {
  __transcriptIndexStates?: Map<string, IndexState>
  __transcriptIndexOwnKeys?: Set<string>
  __transcriptIndexHeld?: Set<string>
}
globalRef.__transcriptIndexStates ??= new Map()
globalRef.__transcriptIndexOwnKeys ??= new Set()
globalRef.__transcriptIndexHeld ??= new Set()

/**
 * Each key's state as this process last left it, held reply text included.
 * Absent for a key this process has not indexed yet, or whose last index write
 * failed: the next batch reads the state back instead.
 */
const states = globalRef.__transcriptIndexStates
/**
 * Keys this process has indexed live. A reply open under one of them is being
 * streamed here, so reading the state back after a failed write must not end
 * it; under any other key the process that streamed it is gone.
 */
const ownKeys = globalRef.__transcriptIndexOwnKeys
/** Keys whose events are a harness replay of history the index already holds (see holdForReplay). */
const held = globalRef.__transcriptIndexHeld

/** Index a batch the event store has just recorded. Never throws. */
export async function indexRecordedEvents(sessionKey: string, events: readonly RecordedEvent[]): Promise<void> {
  const first = events[0]
  if (!first || held.has(sessionKey)) {
    return
  }
  try {
    const before = states.get(sessionKey) ?? (await readBack(sessionKey, first.position))
    ownKeys.add(sessionKey)
    const step = indexEvents(before, events)
    if (step.persist) {
      await writeStep(sessionKey, step)
    }
    states.set(sessionKey, step.state)
  } catch (error) {
    states.delete(sessionKey)
    console.error('[transcript-index] search index write failed', sessionKey, error)
  }
}

/**
 * The sessions whose recorded events the index has not caught up with: no
 * cursor at all (recorded before the index existed), events past the cursor,
 * or a reply left open by a process that has since stopped.
 */
export async function sessionsBehindIndex(): Promise<string[]> {
  const recorded = db
    .select({
      sessionKey: agentSessionEvent.sessionKey,
      last: sql<number>`max(${agentSessionEvent.position})`.as('last'),
    })
    .from(agentSessionEvent)
    .groupBy(agentSessionEvent.sessionKey)
    .as('recorded')
  const rows = await db
    .select({ sessionKey: recorded.sessionKey })
    .from(recorded)
    .leftJoin(transcriptMessageCursor, eq(transcriptMessageCursor.sessionKey, recorded.sessionKey))
    .where(
      or(
        isNull(transcriptMessageCursor.sessionKey),
        sql`${transcriptMessageCursor.resumeFrom} <= ${recorded.last}`,
        isNotNull(transcriptMessageCursor.openPosition),
      ),
    )
  return rows.map((row) => row.sessionKey)
}

/**
 * Bring one session's index up to `before` (the next position the event store
 * will assign), unless this process is already indexing it live. Answers
 * whether it wrote anything. Must run in the event store's chain for the key.
 */
export async function catchUpSession(sessionKey: string, before: number): Promise<boolean> {
  if (states.has(sessionKey)) {
    return false
  }
  const written = { any: false }
  states.set(sessionKey, await readBack(sessionKey, before, written))
  return written.any
}

/**
 * The first position nothing in the index refers to: the cursor's resume
 * point, which every written row lies below. What the event store numbers from
 * after its own events have been cleared, so a kept row can never be confused
 * with an event recorded later.
 */
export async function indexedThrough(sessionKey: string): Promise<number> {
  const [cursor] = await db
    .select({ resumeFrom: transcriptMessageCursor.resumeFrom })
    .from(transcriptMessageCursor)
    .where(eq(transcriptMessageCursor.sessionKey, sessionKey))
  return cursor?.resumeFrom ?? 0
}

/**
 * Cut the index back to before `cut` for a conversation that has been rewound
 * there -- an edited turn and everything after it no longer exist -- and
 * account for every event before `resumeFrom` as already indexed, because the
 * event store is about to record the kept history again below it. A reply this
 * process holds that began before the cut is written out first.
 *
 * Must run in the event store's chain for the key.
 */
export async function truncateTranscriptIndex(sessionKey: string, cut: number, resumeFrom: number): Promise<void> {
  const holding = states.get(sessionKey)
  const ended = holding?.open && holding.open.position < cut ? endOpenReply(holding, holding.resumeFrom).rows : []
  const turn = await db.transaction(async (tx) => {
    if (ended.length > 0) {
      await tx
        .insert(transcriptMessage)
        .values(ended.map((row) => ({ sessionKey, ...row })))
        .onConflictDoNothing()
    }
    await tx
      .delete(transcriptMessage)
      .where(and(eq(transcriptMessage.sessionKey, sessionKey), gte(transcriptMessage.position, cut)))
    const [last] = await tx
      .select({ turn: sql<number | null>`max(${transcriptMessage.turn})` })
      .from(transcriptMessage)
      .where(eq(transcriptMessage.sessionKey, sessionKey))
    const kept = last?.turn ?? null
    const cursor = { resumeFrom, turn: kept, openPosition: null, openSegment: 0 }
    await tx
      .insert(transcriptMessageCursor)
      .values({ sessionKey, ...cursor })
      .onConflictDoUpdate({ target: transcriptMessageCursor.sessionKey, set: cursor })
    return kept
  })
  states.set(sessionKey, { resumeFrom, turn, open: null })
  ownKeys.add(sessionKey)
}

/**
 * Stop indexing a key while a harness replays its history, when the index
 * already holds that history -- answers whether it did. A key the index holds
 * nothing for is left alone, so its replay is indexed like any other events.
 * Must be followed by `releaseAfterReplay` in the event store's chain.
 *
 * The hold lives in this process: one that stops mid-replay leaves the cursor
 * where it was, and the next process indexes the replayed events again.
 */
export async function holdForReplay(sessionKey: string): Promise<boolean> {
  if ((await indexedThrough(sessionKey)) === 0) {
    return false
  }
  held.add(sessionKey)
  return true
}

/**
 * End a replay hold: every event before `next` was the replay, already in the
 * rows, so the cursor moves past it. Must run in the event store's chain.
 */
export async function releaseAfterReplay(sessionKey: string, next: number): Promise<void> {
  held.delete(sessionKey)
  states.delete(sessionKey)
  await truncateTranscriptIndex(sessionKey, next, next)
}

/** Forget everything indexed under a key that is being retired. */
export async function clearTranscriptIndex(sessionKey: string): Promise<void> {
  states.delete(sessionKey)
  ownKeys.delete(sessionKey)
  held.delete(sessionKey)
  await db.transaction(async (tx) => {
    await tx.delete(transcriptMessage).where(eq(transcriptMessage.sessionKey, sessionKey))
    await tx.delete(transcriptMessageCursor).where(eq(transcriptMessageCursor.sessionKey, sessionKey))
  })
}

/**
 * Carry what is indexed under one key onto another. The held state is dropped
 * rather than carried: the next batch under the new key reads it back from the
 * moved cursor and events. What does carry is that this process is the one
 * streaming the session, so that read-back continues a held reply instead of
 * ending it.
 */
export async function moveTranscriptIndex(from: string, to: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(transcriptMessage).set({ sessionKey: to }).where(eq(transcriptMessage.sessionKey, from))
    await tx.update(transcriptMessageCursor).set({ sessionKey: to }).where(eq(transcriptMessageCursor.sessionKey, from))
  })
  states.delete(from)
  states.delete(to)
  if (ownKeys.delete(from)) {
    ownKeys.add(to)
  }
}

// The state as of `before`, from the cursor and the events recorded since it.
// A reply still open at the end is ended unless this process is streaming it.
async function readBack(sessionKey: string, before: number, written?: { any: boolean }): Promise<IndexState> {
  const [cursor] = await db
    .select()
    .from(transcriptMessageCursor)
    .where(eq(transcriptMessageCursor.sessionKey, sessionKey))
  const from: IndexState = cursor
    ? {
        resumeFrom: cursor.resumeFrom,
        turn: cursor.turn,
        open:
          cursor.openPosition === null
            ? null
            : {
                position: cursor.openPosition,
                segment: cursor.openSegment,
                text: '',
                createdAt: await replyStartedAt(sessionKey, cursor.openPosition),
              },
      }
    : INITIAL_STATE
  const replayed = indexEvents(from, await readTextEvents(sessionKey, from.resumeFrom, before))
  const step = ownKeys.has(sessionKey) ? replayed : followedBy(replayed, endOpenReply(replayed.state, before))
  // Nothing held means every event before `before` is accounted for, so the
  // cursor moves past any that carried no text and this is not read again.
  if (step.state.open === null && step.state.resumeFrom < before) {
    step.state.resumeFrom = before
    step.persist = true
  }
  if (step.persist || !cursor) {
    await writeStep(sessionKey, step)
    if (written) {
      written.any = step.rows.length > 0
    }
  }
  return step.state
}

// When an open reply began, from the segment it already wrote: its later
// segments are dated the same, whichever process writes them.
async function replyStartedAt(sessionKey: string, position: number): Promise<Date> {
  const [first] = await db
    .select({ createdAt: transcriptMessage.createdAt })
    .from(transcriptMessage)
    .where(
      and(
        eq(transcriptMessage.sessionKey, sessionKey),
        eq(transcriptMessage.position, position),
        eq(transcriptMessage.segment, 0),
      ),
    )
  return first?.createdAt ?? new Date()
}

function followedBy(first: IndexStep, second: IndexStep): IndexStep {
  return { rows: [...first.rows, ...second.rows], state: second.state, persist: first.persist || second.persist }
}

// The events a message can come from, as kind and text only -- never the rest
// of the event, where a question's attachments are described. A range can span
// a whole session, more than one SELECT can return, so it is read in bounded
// batches.
async function readTextEvents(sessionKey: string, from: number, before: number): Promise<RecordedEvent[]> {
  const events: RecordedEvent[] = []
  for await (const { position, kind, text, createdAt } of boundedSelect<{
    position: number
    kind: string
    text: string
    createdAt: Date
  }>(db, {
    from: agentSessionEvent,
    fields: {
      position: agentSessionEvent.position,
      kind: sql<string>`${agentSessionEvent.event}->>'kind'`,
      text: sql<string>`coalesce(${agentSessionEvent.event}->>'text', '')`,
      createdAt: agentSessionEvent.createdAt,
    },
    key: [agentSessionEvent.position],
    where: and(
      eq(agentSessionEvent.sessionKey, sessionKey),
      gte(agentSessionEvent.position, from),
      lt(agentSessionEvent.position, before),
      inArray(sql`${agentSessionEvent.event}->>'kind'`, ['user', 'agent_message', 'turn_end', 'error']),
    ),
  })) {
    events.push({ position, event: textEvent(kind, text), createdAt })
  }
  return events
}

function textEvent(kind: string, text: string): ChatEvent {
  switch (kind) {
    case 'user':
      return { kind: 'user', text }
    case 'agent_message':
      return { kind: 'agent_message', text }
    case 'turn_end':
      return { kind: 'turn_end', stopReason: '' }
    default:
      return { kind: 'error', message: '' }
  }
}

async function writeStep(sessionKey: string, step: IndexStep): Promise<void> {
  const { resumeFrom, turn, open } = step.state
  const cursor = { resumeFrom, turn, openPosition: open?.position ?? null, openSegment: open?.segment ?? 0 }
  await db.transaction(async (tx) => {
    if (step.rows.length > 0) {
      await tx
        .insert(transcriptMessage)
        .values(step.rows.map((row) => ({ sessionKey, ...row })))
        // Rows are cut deterministically from the same events, so one already
        // written is the same row: replaying past it changes nothing.
        .onConflictDoNothing()
    }
    await tx
      .insert(transcriptMessageCursor)
      .values({ sessionKey, ...cursor })
      .onConflictDoUpdate({ target: transcriptMessageCursor.sessionKey, set: cursor })
  })
}
