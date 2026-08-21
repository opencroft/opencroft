// This app's half of agent-client's durable queue.
//
// The engine holds the queue in memory and serves every read from there; this
// records what it is holding so a restart does not lose it. Nothing here is on
// the path a message takes to an agent — see QueueStore for why every call is
// made after the in-memory queue has already changed, and why a failure here
// costs durability rather than a message.

import { agentQueueEntry, db } from '@opencroft/db'
import type { QueueStore } from 'agent-client/agent-client'
import type { QueuedPrompt } from 'agent-client/types'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'

/**
 * Where a new row goes, without reading the queue first.
 *
 * `max+1` for an append and `min-1` for a front-insert, computed inside the
 * INSERT rather than fetched and incremented. Two sends arriving together
 * cannot then compute the same position from the same stale read — and neither
 * has to rewrite the rows already there, which is the write amplification a
 * table was chosen over a settings blob to avoid.
 *
 * An empty queue has no max or min, so both fall back to 0.
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
  if (row.kind === 'system') {
    return { id: row.id, kind: 'system', text: row.text }
  }
  if (row.kind === 'message') {
    return {
      id: row.id,
      kind: 'message',
      sender: row.sender ?? '',
      // Null only for rows written as system entries, which never reach here.
      sentAt: (row.sentAt ?? new Date(0)).toISOString(),
      text: row.text,
    }
  }
  console.error('[queue-store] ignoring queue row of unknown kind', row.kind, row.id)
  return null
}

export const queueStore: QueueStore = {
  async append(sessionKey, entry, placement) {
    await db.insert(agentQueueEntry).values({
      id: entry.id,
      sessionKey,
      kind: entry.kind,
      sender: entry.kind === 'message' ? entry.sender : null,
      text: entry.text,
      sentAt: entry.kind === 'message' ? new Date(entry.sentAt) : null,
      position: nextPosition(sessionKey, placement),
      createdAt: new Date(),
    })
  },

  async remove(sessionKey, entryIds) {
    if (entryIds.length === 0) {
      return
    }
    await db
      .delete(agentQueueEntry)
      .where(and(eq(agentQueueEntry.sessionKey, sessionKey), inArray(agentQueueEntry.id, entryIds)))
  },

  async clear(sessionKey) {
    await db.delete(agentQueueEntry).where(eq(agentQueueEntry.sessionKey, sessionKey))
  },

  async load(sessionKey) {
    const rows = await db
      .select()
      .from(agentQueueEntry)
      .where(eq(agentQueueEntry.sessionKey, sessionKey))
      .orderBy(asc(agentQueueEntry.position))
    return rows.map(toEntry).filter((entry): entry is QueuedPrompt => entry !== null)
  },
}
