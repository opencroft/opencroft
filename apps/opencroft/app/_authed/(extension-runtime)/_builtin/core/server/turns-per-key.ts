/** Runs `run` in its key's turn; see `turnsPerKey`. */
export type InTurn = <T>(key: string, run: () => Promise<T>) => Promise<T>

/**
 * A queue per key: each `run` starts once every run queued before it under the
 * same key has settled, whether it succeeded or failed. Runs under different
 * keys do not wait for each other. In-process only: two server processes are
 * not ordered against each other.
 */
export function turnsPerKey(): InTurn {
  const queued = new Map<string, Promise<void>>()
  return (key, run) => {
    const turn = (queued.get(key) ?? Promise.resolve()).then(run)
    const settled = turn.then(
      () => undefined,
      () => undefined,
    )
    queued.set(key, settled)
    void settled.then(() => {
      if (queued.get(key) === settled) {
        queued.delete(key)
      }
    })
    return turn
  }
}
