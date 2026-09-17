// This app's durable copy of an agent session's transcript.
//
// The engine holds a session's events in memory and serves every read from
// there; this records them so reopening a conversation does not depend on the
// harness being able to replay it. Nothing here is on the path an event takes
// to a reader — the write happens after the event has already been emitted and
// fanned out, so a slow or broken store costs a transcript that has to fall
// back to the harness's replay, never a dropped frame in a live chat.
//
// The same shape as the durable queue next door (queue-store.ts), and for the
// same reason: the engine owns the behaviour, this owns the disk.
//
// ── Why the writes are batched ────────────────────────────────────────────
//
// A streaming turn emits an event per chunk — hundreds for one answer. Writing
// a row per chunk would put a database round-trip inside the stream's own
// callback, so events are collected and written in batches. What that costs is
// bounded and known: an unclean shutdown loses at most one unflushed batch off
// the end of a transcript, which is the tail of a turn that was still being
// written when the process stopped.

import { agentSessionEvent, db } from '@opencroft/db'
import type { ChatEvent } from 'agent-client/types'
import { and, asc, eq, lt, sql } from 'drizzle-orm'

/**
 * How many events one session keeps.
 *
 * A session that runs for weeks would otherwise grow this table without bound.
 * The cap is applied by position, oldest first, which can cut a turn in half —
 * accepted, because the chat already opens on a bounded tail and pages upwards,
 * and it renders a window that starts mid-turn using the same header mechanics
 * a "load older" page does. Generous enough that reaching it means a
 * conversation far longer than anything a reader scrolls back through.
 */
const MAX_EVENTS_PER_SESSION = 2000

/** Flush when this many events are waiting, whatever the timer says. */
const FLUSH_AT_EVENTS = 20

/** …and at the latest this long after the first event of a batch arrived. */
const FLUSH_AFTER_MS = 250

// Buffers and the write chain survive a dev hot-reload, so a reload mid-turn
// cannot strand a pending batch in a module instance nothing will flush again.
const globalRef = globalThis as typeof globalThis & {
  __agentSessionEventBuffers?: Map<string, ChatEvent[]>
  __agentSessionEventWrites?: Map<string, Promise<void>>
  __agentSessionEventPositions?: Map<string, number>
  __agentSessionEventTimer?: ReturnType<typeof setTimeout>
}
globalRef.__agentSessionEventBuffers ??= new Map()
globalRef.__agentSessionEventWrites ??= new Map()
globalRef.__agentSessionEventPositions ??= new Map()

const buffers = globalRef.__agentSessionEventBuffers
const writes = globalRef.__agentSessionEventWrites
/**
 * The next position to assign per key, once this process has established it.
 *
 * Read from the table the first time a key is written to and then kept, so an
 * append does not cost a `max(position)` query per batch. One process owns a
 * session at a time, so nothing else is allocating positions under the same
 * key while this holds one.
 */
const positions = globalRef.__agentSessionEventPositions

/**
 * Run a write for one key behind whatever is already queued for it.
 *
 * Same ordering rule, and the same reasoning, as the durable queue's `persist`:
 * batches for one session must land in the order they were issued, or a
 * transcript records a turn's events out of sequence. A failed batch is logged
 * and stepped over rather than allowed to wedge the ones behind it.
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
    .where(eq(agentSessionEvent.sessionKey, sessionKey))
  const next = (row?.max ?? -1) + 1
  positions.set(sessionKey, next)
  return next
}

async function writeBatch(sessionKey: string, batch: ChatEvent[]): Promise<void> {
  const start = await nextPosition(sessionKey)
  const createdAt = new Date()
  await db
    .insert(agentSessionEvent)
    .values(batch.map((event, offset) => ({ sessionKey, position: start + offset, event, createdAt })))
    // Idempotent on the (key, position) identity so a retried batch cannot
    // duplicate an event that already landed.
    .onConflictDoNothing()
  positions.set(sessionKey, start + batch.length)
  const cutoff = start + batch.length - MAX_EVENTS_PER_SESSION
  if (cutoff > 0) {
    await db
      .delete(agentSessionEvent)
      .where(and(eq(agentSessionEvent.sessionKey, sessionKey), lt(agentSessionEvent.position, cutoff)))
  }
}

function flushKey(sessionKey: string): Promise<void> {
  const batch = buffers.get(sessionKey)
  if (!batch || batch.length === 0) {
    return settled(sessionKey)
  }
  // Taken before the write is chained, so events arriving while it runs start
  // the next batch instead of being written twice.
  buffers.delete(sessionKey)
  return chain(sessionKey, () => writeBatch(sessionKey, batch))
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
 * Record one event. Buffered — see the note at the top of the file for what an
 * unclean shutdown costs.
 *
 * Never awaited by its caller and never able to throw into one: this sits on
 * the engine's emit path, where a rejection would reach a `catch {}` and a
 * delay would reach every reader of the stream.
 */
export function appendSessionEvent(sessionKey: string, event: ChatEvent): void {
  let batch = buffers.get(sessionKey)
  if (!batch) {
    batch = []
    buffers.set(sessionKey, batch)
  }
  batch.push(event)
  if (batch.length >= FLUSH_AT_EVENTS) {
    void flushKey(sessionKey)
    return
  }
  scheduleFlush()
}

/** Write every buffered event out now. */
export async function flushSessionEvents(): Promise<void> {
  await Promise.all([...buffers.keys()].map((sessionKey) => flushKey(sessionKey)))
}

/**
 * The transcript recorded under a key, oldest first.
 *
 * Flushes this key's own buffer first: a session reopened moments after it was
 * unloaded would otherwise come back missing the tail of its last turn, which
 * is the part a reader was looking at.
 */
export async function readSessionEvents(sessionKey: string): Promise<ChatEvent[]> {
  await flushKey(sessionKey)
  const rows = await db
    .select({ event: agentSessionEvent.event })
    .from(agentSessionEvent)
    .where(eq(agentSessionEvent.sessionKey, sessionKey))
    .orderBy(asc(agentSessionEvent.position))
  return rows.map((row) => row.event).filter(isChatEvent)
}

// A stored row is read straight back into the union it was written from, so
// the only thing worth checking is that it still looks like one at all — a row
// that does not is skipped rather than handed on as an event with no kind,
// which every consumer would switch on and silently ignore anyway.
function isChatEvent(value: unknown): value is ChatEvent {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string'
}

/**
 * Forget the transcript held under a key that is being retired for good.
 *
 * The host's call, exactly like the durable queue's `clear`: dropping a live
 * session also happens when a process is stopped and the conversation is meant
 * to survive, and clearing there would throw away the transcript this exists to
 * keep.
 */
export async function clearSessionEvents(sessionKey: string): Promise<void> {
  buffers.delete(sessionKey)
  await settled(sessionKey)
  await db.delete(agentSessionEvent).where(eq(agentSessionEvent.sessionKey, sessionKey))
  positions.delete(sessionKey)
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
    positions.delete(from)
    positions.delete(to)
  }
}
