// This app's half of agent-client's durable queue.
//
// The engine holds the queue in memory and serves every read from there; this
// records what it is holding so a restart does not lose it. Nothing here is on
// the path a message takes to an agent — see QueueStore for why every call is
// made after the in-memory queue has already changed, and why a failure here
// costs durability rather than a message.
//
// An entry's lifetime is two writes — record it, forget it — and this store
// makes the pair COMMUTATIVE per entry id: `remove` marks the row rather than
// deleting it, and `append` refuses to overwrite an id that already exists.
// Whichever of the two reaches the database last, a forgotten entry stays
// forgotten. The engine already promises to issue the pair in order (see
// QueueStore); this holds even if that ordering is ever lost on the way to
// disk, because a replayed message costs a reader an already-answered prompt
// where a resurrected one costs them a stale conversation days later.

import { agentQueueEntry, db } from '@opencroft/db'
import type { QueueStore } from 'agent-client/agent-client'
import type { DeliveredAttachment } from 'agent-client/attachments'
import type { QueuedPrompt } from 'agent-client/types'
import { and, asc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'

/**
 * How long a removed entry's marked row is kept before the sweep erases it.
 *
 * The mark exists to outlast any late `append` that could still name the same
 * id; those trail their `remove` by milliseconds, so a day is orders of
 * magnitude of margin while keeping the table no larger than a day's traffic.
 */
const REMOVED_ROW_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Where a new row goes, without reading the queue first.
 *
 * `max+1` for an append and `min-1` for a front-insert, computed inside the
 * INSERT rather than fetched and incremented. Two sends arriving together
 * cannot then compute the same position from the same stale read — and neither
 * has to rewrite the rows already there, which is the write amplification a
 * table was chosen over a settings blob to avoid.
 *
 * An empty queue has no max or min, so both fall back to 0. Removed rows are
 * deliberately left in the min/max: an extremum over a superset of the live
 * queue still brackets it, so the new row still sorts before (or after) every
 * waiting one, and the subquery stays a plain index walk.
 */
function nextPosition(sessionKey: string, placement: 'front' | 'end') {
  return placement === 'front'
    ? sql`(select coalesce(min(${agentQueueEntry.position}), 0) - 1 from ${agentQueueEntry} where ${agentQueueEntry.sessionKey} = ${sessionKey})`
    : sql`(select coalesce(max(${agentQueueEntry.position}), 0) + 1 from ${agentQueueEntry} where ${agentQueueEntry.sessionKey} = ${sessionKey})`
}

/**
 * Read a row back as the engine's own entry shape.
 *
 * A row whose `kind` is not one this version understands is skipped rather than
 * guessed at: it would have to be delivered as something, and delivering a
 * command as a message puts a tag in front of it — which stops it being a
 * command — while delivering a message as a command loses its author. Dropping
 * one message is the smaller and more visible failure of the three.
 */
function toEntry(row: typeof agentQueueEntry.$inferSelect): QueuedPrompt | null {
  // Written by `append` below from the engine's own list and read back only
  // here, so the column holds exactly that shape.
  const attachments = row.attachments ? { attachments: row.attachments as DeliveredAttachment[] } : {}
  if (row.kind === 'system') {
    return { id: row.id, kind: 'system', text: row.text, ...attachments }
  }
  if (row.kind === 'message' || row.kind === 'command') {
    return {
      id: row.id,
      kind: row.kind,
      sender: row.sender ?? '',
      // Null only for rows written as system entries, which never reach here.
      sentAt: (row.sentAt ?? new Date(0)).toISOString(),
      text: row.text,
      ...attachments,
    }
  }
  console.error('[queue-store] ignoring queue row of unknown kind', row.kind, row.id)
  return null
}

/**
 * Erase marked rows old enough that no late write could still name their id.
 *
 * Only rows with `removedAt` set are ever candidates — a waiting entry has
 * none, whatever its age, so a message held for days by a reading cadence is
 * structurally out of this delete's reach. Driven from `load` rather than a
 * scheduler: every session open runs one, which is as often as anything could
 * observe the difference.
 */
export async function sweepRemovedEntries(cutoff: Date): Promise<void> {
  await db
    .delete(agentQueueEntry)
    .where(and(isNotNull(agentQueueEntry.removedAt), lt(agentQueueEntry.removedAt, cutoff)))
}

/**
 * Carry everything filed under one session key onto another.
 *
 * A session key is derived from something renameable, so a rename re-mints it
 * and every row under the old one has to move with it. Left behind they are
 * unreachable for good: every later call addresses the new key, so they can
 * never be loaded, marked or cleared again — and a queue that was genuinely
 * waiting is silently dropped by the rename, which is a message somebody sent
 * that nobody will ever receive.
 *
 * An update rather than a copy: there is nothing to resolve under the old key
 * afterwards. Moving the row also carries its mark, so an entry that was
 * already forgotten stays forgotten across a rename.
 */
export async function moveQueueEntries(moves: readonly { from: string; to: string }[]): Promise<void> {
  for (const { from, to } of moves) {
    if (!from || !to || from === to) {
      continue
    }
    await db.update(agentQueueEntry).set({ sessionKey: to }).where(eq(agentQueueEntry.sessionKey, from))
  }
}

export const queueStore: QueueStore = {
  async append(sessionKey, entry, placement) {
    await db
      .insert(agentQueueEntry)
      .values({
        id: entry.id,
        sessionKey,
        kind: entry.kind,
        sender: entry.kind === 'system' ? null : entry.sender,
        text: entry.text,
        sentAt: entry.kind === 'system' ? null : new Date(entry.sentAt),
        position: nextPosition(sessionKey, placement),
        createdAt: new Date(),
        attachments: entry.attachments?.length ? entry.attachments : null,
      })
      // Idempotent per id, which is what makes the append/remove pair safe in
      // either order: if the id is already here — including as a row `remove`
      // marked first — this insert must not land a second, unmarked copy of a
      // message that has already left the queue.
      .onConflictDoNothing({ target: agentQueueEntry.id })
  },

  async remove(sessionKey, entryIds) {
    if (entryIds.length === 0) {
      return
    }
    const removedAt = new Date()
    // An upsert rather than a delete, so "forget this entry" holds whether or
    // not the entry's own write has landed yet: an existing row is marked
    // (whatever session key it sits under — the id says exactly which entry
    // was meant), and a missing one gets a bare marked row that blocks its
    // append from ever resurrecting it. The sweep erases the marks later.
    await db
      .insert(agentQueueEntry)
      .values(
        entryIds.map((id) => ({
          id,
          sessionKey,
          kind: 'tombstone',
          sender: null,
          text: '',
          sentAt: null,
          position: 0,
          createdAt: removedAt,
          removedAt,
        })),
      )
      .onConflictDoUpdate({ target: agentQueueEntry.id, set: { removedAt } })
  },

  async clear(sessionKey) {
    // The key is being retired for good (see the interface), so marked rows go
    // with it — nothing will ever load under this key again.
    await db.delete(agentQueueEntry).where(eq(agentQueueEntry.sessionKey, sessionKey))
  },

  async load(sessionKey) {
    const rows = await db
      .select()
      .from(agentQueueEntry)
      .where(and(eq(agentQueueEntry.sessionKey, sessionKey), isNull(agentQueueEntry.removedAt)))
      .orderBy(asc(agentQueueEntry.position))
    // After the read rather than before it, so an open never waits on
    // housekeeping. Not awaited for the same reason; a failed sweep only
    // leaves marked rows for the next one.
    void sweepRemovedEntries(new Date(Date.now() - REMOVED_ROW_TTL_MS)).catch((error) => {
      console.error('[queue-store] sweep of removed queue rows failed', error)
    })
    return rows.map(toEntry).filter((entry): entry is QueuedPrompt => entry !== null)
  },

  async pendingKeys() {
    // The same predicate `load` filters on, asked across every key instead of
    // one: a row still waiting is one never delivered and never withdrawn.
    // Marked rows are excluded for exactly the reason they are excluded there --
    // they are history, and a key whose queue is all history holds nothing.
    const rows = await db
      .selectDistinct({ sessionKey: agentQueueEntry.sessionKey })
      .from(agentQueueEntry)
      .where(isNull(agentQueueEntry.removedAt))
    return rows.map((row) => row.sessionKey)
  },
}
