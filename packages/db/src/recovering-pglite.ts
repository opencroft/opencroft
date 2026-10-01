// A PGlite client that survives its own WebAssembly runtime crashing.
//
// When PGlite's wasm traps — "memory access out of bounds" from a result too
// large for its heap, "unreachable", an emscripten `Aborted()` — the instance
// never recovers: every later call on it traps the same way, so a process
// holding it answers every request with an error until someone restarts it.
// The data directory is not what broke. A trap stops the faulting instruction
// before it touches memory, and a fresh PGlite opened on the same directory
// runs ordinary Postgres crash recovery: committed transactions are there, and
// the one the trap interrupted, which never committed, is rolled back.
//
// So the broken instance is abandoned and a new one is opened on the same
// directory behind the same client object. Nothing new is sent to the broken
// one; the only calls it still sees are the cleanup PGlite runs itself for the
// statement that crashed (a protocol Sync, a transaction's ROLLBACK), which
// trap at once. It is not closed: shutdown would run the crashed Postgres
// through a checkpoint, writing to the directory the new instance now owns.

import type { PGlite, QueryOptions, Results, Transaction } from '@electric-sql/pglite'

/**
 * The call that hit the crash. The database is being reopened and later calls
 * are served by the new instance, so retrying the request is safe.
 */
export class DatabaseCrashedError extends Error {
  override readonly name = 'DatabaseCrashedError'
  readonly code = 'DATABASE_CRASHED'
}

/** Longest statement text a crash log quotes, so a huge generated statement cannot flood the log. */
const LOGGED_SQL_MAX = 2_000

export interface RecoveringPGliteOptions {
  /** Opens a ready PGlite on the data directory. Called once at start and once per crash. */
  open: () => Promise<PGlite>
  /**
   * Called when opening a replacement fails. The database is unusable from
   * then on: every later call rejects with that failure. The reason is
   * already logged.
   */
  onReopenFailed: (error: unknown) => void
}

/**
 * The subset of the PGlite interface the drizzle PGlite driver calls:
 * `query`, `transaction`, plus `close`.
 *
 * Calls are serialised here rather than left to PGlite's own queue. PGlite
 * already runs one call at a time, so this costs no concurrency, and it is
 * what keeps calls that were waiting when the crash happened off the broken
 * instance: they start only after the replacement has been scheduled, and run
 * on it. Only the call that crashed fails.
 */
export class RecoveringPGlite {
  #current: Promise<PGlite>
  #tail: Promise<unknown> = Promise.resolve()
  readonly #open: () => Promise<PGlite>
  readonly #onReopenFailed: (error: unknown) => void

  constructor({ open, onReopenFailed }: RecoveringPGliteOptions) {
    this.#open = open
    this.#onReopenFailed = onReopenFailed
    this.#current = open()
  }

  query<T>(query: string, params?: unknown[], options?: QueryOptions): Promise<Results<T>> {
    return this.#serialised(async () => {
      const client = await this.#current
      try {
        return await client.query<T>(query, params, options)
      } catch (error) {
        throw this.#crashedOr(error, query)
      }
    })
  }

  transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.#serialised(async () => {
      const client = await this.#current
      // Noted where it happens: by the time the transaction ends, the error
      // in hand is PGlite's ROLLBACK or COMMIT trapping too, and the log would
      // name that instead of the statement that caused the crash.
      const noted: { crash?: { error: unknown; query: string } } = {}
      const guard = async <R>(query: string, run: () => Promise<R>): Promise<R> => {
        try {
          return await run()
        } catch (error) {
          if (isWasmTrap(error)) {
            // The first trap is the cause; any later statement traps only
            // because this one already broke the instance.
            noted.crash ??= { error, query }
          }
          throw error
        }
      }
      const settled = await client
        .transaction((tx) =>
          callback({
            query: (query, params, options) => guard(query, () => tx.query(query, params, options)),
            sql: (strings, ...params) => guard(strings.join('?'), () => tx.sql(strings, ...params)),
            exec: (query, options) => guard(query, () => tx.exec(query, options)),
            rollback: () => tx.rollback(),
            get closed() {
              return tx.closed
            },
          }),
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        )
      // With a crash noted, whatever ended the transaction — the trap itself,
      // or PGlite's COMMIT or ROLLBACK trapping after it — is the same crash.
      if (noted.crash) {
        throw this.#crashedOr(noted.crash.error, noted.crash.query)
      }
      if ('error' in settled) {
        throw this.#crashedOr(settled.error, 'BEGIN / COMMIT / ROLLBACK')
      }
      return settled.value
    })
  }

  /** Closes the instance in use, after every call already issued has finished. */
  close(): Promise<void> {
    return this.#serialised(async () => (await this.#current).close())
  }

  #serialised<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(run)
    this.#tail = result.catch(() => undefined)
    return result
  }

  /**
   * A wasm trap abandons the instance and schedules its replacement; the
   * caller gets a `DatabaseCrashedError`. Any other error is returned as it is.
   *
   * Called at most once per crash: the next serialised call is already on the
   * replacement, so no second call can reach the broken instance and report it.
   */
  #crashedOr(error: unknown, query: string): unknown {
    if (!isWasmTrap(error)) {
      return error
    }
    this.#replace(error, query)
    return new DatabaseCrashedError(
      `The embedded database crashed (${describe(error)}) and is being reopened; retry the request`,
      { cause: error },
    )
  }

  #replace(error: unknown, query: string): void {
    // The statement text and never its parameters: they are user data, and
    // the text alone is what finds the next oversized query.
    const statement = query.length > LOGGED_SQL_MAX ? `${query.slice(0, LOGGED_SQL_MAX)}…` : query
    console.error(
      `[db] The embedded PGlite database crashed (${describe(error)}) running: ${statement}\n` +
        '[db] Abandoning that instance and reopening the data directory.',
    )
    this.#current = this.#open().then(
      (client) => {
        console.error('[db] Reopened the embedded PGlite database after the crash.')
        return client
      },
      (reopenError: unknown) => {
        console.error('[db] Could not reopen the embedded PGlite database after the crash:', reopenError)
        this.#onReopenFailed(reopenError)
        throw reopenError
      },
    )
    // Every later call awaits this and sees the rejection; this only stops it
    // from also being reported as unhandled when no call is waiting.
    this.#current.catch(() => undefined)
  }
}

function isWasmTrap(error: unknown): error is WebAssembly.RuntimeError {
  return error instanceof WebAssembly.RuntimeError
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
