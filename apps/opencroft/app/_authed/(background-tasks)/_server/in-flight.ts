// Work under way, and failures already reported — each by key.
//
// The poller starts the same work every tick: a probe of a node, the delivery
// of a task. A node can take the whole exec cap to answer and a notification
// stays pending for as long as delivery sleeps, so without this the next tick
// would start the same work again on top of itself. And a failure that repeats
// every tick is worth one line in the log, not one every ten seconds.
//
// The two sets are handed in rather than owned, so they can outlive a reload
// of this code: what is in flight belongs to the process.
export class InFlight {
  constructor(
    private readonly running: Set<string>,
    private readonly reported: Set<string>,
  ) {}

  has(key: string): boolean {
    return this.running.has(key)
  }

  /** Run `work` unless the same key's work is still going; settles when it is done, or at once when skipped. */
  async once(key: string, work: () => Promise<void>): Promise<void> {
    if (this.running.has(key)) {
      return
    }
    await this.hold(key, work)
  }

  /** Run `work` with `key` marked as going, whatever else holds it: work that must run, and must be seen running. */
  async hold<T>(key: string, work: () => Promise<T>): Promise<T> {
    this.running.add(key)
    try {
      return await work()
    } finally {
      this.running.delete(key)
    }
  }

  logOnce(key: string, message: string, error: unknown): void {
    if (this.reported.has(key)) {
      return
    }
    this.reported.add(key)
    console.error(`[background-tasks] ${message}`, error)
  }

  /** The thing `key` names works again: its next failure is news. */
  recovered(key: string): void {
    this.reported.delete(key)
  }
}
