// The registry's durable half: one BackgroundTask row per task. The schema's
// own comment says why a row is addressed by session key and scoped by
// instance; this file only moves rows in and records out, and decides nothing.
//
// Every read is scoped to one instance. The one write that is not — finishing,
// marking delivered — is addressed by task id, which already names a single
// instance's row.

import { type BackgroundTask, backgroundTask, db } from '@opencroft/db'
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or } from 'drizzle-orm'

import type { BackgroundTaskKind, BackgroundTaskRecord, BackgroundTaskState } from './types'

export type TaskRow = BackgroundTask
export type NewTaskRow = typeof backgroundTask.$inferInsert

/** How a task ended: what finishing it writes, besides the time. */
export interface Ending {
  state: Exclude<BackgroundTaskState, 'running'>
  reason?: string
  exitCode?: number
  outputTail?: string
  /** Set with the ending when the caller already heard it some other way. */
  deliveredAt?: Date
}

export function toRecord(row: TaskRow): BackgroundTaskRecord {
  return {
    taskId: row.taskId,
    agent: row.agent,
    sessionKey: row.sessionKey ?? undefined,
    kind: row.kind as BackgroundTaskKind,
    name: row.name,
    target: row.target,
    summary: row.summary,
    state: row.state as BackgroundTaskState,
    reason: row.reason ?? undefined,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt ?? undefined,
    timeoutMs: row.timeoutMs,
    exitCode: row.exitCode ?? undefined,
    outputTail: row.outputTail ?? undefined,
    logPath: row.logPath ?? undefined,
    deliveredAt: row.deliveredAt ?? undefined,
  }
}

export async function insertTask(row: NewTaskRow): Promise<void> {
  await db.insert(backgroundTask).values(row)
}

export async function updateTask(
  taskId: string,
  fields: Pick<NewTaskRow, 'nodeDir' | 'pid' | 'logPath'>,
): Promise<void> {
  await db.update(backgroundTask).set(fields).where(eq(backgroundTask.taskId, taskId))
}

/**
 * Record how a task ended — only if it is still running. The condition is the
 * whole point: a cancel and a probe can both find the same task ending, and the
 * first to write decides; the other gets null and does nothing.
 */
export async function finishTask(taskId: string, ending: Ending, finishedAt: Date): Promise<TaskRow | null> {
  const [row] = await db
    .update(backgroundTask)
    .set({ ...ending, finishedAt })
    .where(and(eq(backgroundTask.taskId, taskId), eq(backgroundTask.state, 'running')))
    .returning()
  return row ?? null
}

export async function markDelivered(taskId: string, at: Date): Promise<void> {
  await db.update(backgroundTask).set({ deliveredAt: at }).where(eq(backgroundTask.taskId, taskId))
}

export async function getTask(instanceId: string, taskId: string): Promise<TaskRow | null> {
  const [row] = await db
    .select()
    .from(backgroundTask)
    .where(and(eq(backgroundTask.instanceId, instanceId), eq(backgroundTask.taskId, taskId)))
    .limit(1)
  return row ?? null
}

export async function runningTasks(instanceId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(backgroundTask)
    .where(and(eq(backgroundTask.instanceId, instanceId), eq(backgroundTask.state, 'running')))
    .orderBy(desc(backgroundTask.startedAt))
}

export async function tasksForSessionKey(instanceId: string, sessionKey: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(backgroundTask)
    .where(and(eq(backgroundTask.instanceId, instanceId), eq(backgroundTask.sessionKey, sessionKey)))
    .orderBy(desc(backgroundTask.startedAt))
}

export async function tasksForSessionId(instanceId: string, sessionId: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(backgroundTask)
    .where(and(eq(backgroundTask.instanceId, instanceId), eq(backgroundTask.sessionId, sessionId)))
    .orderBy(desc(backgroundTask.startedAt))
}

/** A caller's tasks started with no session to tell: an agent's own, or nobody's. */
export async function sessionlessTasks(instanceId: string, agent: string | null): Promise<TaskRow[]> {
  return db
    .select()
    .from(backgroundTask)
    .where(
      and(
        eq(backgroundTask.instanceId, instanceId),
        isNull(backgroundTask.sessionKey),
        agent === null ? isNull(backgroundTask.agent) : eq(backgroundTask.agent, agent),
      ),
    )
    .orderBy(desc(backgroundTask.startedAt))
}

/** Ended, not yet told, and not so long ago that telling has been given up. */
export async function owedTasks(instanceId: string, endedAfter: Date): Promise<TaskRow[]> {
  return db
    .select()
    .from(backgroundTask)
    .where(
      and(
        eq(backgroundTask.instanceId, instanceId),
        ne(backgroundTask.state, 'running'),
        isNull(backgroundTask.deliveredAt),
        gte(backgroundTask.finishedAt, endedAfter),
      ),
    )
}

/**
 * The tasks whose current state a session reopened under `sessionKey` may not
 * be showing: the running ones, and the ended ones it has not been told about.
 * One it has been told about was recorded into it with its final state when it
 * was told.
 */
export async function unsettledTasksForKey(instanceId: string, sessionKey: string): Promise<TaskRow[]> {
  return db
    .select()
    .from(backgroundTask)
    .where(
      and(
        eq(backgroundTask.instanceId, instanceId),
        eq(backgroundTask.sessionKey, sessionKey),
        or(eq(backgroundTask.state, 'running'), isNull(backgroundTask.deliveredAt)),
      ),
    )
    .orderBy(backgroundTask.startedAt)
}

/** Everything running, and whatever ended since `endedAfter`: newest first. */
export async function recentTasks(instanceId: string, endedAfter: Date, limit: number): Promise<TaskRow[]> {
  return db
    .select()
    .from(backgroundTask)
    .where(
      and(
        eq(backgroundTask.instanceId, instanceId),
        or(eq(backgroundTask.state, 'running'), gte(backgroundTask.finishedAt, endedAfter)),
      ),
    )
    .orderBy(desc(backgroundTask.startedAt))
    .limit(limit)
}

/**
 * Ended tasks whose directory is still on the node and no longer wanted: told
 * before `deliveredBefore`, or never told and ended before `endedBefore`.
 */
export async function removableDirs(
  instanceId: string,
  bounds: { deliveredBefore: Date; endedBefore: Date },
): Promise<TaskRow[]> {
  return db
    .select()
    .from(backgroundTask)
    .where(
      and(
        eq(backgroundTask.instanceId, instanceId),
        ne(backgroundTask.state, 'running'),
        isNotNull(backgroundTask.nodeDir),
        or(lt(backgroundTask.deliveredAt, bounds.deliveredBefore), lt(backgroundTask.finishedAt, bounds.endedBefore)),
      ),
    )
}

export async function clearNodeDirs(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) {
    return
  }
  await db.update(backgroundTask).set({ nodeDir: null }).where(inArray(backgroundTask.taskId, taskIds))
}

export async function deleteEndedBefore(instanceId: string, before: Date): Promise<void> {
  await db
    .delete(backgroundTask)
    .where(
      and(
        eq(backgroundTask.instanceId, instanceId),
        ne(backgroundTask.state, 'running'),
        lt(backgroundTask.finishedAt, before),
      ),
    )
}
