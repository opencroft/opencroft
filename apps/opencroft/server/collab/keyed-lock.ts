/**
 * Runs the tasks given one key one after another, in the order they were
 * given; tasks for different keys run independently. A task that fails does
 * not hold up the next. `locks` holds the queue tails, so a caller that must
 * keep its queues across module reloads passes a map that survives them.
 */
export function keyedLock(locks: Map<string, Promise<unknown>> = new Map()) {
  return function withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const result = (locks.get(key) ?? Promise.resolve()).then(run, run)
    const tail = result.catch(() => undefined)
    locks.set(key, tail)
    void tail.then(() => {
      if (locks.get(key) === tail) {
        locks.delete(key)
      }
    })
    return result
  }
}
