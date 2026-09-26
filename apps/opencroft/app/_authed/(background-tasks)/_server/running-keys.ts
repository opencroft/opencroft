// The keys of the sessions with a task of this host's still running — what
// makes such a session read as working rather than idle, in memory or not.
//
// Read on hot paths (every session-activity push, the audit page, the idle
// reaper), so answered from memory: filled from the registry once, lazily, and
// kept current by every start and ending this process records. Subscribers
// hear each change, so a pushed view of the keys needs no timer.

import type { InFlight } from './in-flight'

const LOAD_RETRY_MS = 60_000

export interface RunningKeysState {
  /** Each running task's session key, by task id. */
  byTask: Map<string, string | null>
  status: 'idle' | 'loading' | 'loaded'
  retryAt: number
  /** Tasks that ended while a load was in flight, which the load must not bring back. */
  endedMeanwhile: Set<string>
}

export function createRunningKeysState(): RunningKeysState {
  return { byTask: new Map(), status: 'idle', retryAt: 0, endedMeanwhile: new Set() }
}

export class RunningKeys {
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly state: RunningKeysState,
    private readonly deps: {
      load: () => Promise<{ taskId: string; sessionKey: string | null }[]>
      now: () => Date
      guard: InFlight
    },
  ) {}

  /**
   * Never throws and never waits. Until the registry has been read — or while
   * it cannot be, the table missing because the code arrived before its
   * migration — this answers from what this process started itself.
   */
  sessionKeys(): ReadonlySet<string> {
    const keys = new Set<string>()
    try {
      this.load()
      for (const key of this.state.byTask.values()) {
        if (key) {
          keys.add(key)
        }
      }
    } catch (error) {
      this.deps.guard.logOnce('keys', 'could not read the running tasks’ session keys', error)
    }
    return keys
  }

  /** Read the registry, unless it has been read, is being read, or failed a moment ago. */
  load(): void {
    const state = this.state
    if (state.status !== 'idle' || this.deps.now().getTime() < state.retryAt) {
      return
    }
    state.status = 'loading'
    state.endedMeanwhile.clear()
    // Through a `then`, so a load that throws before it returns a promise fails
    // the same way as one that rejects.
    void Promise.resolve()
      .then(() => this.deps.load())
      .then(
        (rows) => {
          for (const row of rows) {
            if (!state.endedMeanwhile.has(row.taskId)) {
              state.byTask.set(row.taskId, row.sessionKey)
            }
          }
          state.status = 'loaded'
          this.deps.guard.recovered('load')
          this.changed()
        },
        (error: unknown) => {
          state.status = 'idle'
          state.retryAt = this.deps.now().getTime() + LOAD_RETRY_MS
          this.deps.guard.logOnce(
            'load',
            'could not load the running background tasks; their sessions read idle until it can',
            error,
          )
        },
      )
  }

  track(taskId: string, sessionKey: string | undefined): void {
    this.state.byTask.set(taskId, sessionKey ?? null)
    this.changed()
  }

  untrack(taskId: string): void {
    this.state.byTask.delete(taskId)
    if (this.state.status === 'loading') {
      this.state.endedMeanwhile.add(taskId)
    }
    this.changed()
  }

  /** Called after every change to what sessionKeys() answers. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        this.deps.guard.logOnce('keys-listener', 'a running-keys listener threw', error)
      }
    }
  }
}
