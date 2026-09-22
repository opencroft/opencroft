// Getting a task's news to its session: its current record into the session's
// chat while it runs, and its ending — the record, then the notification — once
// it is over. The words are notification.ts's.
//
// A session is found by key, because the key is what outlives a restart. One in
// memory is told at once; one that is not is resumed for it, the way the engine
// wakes a key with a waiting queue: resume or reuse, never create.

import type { HostTaskEngine } from './engine'
import type { InFlight } from './in-flight'
import { asyncTaskInfo, notificationText } from './notification'
import { markDelivered, toRecord, unsettledTasksForKey } from './store'
import type { BackgroundTaskRecord } from './types'

/** A key nothing could open a session for is not asked again for this long. */
const OPEN_RETRY_MS = 5 * 60_000

export interface DeliveryState {
  /** Tasks whose session took the notification: never told twice here, even if writing that down fails. */
  told: Set<string>
  /** When a key nothing could open a session for may be asked again. */
  openRetryAt: Map<string, number>
}

export function createDeliveryState(): DeliveryState {
  return { told: new Set(), openRetryAt: new Map() }
}

export interface DeliveryDeps {
  instanceId: () => string
  engine: () => Promise<HostTaskEngine>
  /** Resume or reuse the session a key belongs to — never create one. Null when nothing claims the key. */
  openSession: (sessionKey: string) => Promise<{ sessionId: string } | null>
  now: () => Date
  guard: InFlight
}

export class Delivery {
  constructor(
    private readonly state: DeliveryState,
    private readonly deps: DeliveryDeps,
  ) {}

  /**
   * Tell an ended task's session, and record that it was told. Never rejects:
   * what could not be done now stays owed, for a later tick.
   *
   * One delivery per task at a time. A notification held while delivery
   * sleeps stays pending until the instance wakes, and a second must not join
   * it.
   */
  deliver(record: BackgroundTaskRecord): Promise<void> {
    const key = `deliver:${record.taskId}`
    return this.deps.guard.once(key, async () => {
      try {
        await this.tell(record)
        this.deps.guard.recovered(key)
      } catch (error) {
        this.deps.guard.logOnce(key, `could not deliver background task ${record.taskId}`, error)
      }
    })
  }

  private async tell(record: BackgroundTaskRecord): Promise<void> {
    // No key: nobody to tell, and nothing more owed.
    if (record.sessionKey && !this.state.told.has(record.taskId)) {
      const sessionId = await this.sessionFor(record.sessionKey)
      if (!sessionId) {
        return
      }
      const engine = await this.deps.engine()
      engine.upsertAsyncTask(sessionId, asyncTaskInfo(record))
      if (!(await engine.notify(sessionId, notificationText(record)))) {
        // The session went away first. A later tick tries again — and may
        // repeat a notification that did go out, the better way to be wrong
        // than losing one.
        return
      }
      this.state.told.add(record.taskId)
    }
    await markDelivered(record.taskId, this.deps.now())
  }

  private async sessionFor(sessionKey: string): Promise<string | null> {
    const engine = await this.deps.engine()
    const live = engine.listSessions().find((session) => session.sessionKey === sessionKey)
    if (live) {
      return live.id
    }
    const now = this.deps.now().getTime()
    if (now < (this.state.openRetryAt.get(sessionKey) ?? 0)) {
      return null
    }
    this.state.openRetryAt.set(sessionKey, now + OPEN_RETRY_MS)
    const opened = await this.deps.openSession(sessionKey)
    if (opened) {
      this.state.openRetryAt.delete(sessionKey)
    }
    return opened?.sessionId ?? null
  }

  /** Put a task's current record into its session, when that session is in memory. Never rejects. */
  async show(record: BackgroundTaskRecord): Promise<void> {
    if (!record.sessionKey) {
      return
    }
    try {
      const engine = await this.deps.engine()
      const session = engine.listSessions().find((candidate) => candidate.sessionKey === record.sessionKey)
      if (session) {
        engine.upsertAsyncTask(session.id, asyncTaskInfo(record))
      }
    } catch (error) {
      this.deps.guard.logOnce(`show:${record.taskId}`, `could not show task ${record.taskId} in its session`, error)
    }
  }

  /**
   * Restate the current record of every task a reopened session may be showing
   * wrongly. A session restored from its recording comes back with each task as
   * last recorded — one that ended meanwhile still reads running, and keeps the
   * session working — and one reopened any other way comes back with none. The
   * running and the untold, then; a told task went in with its final state when
   * it was told. Never rejects: opening the session must not depend on this.
   */
  async sync(sessionKey: string, sessionId: string): Promise<void> {
    try {
      const rows = await unsettledTasksForKey(this.deps.instanceId(), sessionKey)
      if (rows.length === 0) {
        return
      }
      const engine = await this.deps.engine()
      for (const row of rows) {
        engine.upsertAsyncTask(sessionId, asyncTaskInfo(toRecord(row)))
      }
    } catch (error) {
      this.deps.guard.logOnce('sync', 'could not restate background tasks into a reopened session', error)
    }
  }
}
